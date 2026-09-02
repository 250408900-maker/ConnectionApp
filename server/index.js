const express = require("express");
const http = require("http");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const {
  credentials,
  createSession,
  matchesParticipant,
  markOffline: markParticipantOffline,
} = require("./session-manager");
const {
  acceptChunk,
  cancelTransfer,
  createTransfer,
  validateMetadata,
} = require("./transfer-manager");

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
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (value) => characters[value % characters.length]).join("");
}

function validToken(participant, participantId, reconnectToken) {
  return matchesParticipant(participant, participantId, reconnectToken);
}

function expireParticipant(code, role) {
  const session = sessions[code];
  if (!session) return;
  const participant = session[role];
  if (!participant || participant.online) return;
  participant.timer = null;
  const peer = session[role === "host" ? "guest" : "host"];
  if (peer && peer.online) io.to(peer.socketId).emit("peer-left");
  if (role === "host") endSession(code, "expired");
  else session.guest = null;
}

function markOffline(code, role) {
  const session = sessions[code];
  if (!session) return;
  markParticipantOffline(session, role, expireParticipant);
}

function endSession(code, reason) {
  const session = sessions[code];
  if (!session) return;

  if (session.host && session.host.timer) clearTimeout(session.host.timer);
  if (session.guest && session.guest.timer) clearTimeout(session.guest.timer);

  io.to(code).emit("session-ended", reason || "closed");
  if (session.transfers) session.transfers.clear();
  delete sessions[code];

  console.log(`Session ${code} ended (${reason || "closed"})`);
}

// Given a session and the socket id of whoever is calling, returns the id of
// the *other* device in that session (or null if there isn't one / it's not
// currently connected).
function getPeerSocketId(session, callerSocketId) {
  const peer = session.host.socketId === callerSocketId ? session.guest : session.host;
  return peer && peer.online ? peer.socketId : null;
}

function getRoleForSocket(session, socketId) {
  if (session.host.socketId === socketId) return "host";
  if (session.guest && session.guest.socketId === socketId) return "guest";
  return null;
}

