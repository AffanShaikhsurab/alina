import type { CallPhase } from "./call-session";

const pad = (value: number) => String(value).padStart(2, "0");

/** The call's running time: 0:08, 12:40, then 1:02:03 past an hour. */
export function callClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A finished call's length in the thread: 00:21, 12:40, 1:02:03. */
export function voiceChatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  return total >= 3600
    ? callClock(total * 1000)
    : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * What the top of the call shows: the bot's face while it talks or the line is quiet, and the
 * activity dots while it listens or thinks. A muted call is not listening.
 */
export function callPresence(call: { phase: CallPhase; muted: boolean }): "avatar" | "dots" {
  if (call.phase === "thinking") return "dots";
  if (call.phase === "listening" && !call.muted) return "dots";
  return "avatar";
}
