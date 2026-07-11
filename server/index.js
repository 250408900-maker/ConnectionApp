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

function generateCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += characters[Math.floor(Math.random() * characters.length)];
  }

  return code;
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

    if (session.guestId) {
      socket.emit("join-error", "Session is already full.");
      return;
    }

    session.guestId = socket.id;
    socket.join(cleanedCode);

    socket.emit("join-success", cleanedCode);
    io.to(cleanedCode).emit("session-connected", cleanedCode);

    console.log(`${socket.id} joined session ${cleanedCode}`);
  });

  socket.on("disconnect", () => {
    console.log("Device disconnected:", socket.id);

    for (const code of Object.keys(sessions)) {
      const session = sessions[code];

      if (
        session.hostId === socket.id ||
        session.guestId === socket.id
      ) {
        io.to(code).emit("session-ended");
        delete sessions[code];
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