io.on("connection", (socket) => {
  console.log("Device connected:", socket.id);

  socket.on("create-session", () => {
    let code = generateCode();

    while (sessions[code]) {
      code = generateCode();
    }

    sessions[code] = createSession(code, socket.id);
    sessions[code].transfers = new Map();

    socket.join(code);
    socket.emit("session-created", { sessionCode: code, ...credentials(sessions[code].host) });

    console.log(`${socket.id} created session ${code}`);
  });

  socket.on("join-session", (code) => {
    const cleanedCode = String(code).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) {
      socket.emit("join-error", "Session not found.");
      return;
    }

    if (session.host.socketId === socket.id) {
      socket.emit(
        "join-error",
        "You already created this session. Join from another device."
      );
      return;
    }

    if (session.guest && session.guest.online) {
      socket.emit("join-error", "Session is already full.");
      return;
    }

    session.guest = {
      ...createSession(cleanedCode, socket.id).host,
      role: "guest",
    };
    if (!session.transfers) session.transfers = new Map();
    socket.join(cleanedCode);

    socket.emit("join-success", { sessionCode: cleanedCode, ...credentials(session.guest) });
    io.to(cleanedCode).emit("session-connected", cleanedCode);

    console.log(`${socket.id} joined session ${cleanedCode}`);
  });

 // ---------- WebRTC Signaling ----------

socket.on("call-user", ({ sessionCode, offer }) => {
  const cleanedCode = String(sessionCode).trim().toUpperCase();
  const session = sessions[cleanedCode];

  if (!session) return;

  const peerId = getPeerSocketId(session, socket.id);
  if (!peerId) return;

  io.to(peerId).emit("incoming-call", { offer });
});

socket.on("call-accepted", ({ sessionCode, answer }) => {
  const cleanedCode = String(sessionCode).trim().toUpperCase();
  const session = sessions[cleanedCode];

  if (!session) return;

  const peerId = getPeerSocketId(session, socket.id);
  if (!peerId) return;

  io.to(peerId).emit("call-accepted", { answer });
});

socket.on("call-declined", ({ sessionCode }) => {
  const cleanedCode = String(sessionCode).trim().toUpperCase();
  const session = sessions[cleanedCode];

  if (!session) return;

  const peerId = getPeerSocketId(session, socket.id);
  if (!peerId) return;

  io.to(peerId).emit("call-declined");
});

socket.on("call-ice-candidate", ({ sessionCode, candidate }) => {
  const cleanedCode = String(sessionCode).trim().toUpperCase();
  const session = sessions[cleanedCode];

  if (!session) return;

  const peerId = getPeerSocketId(session, socket.id);
  if (!peerId) return;

  io.to(peerId).emit("call-ice-candidate", { candidate });
});

socket.on("call-ended", ({ sessionCode }) => {
  const cleanedCode = String(sessionCode).trim().toUpperCase();
  const session = sessions[cleanedCode];

  if (!session) return;

  const peerId = getPeerSocketId(session, socket.id);
  if (!peerId) return;

  io.to(peerId).emit("call-ended");
});

  socket.on("rejoin-session", ({ sessionCode, role, participantId, reconnectToken }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) {
      socket.emit("rejoin-error", "That channel is no longer available.");
      return;
    }

    const participant = session[role];
    if (!validToken(participant, participantId, reconnectToken)) {
      socket.emit("rejoin-error", "Invalid reconnect credentials.");
      return;
    }

    if (role === "host") {
      if (session.host.online) {
        socket.emit("rejoin-error", "Host slot already active.");
        return;
      }
      session.host.socketId = socket.id;
      session.host.online = true;
      if (session.host.timer) clearTimeout(session.host.timer);
      session.host.timer = null;
    } else if (role === "guest") {
      if (!session.guest) {
        socket.emit("rejoin-error", "Guest slot has expired.");
        return;
      }
      if (session.guest.online) {
        socket.emit("rejoin-error", "Guest slot already active.");
        return;
      }
      session.guest.socketId = socket.id;
      session.guest.online = true;
      if (session.guest.timer) clearTimeout(session.guest.timer);
      session.guest.timer = null;
    } else {
      socket.emit("rejoin-error", "Invalid role.");
      return;
    }

    socket.join(cleanedCode);
    socket.emit("rejoin-success", {
      sessionCode: cleanedCode,
      peerOnline: role === "host" ? Boolean(session.guest && session.guest.online) : session.host.online,
    });
    socket.to(cleanedCode).emit("peer-reconnected");

    console.log(`${socket.id} rejoined session ${cleanedCode} as ${role}`);
  });

  socket.on("end-session", ({ sessionCode }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) return;

    const belongsToSession = getRoleForSocket(session, socket.id) !== null;

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

    const belongsToSession = getRoleForSocket(session, socket.id) !== null;

    if (!belongsToSession) {
      ack({ ok: false, messageId, error: "You are not part of this session." });
      return;
    }

    const role = getRoleForSocket(session, socket.id);
    const peerOnline = role === "host" ? Boolean(session.guest && session.guest.online) : session.host.online;

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

    const belongsToSession = getRoleForSocket(session, socket.id) !== null;

    if (!belongsToSession) return;

    socket.to(cleanedCode).emit("peer-typing");
  });

  socket.on("stop-typing", ({ sessionCode }) => {
    const cleanedCode = String(sessionCode).trim().toUpperCase();
    const session = sessions[cleanedCode];

    if (!session) return;

    const belongsToSession = getRoleForSocket(session, socket.id) !== null;

    if (!belongsToSession) return;

    socket.to(cleanedCode).emit("peer-stop-typing");
  });

  // --- File transfer relay ---
  // Mirrors the send-message pattern: validate the caller belongs to the
  // session, then forward the event to the other device untouched. Chunks
  // get acked back to the *sender* only after the *receiver* has actually
  // acked them, so the client's chunk-by-chunk backpressure/progress logic
  // reflects real delivery, not just "the server accepted it."

  socket.on(
    "file-transfer-start",
    (
      {
        sessionCode,
        transferId,
        name,
        size,
        mimeType,
        totalChunks,
        kind,
        durationMs,
      },
      callback
    ) => {
      const ack = typeof callback === "function" ? callback : () => {};
      const cleanedCode = String(sessionCode).trim().toUpperCase();
      const session = sessions[cleanedCode];
      const validMetadata = validateMetadata({ transferId, name, size, mimeType, totalChunks });
      if (!validMetadata || getRoleForSocket(session, socket.id) === null) {
        ack({ ok: false, error: "Invalid transfer metadata or session." });
        return;
      }
      if (session.transfers.has(transferId)) {
        ack({ ok: false, error: "Transfer already exists." });
        return;
      }

      const role = getRoleForSocket(session, socket.id);
      const peerOnline = role === "host" ? Boolean(session.guest && session.guest.online) : session.host.online;
      if (!peerOnline) {
        ack({ ok: false, error: "Peer is offline." });
        return;
      }
      session.transfers.set(transferId, createTransfer(socket.id, getPeerSocketId(session, socket.id), { totalChunks }));

      socket
  .to(cleanedCode)
  .emit("file-transfer-start", {
    transferId,
    fileName: name.trim(),
    fileSize: size,
    mimeType,
    totalChunks,
    kind,
    durationMs,
  });
  ack({ ok: true });
    }
  );

  socket.on(
    "file-transfer-chunk",
    ({ sessionCode, transferId, index, data }, callback) => {
      const cleanedCode = String(sessionCode).trim().toUpperCase();
      const session = sessions[cleanedCode];
      const ack = typeof callback === "function" ? callback : () => {};

      if (!session) {
        ack({ ok: false });
        return;
      }
      const transfer = session.transfers.get(transferId);
      if (!transfer || transfer.senderSocketId !== socket.id) {
        ack({ ok: false, error: "Unauthorized transfer." });
        return;
      }
      const chunkResult = acceptChunk(transfer, index, data);
      if (!chunkResult.ok) {
        ack(chunkResult);
        return;
      }
      if (chunkResult.duplicate) {
        ack({ ok: true, duplicate: true, index });
        return;
      }
      const belongsToSession = getRoleForSocket(session, socket.id) !== null;
      if (!belongsToSession) {
        ack({ ok: false });
        return;
      }

      const peerId = getPeerSocketId(session, socket.id);
      const peerSocket = peerId ? io.sockets.sockets.get(peerId) : null;

      if (!peerSocket) {
        ack({ ok: false });
        return;
      }

      // Direct socket-to-socket emit (not a room broadcast) so we can use a
      // real acknowledgement callback: room/broadcast emits in socket.io
      // don't support acks the way a single socket.emit(event, data, cb) does.
      peerSocket.emit("file-transfer-chunk", { transferId, chunkIndex: index, data }, (peerAck) => {
        if (peerAck && peerAck.ok) {
          ack({ ok: true, index });
        } else {
          transfer.nextIndex -= 1;
          ack({ ok: false, error: "Receiver rejected chunk." });
        }
      });
    }
  );

  socket.on(
    "file-transfer-end",
    ({ sessionCode, transferId }, callback) => {
      const cleanedCode = String(sessionCode).trim().toUpperCase();
      const session = sessions[cleanedCode];
      const ack = typeof callback === "function" ? callback : () => {};
  
      if (!session) {
        ack({ ok: false, error: "Session not found" });
        return;
      }
  
      const transfer = session.transfers.get(transferId);
      const belongsToSession = getRoleForSocket(session, socket.id) !== null;
  
      if (!belongsToSession) {
        ack({ ok: false, error: "Not part of this session" });
        return;
      }
      if (!transfer || transfer.senderSocketId !== socket.id || transfer.nextIndex !== transfer.totalChunks) {
        ack({ ok: false, error: "Transfer is incomplete." });
        return;
      }

      socket.to(cleanedCode).emit("file-transfer-end", { transferId });
      session.transfers.delete(transferId);
  
      ack({ ok: true });
  
      console.log(
        `File transfer finished in ${cleanedCode}: ${transferId}`
      );
    }

);

  socket.on("file-transfer-cancel", ({ sessionCode, transferId }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const session = sessions[String(sessionCode).trim().toUpperCase()];
    if (!session || !cancelTransfer(session.transfers, transferId, socket.id)) {
      ack({ ok: false, error: "Unauthorized transfer." });
      return;
    }
    socket.to(String(sessionCode).trim().toUpperCase()).emit("file-transfer-cancelled", { transferId });
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Device disconnected:", socket.id);

    for (const code of Object.keys(sessions)) {
      const session = sessions[code];

      if (session.host.socketId === socket.id && session.host.online) {
        markOffline(code, "host");

        if (!session.guest) {
          // No one ever joined — just clean up immediately.
          endSession(code, "closed");
          break;
        }

        socket.to(code).emit("peer-offline");
        break;
      }

      if (session.guest && session.guest.socketId === socket.id && session.guest.online) {
        markOffline(code, "guest");
        socket.to(code).emit("peer-offline");
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