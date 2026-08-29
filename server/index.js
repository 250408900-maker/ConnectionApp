const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const RECONNECT_GRACE_MS = 20000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CHUNK_CHARS = 80000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME_CHARS = 180;
const SESSION_CODE_RE = /^[A-Z0-9]{6}$/;
const ALLOWED_KINDS = new Set(["image", "file", "voice"]);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((value) => value.trim()),
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e6,
  pingTimeout: 20000,
  pingInterval: 25000,
});

const sessions = {};

function generateCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += characters[Math.floor(Math.random() * characters.length)];
  }
  return code;
}

function parseSessionCode(code) {
  const cleaned = String(code ?? "").trim().toUpperCase();
  return SESSION_CODE_RE.test(cleaned) ? cleaned : null;
}

function belongsToSession(session, socketId) {
  return session.hostId === socketId || session.guestId === socketId;
}

function getPeerSocketId(session, callerSocketId) {
  const peerId = session.hostId === callerSocketId ? session.guestId : session.hostId;
  return peerId || null;
}

function ackOf(callback) {
  return typeof callback === "function" ? callback : () => {};
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
    const cleanedCode = parseSessionCode(code);
    if (!cleanedCode) {
      socket.emit("join-error", "Enter a valid 6-character channel code.");
      return;
    }

    const session = sessions[cleanedCode];

    if (!session) {
      socket.emit("join-error", "Session not found.");
      return;
    }

    if (session.hostId === socket.id) {
      socket.emit("join-error", "You already created this session. Join from another device.");
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

  socket.on("call-user", ({ sessionCode, offer }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id) || !offer) return;
    const peerId = getPeerSocketId(session, socket.id);
    if (!peerId) return;
    io.to(peerId).emit("incoming-call", { offer });
  });

  socket.on("call-accepted", ({ sessionCode, answer }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id) || !answer) return;
    const peerId = getPeerSocketId(session, socket.id);
    if (!peerId) return;
    io.to(peerId).emit("call-accepted", { answer });
  });

  socket.on("call-declined", ({ sessionCode }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id)) return;
    const peerId = getPeerSocketId(session, socket.id);
    if (!peerId) return;
    io.to(peerId).emit("call-declined");
  });

  socket.on("call-ice-candidate", ({ sessionCode, candidate }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id) || !candidate) return;
    const peerId = getPeerSocketId(session, socket.id);
    if (!peerId) return;
    io.to(peerId).emit("call-ice-candidate", { candidate });
  });

  socket.on("call-ended", ({ sessionCode }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id)) return;
    const peerId = getPeerSocketId(session, socket.id);
    if (!peerId) return;
    io.to(peerId).emit("call-ended");
  });

  socket.on("rejoin-session", ({ sessionCode, role }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    if (!cleanedCode) {
      socket.emit("rejoin-error", "That channel is no longer available.");
      return;
    }

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
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id)) return;
    endSession(cleanedCode, "closed");
  });

  socket.on("send-message", ({ sessionCode, message, messageId }, callback) => {
    const ack = ackOf(callback);
    const cleanedCode = parseSessionCode(sessionCode);
    const cleanedMessage = String(message ?? "").trim();
    const session = cleanedCode ? sessions[cleanedCode] : null;

    if (!session) {
      ack({ ok: false, messageId, error: "Session not found." });
      return;
    }

    if (!cleanedMessage) {
      ack({ ok: false, messageId, error: "Message cannot be empty." });
      return;
    }

    if (cleanedMessage.length > MAX_MESSAGE_CHARS) {
      ack({ ok: false, messageId, error: "Message is too long." });
      return;
    }

    if (!belongsToSession(session, socket.id)) {
      ack({ ok: false, messageId, error: "You are not part of this session." });
      return;
    }

    const peerOnline = session.hostId === socket.id ? session.guestOnline : session.hostOnline;
    if (!peerOnline) {
      ack({ ok: false, messageId, error: "Peer is not connected." });
      return;
    }

    socket.to(cleanedCode).emit("receive-message", cleanedMessage);
    ack({ ok: true, messageId });
    console.log(`Message sent in ${cleanedCode} (${cleanedMessage.length} chars)`);
  });

  socket.on("typing", ({ sessionCode }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id)) return;
    socket.to(cleanedCode).emit("peer-typing");
  });

  socket.on("stop-typing", ({ sessionCode }) => {
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;
    if (!session || !belongsToSession(session, socket.id)) return;
    socket.to(cleanedCode).emit("peer-stop-typing");
  });

  socket.on(
    "file-transfer-start",
    ({ sessionCode, transferId, name, size, mimeType, totalChunks, kind, durationMs }, callback) => {
      const ack = ackOf(callback);
      const cleanedCode = parseSessionCode(sessionCode);
      const session = cleanedCode ? sessions[cleanedCode] : null;

      if (!session || !belongsToSession(session, socket.id)) {
        ack({ ok: false, error: "Session not found." });
        return;
      }

      const peerOnline = session.hostId === socket.id ? session.guestOnline : session.hostOnline;
      if (!peerOnline) {
        ack({ ok: false, error: "Peer is not connected." });
        return;
      }

      const fileName = String(name ?? "").slice(0, MAX_FILENAME_CHARS);
      const fileSize = Number(size);
      const chunks = Number(totalChunks);

      if (!transferId || !fileName || !Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_BYTES) {
        ack({ ok: false, error: "Invalid file." });
        return;
      }

      if (!Number.isInteger(chunks) || chunks < 1 || chunks > 2000) {
        ack({ ok: false, error: "Invalid transfer." });
        return;
      }

      if (kind && !ALLOWED_KINDS.has(kind)) {
        ack({ ok: false, error: "Invalid kind." });
        return;
      }

      socket.to(cleanedCode).emit("file-transfer-start", {
        transferId,
        fileName,
        fileSize,
        mimeType,
        totalChunks: chunks,
        kind,
        durationMs,
      });

      console.log(`File transfer started in ${cleanedCode}: "${fileName}" (${fileSize} bytes, ${chunks} chunks)`);
      ack({ ok: true });
    }
  );

  socket.on("file-transfer-chunk", ({ sessionCode, transferId, index, data }, callback) => {
    const ack = ackOf(callback);
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;

    if (!session || !belongsToSession(session, socket.id) || !transferId || typeof data !== "string") {
      ack({ ok: false });
      return;
    }

    if (data.length > MAX_CHUNK_CHARS) {
      ack({ ok: false });
      return;
    }

    if (!Number.isInteger(index) || index < 0) {
      ack({ ok: false });
      return;
    }

    const peerId = getPeerSocketId(session, socket.id);
    const peerSocket = peerId ? io.sockets.sockets.get(peerId) : null;
    if (!peerSocket) {
      ack({ ok: false });
      return;
    }

    peerSocket.emit("file-transfer-chunk", { transferId, index, data }, (peerAck) => {
      ack(peerAck && peerAck.ok ? { ok: true } : { ok: false });
    });
  });

  socket.on("file-transfer-end", ({ sessionCode, transferId }, callback) => {
    const ack = ackOf(callback);
    const cleanedCode = parseSessionCode(sessionCode);
    const session = cleanedCode ? sessions[cleanedCode] : null;

    if (!session) {
      ack({ ok: false, error: "Session not found" });
      return;
    }

    if (!belongsToSession(session, socket.id) || !transferId) {
      ack({ ok: false, error: "Not part of this session" });
      return;
    }

    socket.to(cleanedCode).emit("file-transfer-end", { transferId });
    ack({ ok: true });
    console.log(`File transfer finished in ${cleanedCode}: ${transferId}`);
  });

  socket.on("disconnect", () => {
    console.log("Device disconnected:", socket.id);

    for (const code of Object.keys(sessions)) {
      const session = sessions[code];

      if (session.hostId === socket.id && session.hostOnline) {
        session.hostOnline = false;

        if (!session.guestId) {
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

app.get("/health", (req, res) => {
  res.json({ ok: true, sessions: Object.keys(sessions).length });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
