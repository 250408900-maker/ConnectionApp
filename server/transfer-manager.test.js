const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptChunk, cancelTransfer, createTransfer, validateMetadata } = require("./transfer-manager");

const metadata = {
  transferId: "transfer-1",
  name: "photo.jpg",
  size: 64000,
  mimeType: "image/jpeg",
  totalChunks: 2,
};

test("validates transfer metadata and rejects oversized files", () => {
  assert.equal(validateMetadata(metadata), true);
  assert.equal(validateMetadata({ ...metadata, size: 26 * 1024 * 1024 }), false);
  assert.equal(validateMetadata({ ...metadata, name: "" }), false);
});

test("acknowledges ordered chunks and ignores duplicates", () => {
  const transfer = createTransfer("sender", "receiver", metadata);
  assert.deepEqual(acceptChunk(transfer, 0, "a"), { ok: true });
  assert.deepEqual(acceptChunk(transfer, 0, "a"), { ok: true, duplicate: true });
  assert.deepEqual(acceptChunk(transfer, 1, "b"), { ok: true });
  assert.equal(transfer.nextIndex, 2);
});

test("rejects out-of-order and malformed chunks", () => {
  const transfer = createTransfer("sender", "receiver", metadata);
  assert.equal(acceptChunk(transfer, 1, "b").ok, false);
  assert.equal(acceptChunk(transfer, 0, "").ok, false);
});

test("only the sender can cancel and cancellation cleans state", () => {
  const transfers = new Map([["transfer-1", createTransfer("sender", "receiver", metadata)]]);
  assert.equal(cancelTransfer(transfers, "transfer-1", "other"), false);
  assert.equal(cancelTransfer(transfers, "transfer-1", "sender"), true);
  assert.equal(transfers.size, 0);
});

test("receiver cancellation is accepted and duplicate cancellation is harmless", () => {
  const transfers = new Map([["transfer-1", createTransfer("sender", "receiver", metadata)]]);
  assert.equal(cancelTransfer(transfers, "transfer-1", "receiver"), true);
  assert.equal(cancelTransfer(transfers, "transfer-1", "receiver"), false);
});
