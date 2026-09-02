import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeFile,
  filterHistory,
  parseHistory,
  upsertHistory,
} from "./file-history-utils.ts";

const entry = (overrides = {}) => ({
  transferId: "transfer-1",
  filename: "photo.png",
  mimeType: "image/png",
  size: 100,
  direction: "sent",
  status: "completed",
  timestamp: "2025-01-02T00:00:00.000Z",
  category: "Images",
  ...overrides,
});

test("categorizes MIME types and extensions locally", () => {
  assert.equal(categorizeFile("clip.mp4", "application/octet-stream"), "Videos");
  assert.equal(categorizeFile("report.pdf", "application/octet-stream"), "Documents");
  assert.equal(categorizeFile("archive.bin", "application/zip"), "Archives");
  assert.equal(categorizeFile("unknown.bin", "application/octet-stream"), "Other");
});

test("searches, combines filters, and sorts newest first", () => {
  const entries = [
    entry(),
    entry({ transferId: "transfer-2", filename: "Report.PDF", mimeType: "application/pdf", category: "Documents", direction: "received", status: "failed", timestamp: "2025-01-03T00:00:00.000Z" }),
  ];
  assert.deepEqual(filterHistory(entries, {
    search: "report",
    category: "Documents",
    direction: "received",
    status: "failed",
  }).map((item) => item.transferId), ["transfer-2"]);
  assert.deepEqual(filterHistory(entries, {
    search: "",
    category: "All",
    direction: "All",
    status: "All",
  }).map((item) => item.transferId), ["transfer-2", "transfer-1"]);
});

test("deduplicates history by transfer ID", () => {
  const updated = upsertHistory([entry()], entry({ filename: "renamed.png", timestamp: "2025-01-04T00:00:00.000Z" }));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].filename, "renamed.png");
});

test("drops corrupted history entries and preserves valid data", () => {
  const parsed = parseHistory([entry(), { transferId: "bad", filename: 42 }, entry()]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].transferId, "transfer-1");
  assert.deepEqual(parseHistory("not-an-array"), []);
});
