import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_TRANSCRIPT_KEY,
  callTranscript,
  loadTranscriptOpen,
  saveTranscriptOpen,
} from "./call-transcript";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

const exchanges = [
  { role: "user" as const, text: "how is the deploy going" },
  { role: "bot" as const, text: "It is green." },
];

describe("call transcript", () => {
  it("lists both sides in the order they spoke", () => {
    expect(callTranscript({ phase: "speaking", exchanges, heard: "", draft: "" })).toEqual([
      { key: "turn-1", role: "user", text: "how is the deploy going", pending: false },
      { key: "turn-2", role: "bot", text: "It is green.", pending: false },
    ]);
  });

  it("adds the caller's words live while they are still talking", () => {
    const lines = callTranscript({
      phase: "listening",
      exchanges,
      heard: "and the tests",
      draft: "",
    });
    expect(lines.at(-1)).toEqual({
      key: "heard",
      role: "user",
      text: "and the tests",
      pending: true,
    });
  });

  it("does not repeat a sent turn as a live line", () => {
    const lines = callTranscript({
      phase: "thinking",
      exchanges,
      heard: "It is green.",
      draft: "",
    });
    expect(lines).toHaveLength(2);
  });

  it("shows the bot's reply forming while it thinks, and drops it once it is spoken", () => {
    const thinking = callTranscript({
      phase: "thinking",
      exchanges: exchanges.slice(0, 1),
      heard: "how is the deploy going",
      draft: "It is",
    });
    expect(thinking.at(-1)).toEqual({ key: "draft", role: "bot", text: "It is", pending: true });

    const speaking = callTranscript({ phase: "speaking", exchanges, heard: "", draft: "It is" });
    expect(speaking.map((line) => line.key)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("transcript preference", () => {
  beforeEach(() => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockClear();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
  });

  it("starts closed until the caller opens it", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await expect(loadTranscriptOpen()).resolves.toBe(false);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    await expect(loadTranscriptOpen()).resolves.toBe(true);
  });

  it("remembers opening and forgets closing", async () => {
    await saveTranscriptOpen(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(CALL_TRANSCRIPT_KEY, "1");
    await saveTranscriptOpen(false);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(CALL_TRANSCRIPT_KEY);
  });
});
