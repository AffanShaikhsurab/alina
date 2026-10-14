/** Token buckets one model call reports. Cache buckets add to input; reasoning is part of output. */
export interface ContextUsageTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}

function count(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * How much context one call held: the prompt it was sent plus the visible reply, which the next
 * prompt carries. Hidden reasoning is not carried forward. Null when the provider reported nothing.
 */
export function contextTokensFromUsage(usage: ContextUsageTokens): number | null {
  const prompt = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(count);
  if (prompt.every((value) => value === null)) return count(usage.totalTokens);
  const output = Math.max(
    0,
    (count(usage.outputTokens) ?? 0) - (count(usage.reasoningTokens) ?? 0),
  );
  return prompt.reduce<number>((sum, value) => sum + (value ?? 0), 0) + output;
}

/** Share of the window in use, clamped to 0..1; null when either side is unknown. */
export function contextFraction(
  usedTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): number | null {
  const used = count(usedTokens);
  const window = count(contextWindow);
  if (used === null || !window) return null;
  return Math.min(1, used / window);
}

/** Short token count for a narrow meter: 950, 4.2K, 42K, 1M. */
export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1000) return String(value);
  const scaled = (amount: number, suffix: string) =>
    `${amount.toFixed(amount < 10 ? 1 : 0).replace(/\.0$/, "")}${suffix}`;
  const thousands = value / 1000;
  if (Number(thousands.toFixed(thousands < 10 ? 1 : 0)) < 1000) return scaled(thousands, "K");
  return scaled(value / 1_000_000, "M");
}

/** The summary changed after the latest measurement, so the measurement overstates the context. */
export function contextMeasuredBeforeCompaction(context: {
  measuredAt: string | null;
  compactedAt: string | null;
}): boolean {
  if (!context.measuredAt || !context.compactedAt) return false;
  return Date.parse(context.compactedAt) > Date.parse(context.measuredAt);
}
