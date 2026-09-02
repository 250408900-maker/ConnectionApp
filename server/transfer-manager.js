const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_CHARS = 64000;

function validateMetadata(metadata) {
  return Boolean(
    metadata &&
      typeof metadata.transferId === "string" &&
      metadata.transferId.length > 0 &&
      metadata.transferId.length <= 128 &&
      typeof metadata.name === "string" &&
      metadata.name.trim().length > 0 &&
      metadata.name.length <= 255 &&
      Number.isInteger(metadata.size) &&
      metadata.size >= 0 &&
      metadata.size <= MAX_FILE_BYTES &&
      typeof metadata.mimeType === "string" &&
      metadata.mimeType.length <= 127 &&
      Number.isInteger(metadata.totalChunks) &&
      metadata.totalChunks >= 1 &&
      metadata.totalChunks <= Math.ceil((MAX_FILE_BYTES * 4 / 3) / MAX_CHUNK_CHARS) + 1
  );
}

function createTransfer(senderSocketId, recipientSocketId, metadata) {
  return { senderSocketId, recipientSocketId, totalChunks: metadata.totalChunks, nextIndex: 0 };
}

function acceptChunk(transfer, index, data) {
  if (!transfer || !Number.isInteger(index) || typeof data !== "string" ||
      data.length === 0 || data.length > MAX_CHUNK_CHARS) {
    return { ok: false, error: "Invalid chunk." };
  }
  if (index < transfer.nextIndex) return { ok: true, duplicate: true };
  if (index !== transfer.nextIndex) return { ok: false, error: "Out-of-order chunk." };
  transfer.nextIndex += 1;
  return { ok: true };
}

function cancelTransfer(transfers, transferId, socketId) {
  const transfer = transfers.get(transferId);
  if (!transfer || (transfer.senderSocketId !== socketId && transfer.recipientSocketId !== socketId)) return false;
  transfers.delete(transferId);
  return true;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_CHUNK_CHARS,
  acceptChunk,
  cancelTransfer,
  createTransfer,
  validateMetadata,
};
