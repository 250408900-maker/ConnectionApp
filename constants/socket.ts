import { io } from "socket.io-client";

import { patchSession } from "@/lib/session-store";

export const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "http://130.61.28.42:3000";

export const socket = io(SERVER_URL, {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 8000,
});

socket.on("connect", () => {
  patchSession({ connected: true });
});

socket.on("disconnect", () => {
  patchSession({ connected: false, peerOnline: false });
});

if (socket.connected) {
  patchSession({ connected: true });
}
