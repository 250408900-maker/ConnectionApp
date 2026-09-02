import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export {
  categorizeFile,
  filterHistory,
  formatHistorySize,
  parseHistory,
  upsertHistory,
} from "./file-history-utils";
export type {
  FileCategory,
  FileDirection,
  FileHistoryEntry,
  FileHistoryFilters,
  FileHistoryStatus,
} from "./file-history-utils";
import {
  categorizeFile,
  parseHistory,
  upsertHistory,
  type FileCategory,
  type FileHistoryEntry,
} from "./file-history-utils";

const STORAGE_KEY = "connectionapp.file-history";
const STORAGE_FILE = `${FileSystem.documentDirectory ?? ""}file-history.json`;

export async function loadFileHistory(): Promise<FileHistoryEntry[]> {
  try {
    if (Platform.OS === "web") {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? parseHistory(JSON.parse(raw)) : [];
    }
    if (!FileSystem.documentDirectory) return [];
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    return info.exists ? parseHistory(JSON.parse(await FileSystem.readAsStringAsync(STORAGE_FILE))) : [];
  } catch {
    if (Platform.OS === "web") globalThis.localStorage?.removeItem(STORAGE_KEY);
    else if (FileSystem.documentDirectory) await FileSystem.deleteAsync(STORAGE_FILE, { idempotent: true });
    return [];
  }
}

export async function persistFileHistory(entries: FileHistoryEntry[]): Promise<void> {
  const data = JSON.stringify(parseHistory(entries));
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(STORAGE_KEY, data);
    return;
  }
  if (FileSystem.documentDirectory) await FileSystem.writeAsStringAsync(STORAGE_FILE, data);
}

let history: FileHistoryEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export async function initializeFileHistory() {
  history = await loadFileHistory();
  notify();
}

export function addFileHistory(entry: Omit<FileHistoryEntry, "category"> & { category?: FileCategory }) {
  history = upsertHistory(history, {
    ...entry,
    category: entry.category ?? categorizeFile(entry.filename, entry.mimeType),
  });
  void persistFileHistory(history);
  notify();
}

export function clearFileHistory() {
  history = [];
  void persistFileHistory(history);
  notify();
}

export function useFileHistory() {
  const [entries, setEntries] = useState(history);
  useEffect(() => {
    const listener = () => setEntries([...history]);
    listeners.add(listener);
    void initializeFileHistory();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return entries;
}
