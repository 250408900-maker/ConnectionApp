export type FileCategory = "Images" | "Videos" | "Audio" | "Documents" | "Archives" | "Other";
export type FileDirection = "sent" | "received";
export type FileHistoryStatus = "completed" | "failed" | "cancelled";

export type FileHistoryEntry = {
  transferId: string;
  filename: string;
  mimeType: string;
  size: number;
  direction: FileDirection;
  status: FileHistoryStatus;
  timestamp: string;
  category: FileCategory;
};

export type FileHistoryFilters = {
  search: string;
  category: FileCategory | "All";
  direction: FileDirection | "All";
  status: FileHistoryStatus | "All";
};

export function categorizeFile(filename: string, mimeType: string): FileCategory {
  const mime = mimeType.toLowerCase();
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(extension)) return "Images";
  if (mime.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi"].includes(extension)) return "Videos";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "aac"].includes(extension)) return "Audio";
  if (mime.includes("pdf") || mime.includes("document") || mime.includes("text") ||
      ["pdf", "doc", "docx", "txt", "rtf", "xls", "xlsx", "ppt", "pptx", "csv"].includes(extension)) return "Documents";
  if (mime.includes("zip") || mime.includes("compressed") ||
      ["zip", "rar", "7z", "tar", "gz"].includes(extension)) return "Archives";
  return "Other";
}

export function formatHistorySize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function upsertHistory(entries: FileHistoryEntry[], entry: FileHistoryEntry): FileHistoryEntry[] {
  return [entry, ...entries.filter((current) => current.transferId !== entry.transferId)]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export function filterHistory(entries: FileHistoryEntry[], filters: FileHistoryFilters): FileHistoryEntry[] {
  const search = filters.search.trim().toLowerCase();
  return entries
    .filter((entry) => !search || entry.filename.toLowerCase().includes(search))
    .filter((entry) => filters.category === "All" || entry.category === filters.category)
    .filter((entry) => filters.direction === "All" || entry.direction === filters.direction)
    .filter((entry) => filters.status === "All" || entry.status === filters.status)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function isHistoryEntry(value: unknown): value is FileHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.transferId === "string" && typeof item.filename === "string" &&
    typeof item.mimeType === "string" && typeof item.size === "number" && item.size >= 0 &&
    (item.direction === "sent" || item.direction === "received") &&
    (item.status === "completed" || item.status === "failed" || item.status === "cancelled") &&
    typeof item.timestamp === "string" &&
    ["Images", "Videos", "Audio", "Documents", "Archives", "Other"].includes(String(item.category));
}

export function parseHistory(value: unknown): FileHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isHistoryEntry).reduce<FileHistoryEntry[]>(
    (entries, entry) => upsertHistory(entries, entry),
    []
  );
}
