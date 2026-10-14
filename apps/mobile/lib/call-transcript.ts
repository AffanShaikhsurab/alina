import * as SecureStore from "expo-secure-store";
import type { CallExchange, CallPhase } from "./call-session";

export const CALL_TRANSCRIPT_KEY = "rakazo.call-transcript";

export type CallTranscriptLine = {
  key: string;
  role: CallExchange["role"];
  text: string;
  /** Still forming: the caller is mid-sentence, or the bot is still writing its reply. */
  pending: boolean;
};

/** Both sides of the call in the order they spoke, then whatever is still forming. */
export function callTranscript(call: {
  phase: CallPhase;
  exchanges: CallExchange[];
  heard: string;
  draft: string;
}): CallTranscriptLine[] {
  const lines: CallTranscriptLine[] = call.exchanges.map((exchange, index) => ({
    key: `turn-${index + 1}`,
    role: exchange.role,
    text: exchange.text,
    pending: false,
  }));
  // Once a turn is sent `heard` repeats it, so it is only live while the caller talks.
  const heard = call.heard.trim();
  if (call.phase === "listening" && heard) {
    lines.push({ key: "heard", role: "user", text: heard, pending: true });
  }
  const draft = call.draft.trim();
  if (call.phase === "thinking" && draft) {
    lines.push({ key: "draft", role: "bot", text: draft, pending: true });
  }
  return lines;
}

/** Whether the caller left the transcript open on their last call. */
export async function loadTranscriptOpen(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_TRANSCRIPT_KEY)) === "1";
}

export async function saveTranscriptOpen(open: boolean): Promise<void> {
  if (open) await SecureStore.setItemAsync(CALL_TRANSCRIPT_KEY, "1");
  else await SecureStore.deleteItemAsync(CALL_TRANSCRIPT_KEY);
}
