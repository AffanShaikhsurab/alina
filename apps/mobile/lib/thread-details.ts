import { File, Paths } from "expo-file-system";
import { useEffect, useSyncExternalStore } from "react";

/** What a chat draws inline besides the conversation itself. Kept per chat, on this device. */
export type ThreadDetails = {
  showSubagents: boolean;
  showToolSteps: boolean;
};

export const DEFAULT_THREAD_DETAILS: ThreadDetails = Object.freeze({
  showSubagents: true,
  showToolSteps: false,
});

type Stored = Record<string, Partial<ThreadDetails>>;

let stored: Stored = {};
let resolved = new Map<string, ThreadDetails>();
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function detailsFile(): File {
  return new File(Paths.document, "rakazo-thread-details.json");
}

function notify() {
  resolved = new Map();
  for (const listener of listeners) listener();
}

function normalize(value: unknown): Stored {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: Stored = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const details: Partial<ThreadDetails> = {};
    if (typeof record.showSubagents === "boolean") details.showSubagents = record.showSubagents;
    if (typeof record.showToolSteps === "boolean") details.showToolSteps = record.showToolSteps;
    next[key] = details;
  }
  return next;
}

export function loadThreadDetails(): Promise<void> {
  loading ??= (async () => {
    try {
      const file = detailsFile();
      if (file.exists) {
        const saved = normalize(JSON.parse(await file.text()));
        // A choice made before the file finished loading wins over the saved one.
        for (const [chatId, entry] of Object.entries(stored)) {
          saved[chatId] = { ...saved[chatId], ...entry };
        }
        stored = saved;
      }
    } catch {
      // Unreadable preferences fall back to the defaults.
    }
    notify();
  })();
  return loading;
}

/** The stored choice for a chat, as one stable object per change so renders can compare it. */
export function threadDetailsFor(chatId: string | undefined): ThreadDetails {
  if (!chatId) return DEFAULT_THREAD_DETAILS;
  const cached = resolved.get(chatId);
  if (cached) return cached;
  const entry = stored[chatId];
  const details = entry ? { ...DEFAULT_THREAD_DETAILS, ...entry } : DEFAULT_THREAD_DETAILS;
  resolved.set(chatId, details);
  return details;
}

export function setThreadDetail(chatId: string, patch: Partial<ThreadDetails>): Promise<void> {
  stored = { ...stored, [chatId]: { ...stored[chatId], ...patch } };
  // Paint the switch before the write lands; write only once other chats' choices are loaded.
  notify();
  return loadThreadDetails().then(() => {
    try {
      const file = detailsFile();
      if (!file.exists) file.create();
      file.write(JSON.stringify(stored));
    } catch {
      // Keep the in-memory choice when the file cannot be written.
    }
  });
}

export function subscribeThreadDetails(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadDetails(chatId: string | undefined): ThreadDetails {
  useEffect(() => {
    void loadThreadDetails();
  }, []);
  return useSyncExternalStore(
    subscribeThreadDetails,
    () => threadDetailsFor(chatId),
    () => threadDetailsFor(chatId),
  );
}
