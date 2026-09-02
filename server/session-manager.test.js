const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECONNECT_GRACE_MS,
  cancelGraceTimer,
  credentials,
  createSession,
  getParticipant,
  getPeer,
  matchesParticipant,
  markOffline,
} = require("./session-manager");

test("creates, joins, and reuses distinct participant credentials", () => {
  const session = createSession("ABC123", "host-socket");
  session.guest = {
    ...createSession("ignored", "guest-socket").host,
    role: "guest",
  };

  assert.equal(session.code, "ABC123");
  assert.notEqual(session.host.participantId, session.guest.participantId);
  assert.equal(getPeer(session, "host"), session.guest);
  assert.equal(getParticipant(session, "guest"), session.guest);
  assert.equal(matchesParticipant(session.host, session.host.participantId, session.host.reconnectToken), true);
});

test("allows reconnect within the grace period and cancels expiry", () => {
  const session = createSession("ABC123", "old-socket");
  let expired = false;
  markOffline(session, "host", () => {
    expired = true;
  });

  const host = getParticipant(session, "host");
  host.socketId = "new-socket";
  host.online = true;
  cancelGraceTimer(host);

  assert.equal(expired, false);
  assert.equal(host.socketId, "new-socket");
});

test("expires a disconnected participant after the grace period", async () => {
  const session = createSession("ABC123", "old-socket");
  let expired = false;
  markOffline(session, "host", () => {
    expired = true;
  });

  const host = getParticipant(session, "host");
  clearTimeout(host.timer);
  host.timer = setTimeout(() => {
    expired = true;
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(expired, true);
});

test("rejects invalid reconnect tokens and duplicate active connections", () => {
  const session = createSession("ABC123", "host-socket");
  const host = getParticipant(session, "host");

  assert.equal(matchesParticipant(host, host.participantId, "wrong-token"), false);
  assert.equal(host.online, true);
  assert.equal(host.socketId, "host-socket");
});

test("cleans up both participant timers", () => {
  const session = createSession("ABC123", "host-socket");
  session.guest = createSession("ignored", "guest-socket").host;
  markOffline(session, "host", () => {});
  markOffline(session, "guest", () => {});
  cancelGraceTimer(session.host);
  cancelGraceTimer(session.guest);
  assert.equal(session.host.timer, null);
  assert.equal(session.guest.timer, null);
});

test("public credentials include the reconnect token for client recovery", () => {
  const session = createSession("ABC123", "host-socket");
  const publicCredentials = credentials(session.host);
  assert.equal(publicCredentials.reconnectToken, session.host.reconnectToken);
});
