const crypto = require("node:crypto");

const RECONNECT_GRACE_MS = 20000;

function createParticipant(socketId, role) {
  return {
    participantId: crypto.randomUUID(),
    reconnectToken: crypto.randomBytes(32).toString("hex"),
    socketId,
    role,
    online: true,
    timer: null,
  };
}

function createSession(code, socketId) {
  return {
    code,
    host: createParticipant(socketId, "host"),
    guest: null,
  };
}

function getParticipant(session, role) {
  return role === "host" ? session.host : session.guest;
}

function getPeer(session, role) {
  return role === "host" ? session.guest : session.host;
}

function credentials(participant) {
  return {
    participantId: participant.participantId,
    reconnectToken: participant.reconnectToken,
    role: participant.role,
  };
}

function matchesParticipant(participant, participantId, reconnectToken) {
  if (typeof reconnectToken !== "string") return false;
  const expected = Buffer.from(participant?.reconnectToken || "");
  const actual = Buffer.from(reconnectToken);
  return Boolean(
    participant &&
      participant.participantId === participantId &&
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
  );
}

function markOffline(session, role, onExpired) {
  const participant = getParticipant(session, role);
  if (!participant || !participant.online) return false;

  participant.online = false;
  participant.socketId = null;
  if (participant.timer) clearTimeout(participant.timer);
  participant.timer = setTimeout(() => onExpired(session.code, role), RECONNECT_GRACE_MS);
  return true;
}

function cancelGraceTimer(participant) {
  if (participant && participant.timer) {
    clearTimeout(participant.timer);
    participant.timer = null;
  }
}

module.exports = {
  RECONNECT_GRACE_MS,
  cancelGraceTimer,
  credentials,
  createSession,
  getParticipant,
  getPeer,
  matchesParticipant,
  markOffline,
};
