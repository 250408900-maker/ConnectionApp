import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export type SessionSnapshot = {
  connected: boolean;
  sessionCode: string | null;
  peerConnected: boolean;
  participantId: string | null;
  reconnectToken: string | null;
  role: "host" | "guest" | null;
};

const listeners = new Set<() => void>();

let snapshot: SessionSnapshot = {
  connected: false,
  sessionCode: null,
  peerConnected: false,
  participantId: null,
  reconnectToken: null,
  role: null,
};

const STORAGE_KEY = "connectionapp.active-session";
const STORAGE_FILE = `${FileSystem.documentDirectory ?? ""}active-session.json`;

export type PersistedSession = {
  sessionCode: string;
  participantId: string;
  reconnectToken: string;
  role: "host" | "guest";
};

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionCode === "string" &&
    typeof candidate.participantId === "string" &&
    typeof candidate.reconnectToken === "string" &&
    (candidate.role === "host" || candidate.role === "guest")
  );
}

export async function loadPersistedSession(): Promise<PersistedSession | null> {
  if (Platform.OS === "web") {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isPersistedSession(parsed) ? parsed : null;
    } catch {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      return null;
    }
  }

  if (!FileSystem.documentDirectory) return null;
  const info = await FileSystem.getInfoAsync(STORAGE_FILE);
  if (!info.exists) return null;
  try {
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(STORAGE_FILE));
    return isPersistedSession(parsed) ? parsed : null;
  } catch {
    await FileSystem.deleteAsync(STORAGE_FILE, { idempotent: true });
    return null;
  }
}

export async function persistSession(session: PersistedSession | null) {
  if (Platform.OS === "web") {
    if (session) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
    return;
  }

  if (!FileSystem.documentDirectory) return;
  if (session) {
    await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(session));
  } else {
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    if (info.exists) await FileSystem.deleteAsync(STORAGE_FILE, { idempotent: true });
  }
}

export function getSharedSessionState(): SessionSnapshot {
  return snapshot;
}

export function subscribeSharedSessionState(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSharedSessionState(patch: Partial<SessionSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export function resetSharedSessionState() {
  snapshot = {
    connected: snapshot.connected,
    sessionCode: null,
    peerConnected: false,
    participantId: null,
    reconnectToken: null,
    role: null,
  };
  listeners.forEach((listener) => listener());
}

export function useSharedSessionState() {
  const [state, setState] = useState<SessionSnapshot>(snapshot);

  useEffect(() => {
    const unsubscribe = subscribeSharedSessionState(() => {
      setState({ ...snapshot });
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return state;
}
