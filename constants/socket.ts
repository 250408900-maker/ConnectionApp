import { io } from "socket.io-client";

export const SERVER_URL = "http://130.61.28.42:3000";

export const socket = io(SERVER_URL, {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});