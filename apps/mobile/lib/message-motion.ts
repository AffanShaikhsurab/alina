/** More new rows than this at once is a catch-up (reconnect, refresh), not a conversation. */
const MAX_ARRIVALS = 3;

/**
 * Keys of rows that just arrived at the newest end of a thread, in reading order (oldest
 * first), so only they animate in. Nothing animates on first load or when a thread is
 * swapped, older pages never animate, and a streaming reply's progress row turning into the
 * final message stays still.
 */
export function arrivingKeys(
  previous: readonly string[] | null,
  next: readonly string[],
): string[] {
  if (!previous?.length) return [];
  const known = new Set(previous);
  const lastKnown = next.reduce((last, key, index) => (known.has(key) ? index : last), -1);
  // Not one row in common: another thread or a reload, not an arrival.
  if (lastKnown < 0) return [];
  const fresh = next.slice(lastKnown + 1).filter((key) => !known.has(key));
  if (fresh.length > MAX_ARRIVALS) return [];
  const nextKeys = new Set(next);
  const progressSettled = previous.some((key) => key.startsWith("progress:") && !nextKeys.has(key));
  // The final message takes the progress row's place; only a new progress row may move.
  return progressSettled ? fresh.filter((key) => key.startsWith("progress:")) : fresh;
}
