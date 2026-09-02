import { useEffect, useState } from "react";

export type SessionSnapshot = {
  connected: boolean;
  sessionCode: string | null;
  peerConnected: boolean;
};

const listeners = new Set<() => void>();

let snapshot: SessionSnapshot = {
  connected: false,
  sessionCode: null,
  peerConnected: false,
};

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
