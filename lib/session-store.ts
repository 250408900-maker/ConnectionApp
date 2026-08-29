import { useSyncExternalStore } from "react";

export type CallPhase = "idle" | "calling" | "ringing" | "connected";
export type SessionRole = "host" | "guest" | null;

export type SessionSnapshot = {
  connected: boolean;
  sessionCode: string | null;
  peerOnline: boolean;
  role: SessionRole;
  callState: CallPhase;
  messageCount: number;
  fileCount: number;
};

const empty: SessionSnapshot = {
  connected: false,
  sessionCode: null,
  peerOnline: false,
  role: null,
  callState: "idle",
  messageCount: 0,
  fileCount: 0,
};

let snapshot: SessionSnapshot = { ...empty };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getSessionSnapshot() {
  return snapshot;
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function patchSession(partial: Partial<SessionSnapshot>) {
  snapshot = { ...snapshot, ...partial };
  emit();
}

export function bumpMessageCount() {
  snapshot = { ...snapshot, messageCount: snapshot.messageCount + 1 };
  emit();
}

export function bumpFileCount() {
  snapshot = { ...snapshot, fileCount: snapshot.fileCount + 1 };
  emit();
}

export function resetChannelState() {
  snapshot = {
    ...snapshot,
    sessionCode: null,
    peerOnline: false,
    role: null,
    callState: "idle",
    messageCount: 0,
    fileCount: 0,
  };
  emit();
}

export function useSessionSnapshot() {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}
