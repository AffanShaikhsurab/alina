import { describe, expect, it } from "vitest";
import {
  contextFraction,
  contextMeasuredBeforeCompaction,
  contextTokensFromUsage,
  formatTokenCount,
} from "./context-usage.js";

describe("contextTokensFromUsage", () => {
  it("adds cache buckets to input and carries the visible reply", () => {
    expect(
      contextTokensFromUsage({
        inputTokens: 1_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 2_000,
        outputTokens: 900,
        reasoningTokens: 400,
      }),
    ).toBe(33_500);
  });

  it("falls back to the total when no prompt bucket was reported", () => {
    expect(contextTokensFromUsage({ inputTokens: null, outputTokens: null, totalTokens: 12 })).toBe(
      12,
    );
    expect(contextTokensFromUsage({ inputTokens: null, outputTokens: null })).toBeNull();
  });

  it("ignores negative or non-finite counts", () => {
    expect(
      contextTokensFromUsage({ inputTokens: 10, outputTokens: -5, cacheReadTokens: Number.NaN }),
    ).toBe(10);
  });
});

describe("contextFraction", () => {
  it("is the used share of the window, clamped", () => {
    expect(contextFraction(50_000, 200_000)).toBe(0.25);
    expect(contextFraction(300_000, 200_000)).toBe(1);
  });

  it("is unknown without both sides", () => {
    expect(contextFraction(null, 200_000)).toBeNull();
    expect(contextFraction(10, null)).toBeNull();
    expect(contextFraction(10, 0)).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it.each([
    [950, "950"],
    [4_200, "4.2K"],
    [1_000, "1K"],
    [42_300, "42K"],
    [200_000, "200K"],
    [999_950, "1M"],
    [1_048_576, "1M"],
    [2_500_000, "2.5M"],
  ])("formats %d as %s", (tokens, label) => {
    expect(formatTokenCount(tokens)).toBe(label);
  });
});

describe("contextMeasuredBeforeCompaction", () => {
  it("is true only when the summary changed after the measurement", () => {
    expect(
      contextMeasuredBeforeCompaction({
        measuredAt: "2026-01-01T10:00:00.000Z",
        compactedAt: "2026-01-01T10:05:00.000Z",
      }),
    ).toBe(true);
    expect(
      contextMeasuredBeforeCompaction({
        measuredAt: "2026-01-01T10:10:00.000Z",
        compactedAt: "2026-01-01T10:05:00.000Z",
      }),
    ).toBe(false);
    expect(contextMeasuredBeforeCompaction({ measuredAt: null, compactedAt: "x" })).toBe(false);
  });
});
