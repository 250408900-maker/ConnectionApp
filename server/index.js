const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const sessions = {};
const RECONNECT_GRACE_MS = 20000;

function generateCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += characters[Math.floor(Math.random() * characters.length)];
  }

  return code;
}

function endSession(code, reason) {
  const session = sessions[code];
  if (!session) return;

  if (session.timers.host) clearTimeout(session.timers.host);
  if (session.timers.guest) clearTimeout(session.timers.guest);

  io.to(code).emit("session-ended", reason || "closed");
  delete sessions[code];

  console.log(`Session ${code} ended (${reason || "closed"})`);
}

io.on("connection", (socket) => {
  console.log("Device connected:", socket.id);

  socket.on("create-session", () => {
    let code = generateCode();

    while (sessions[code]) {
      code = generateCode();
    }

    sessions[code] = {
      hostId: socket.id,
      guestId: null,
      hostOnline: true,
      guestOnline: false,
      timers: { host: null, guest: null },
    };

    socket.join(code);
    socket.emit("session-created", code);

    console.log(`${socket.id} created session ${code}`);
  });

  socket.on("join-session", (code) => {
    const cleanedCode = String(code).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) {
      socket.emit("join-error", "Session not found.");
      return;
    }

    if (session.hostId === socket.id) {
      socket.emit(
        "join-error",
        "You already created this session. Join from another device."
      );
      return;
    }

    if (session.guestId && session.guestOnline) {
      socket.emit("join-error", "Session is already full.");
      return;
    }

    session.guestId = socket.id;
    session.guestOnline = true;
    socket.join(cleanedCode);

    socket.emit("join-success", cleanedCode);
    io.to(cleanedCode).emit("session-connected", cleanedCode);

    console.log(`${socket.id} joined session ${cleanedCode}`);
  });

  socket.on("rejoin-session", ({ sessionCode, role }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) {
      socket.emit("rejoin-error", "That channel is no longer available.");
      return;
    }

    if (role === "host") {
      if (session.hostOnline) {
        socket.emit("rejoin-error", "Host slot already active.");
        return;
      }
      session.hostId = socket.id;
      session.hostOnline = true;
      if (session.timers.host) {
        clearTimeout(session.timers.host);
        session.timers.host = null;
      }
    } else if (role === "guest") {
      if (session.guestOnline) {
        socket.emit("rejoin-error", "Guest slot already active.");
        return;
      }
      session.guestId = socket.id;
      session.guestOnline = true;
      if (session.timers.guest) {
        clearTimeout(session.timers.guest);
        session.timers.guest = null;
      }
    } else {
      socket.emit("rejoin-error", "Invalid role.");
      return;
    }

    socket.join(cleanedCode);
    socket.emit("rejoin-success", {
      sessionCode: cleanedCode,
      peerOnline: role === "host" ? session.guestOnline : session.hostOnline,
    });
    socket.to(cleanedCode).emit("peer-reconnected");

    console.log(`${socket.id} rejoined session ${cleanedCode} as ${role}`);
  });

  socket.on("end-session", ({ sessionCode }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) return;

    const belongsToSession =
      session.hostId === socket.id || session.guestId === socket.id;

    if (!belongsToSession) return;

    endSession(cleanedCode, "closed");
  });

  socket.on("send-message", ({ sessionCode, message, messageId }, callback) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const cleanedMessage = String(message).trim();
    const session = sessions[cleanedCode];
    const ack = typeof callback === "function" ? callback : () => {};

    if (!session) {
      ack({ ok: false, messageId, error: "Session not found." });
      return;
    }

    if (!cleanedMessage) {
      ack({ ok: false, messageId, error: "Message cannot be empty." });
      return;
    }

    const belongsToSession =
      session.hostId === socket.id || session.guestId === socket.id;

    if (!belongsToSession) {
      ack({ ok: false, messageId, error: "You are not part of this session." });
      return;
    }

    const peerOnline =
      session.hostId === socket.id ? session.guestOnline : session.hostOnline;

    if (!peerOnline) {
      ack({ ok: false, messageId, error: "Peer is not connected." });
      return;
    }

    socket.to(cleanedCode).emit("receive-message", cleanedMessage);
    ack({ ok: true, messageId });

    console.log(`Message sent in ${cleanedCode}: ${cleanedMessage}`);
  });

  socket.on("typing", ({ sessionCode }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) return;

    const belongsToSession =
      session.hostId === socket.id || session.guestId === socket.id;

    if (!belongsToSession) return;

    socket.to(cleanedCode).emit("peer-typing");
  });

  socket.on("stop-typing", ({ sessionCode }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) return;

    const belongsToSession =
      session.hostId === socket.id || session.guestId === socket.id;

    if (!belongsToSession) return;

    socket.to(cleanedCode).emit("peer-stop-typing");
  });

  socket.on("disconnect", () => {
    console.log("Device disconnected:", socket.id);

    for (const code of Object.keys(sessions)) {
      const session = sessions[code];

      if (session.hostId === socket.id && session.hostOnline) {
        session.hostOnline = false;

        if (!session.guestId) {
          // No one ever joined — just clean up immediately.
          endSession(code, "closed");
          break;
        }

        socket.to(code).emit("peer-offline");
        session.timers.host = setTimeout(() => {
          endSession(code, "timeout");
        }, RECONNECT_GRACE_MS);
        break;
      }

      if (session.guestId === socket.id && session.guestOnline) {
        session.guestOnline = false;

        socket.to(code).emit("peer-offline");
        session.timers.guest = setTimeout(() => {
          endSession(code, "timeout");
        }, RECONNECT_GRACE_MS);
        break;
      }
    }
  });
});

app.get("/", (req, res) => {
  res.send("ConnectionApp server is running.");
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});