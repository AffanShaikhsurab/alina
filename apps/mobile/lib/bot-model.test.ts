import type { ModelCatalogEntry, ModelCredential, ThreadContext } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  botModelChoices,
  botModelKey,
  compactionReached,
  compactThread,
  effectiveModel,
  modelChangeInput,
  modelSwitchInput,
  thinkingLevelsFor,
} from "./bot-model";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-fixture",
    label: "Claude Fixture",
    billing: "",
    thinkingLevels: ["off", "low", "high"],
    contextWindow: 200_000,
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-small",
    label: "Claude Small",
    billing: "",
  },
];

const credentials: ModelCredential[] = [
  { id: "credential-1", provider: "anthropic", label: "Anthropic", hasKey: true, isDefault: true },
];

describe("botModelChoices", () => {
  it("lists the space default, then every connected model", () => {
    expect(
      botModelChoices({ selectedKey: "", defaultLabel: "Space default", catalog, credentials }),
    ).toEqual([
      { key: "", label: "Space default" },
      { key: "anthropic::claude-fixture", label: "Anthropic · Claude Fixture" },
      { key: "anthropic::claude-small", label: "Anthropic · Claude Small" },
    ]);
  });

  it("keeps a saved model that is no longer connected", () => {
    const choices = botModelChoices({
      selectedKey: "openai::gone-model",
      defaultLabel: "Space default",
      catalog,
      credentials,
    });
    expect(choices[1]).toEqual({ key: "openai::gone-model", label: "gone-model" });
  });
});

describe("botModelKey and effectiveModel", () => {
  it("follows the space default until the bot picks its own model", () => {
    const followsDefault = { modelProvider: null, modelId: null, thinkingLevel: null };
    expect(botModelKey(followsDefault, catalog)).toBe("");
    expect(effectiveModel("", { provider: "anthropic", modelId: "claude-small" })).toEqual({
      provider: "anthropic",
      modelId: "claude-small",
    });
    expect(effectiveModel("", { provider: null, modelId: null })).toBeNull();

    const own = { modelProvider: "anthropic", modelId: "claude-fixture", thinkingLevel: "high" };
    expect(botModelKey(own, catalog)).toBe("anthropic::claude-fixture");
    expect(effectiveModel("anthropic::claude-fixture", { provider: null, modelId: null })).toEqual({
      provider: "anthropic",
      modelId: "claude-fixture",
    });
  });
});

describe("thinkingLevelsFor", () => {
  it("offers the model's levels without off", () => {
    expect(
      thinkingLevelsFor({ provider: "anthropic", modelId: "claude-fixture" }, catalog, credentials),
    ).toEqual(["low", "high"]);
    expect(
      thinkingLevelsFor({ provider: "anthropic", modelId: "claude-small" }, catalog, credentials),
    ).toEqual([]);
    expect(thinkingLevelsFor(null, catalog, credentials)).toEqual([]);
  });
});

describe("modelChangeInput", () => {
  it("resets thinking when the model changes and clears the override for the default", () => {
    expect(modelChangeInput("bot-1", "anthropic::claude-small")).toEqual({
      botId: "bot-1",
      modelProvider: "anthropic",
      modelId: "claude-small",
      thinkingLevel: null,
    });
    expect(modelChangeInput("bot-1", "")).toEqual({
      botId: "bot-1",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
    });
  });
});

describe("modelSwitchInput", () => {
  it("keeps the thinking level only when the new model offers it", () => {
    expect(modelSwitchInput("bot-1", "anthropic::claude-fixture", "high", ["low", "high"])).toEqual(
      {
        botId: "bot-1",
        modelProvider: "anthropic",
        modelId: "claude-fixture",
        thinkingLevel: "high",
      },
    );
    expect(
      modelSwitchInput("bot-1", "anthropic::claude-small", "high", []).thinkingLevel,
    ).toBeNull();
    expect(modelSwitchInput("bot-1", "", null, ["low"]).thinkingLevel).toBeNull();
  });
});

describe("compactThread", () => {
  const context = (compactedThroughSeq: number | null): ThreadContext => ({
    provider: null,
    modelId: null,
    contextWindow: null,
    usedTokens: null,
    measuredAt: null,
    compactedAt: null,
    compactedThroughSeq,
    uncompactedMessages: 0,
  });
  const sleep = async () => {};

  it("reports nothing to compact without polling", async () => {
    const request = vi.fn(async () => ({ queued: false, throughSeq: null }));
    await expect(
      compactThread(request as never, "bot-1", { alive: () => true, sleep }),
    ).resolves.toBe("nothing");
    expect(request).toHaveBeenCalledOnce();
  });

  it("polls the context until the summary reaches the requested message", async () => {
    const seen: ThreadContext[] = [];
    const replies: unknown[] = [{ queued: true, throughSeq: 40 }, context(10), context(40)];
    const request = vi.fn(async () => replies.shift());
    await expect(
      compactThread(request as never, "bot-1", {
        alive: () => true,
        sleep,
        onContext: (next) => seen.push(next),
      }),
    ).resolves.toBe("done");
    expect(request).toHaveBeenNthCalledWith(1, "threads/compact", { botId: "bot-1" });
    expect(request).toHaveBeenNthCalledWith(2, "threads/context", { botId: "bot-1" });
    expect(seen.map((next) => next.compactedThroughSeq)).toEqual([10, 40]);
  });

  it("gives up after the wait and passes request errors through", async () => {
    let clock = 0;
    const request = vi.fn(async (path: string) =>
      path === "threads/compact" ? { queued: true, throughSeq: 5 } : context(1),
    );
    await expect(
      compactThread(request as never, "bot-1", {
        alive: () => true,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        pollMs: 1_000,
        waitMs: 3_000,
      }),
    ).resolves.toBe("timeout");

    const unsupported = vi.fn(async () => {
      throw new Error("Unknown procedure");
    });
    await expect(
      compactThread(unsupported as never, "bot-1", { alive: () => true, sleep }),
    ).rejects.toThrow("Unknown procedure");
  });
});

describe("compactionReached", () => {
  const context = (compactedThroughSeq: number | null): ThreadContext => ({
    provider: null,
    modelId: null,
    contextWindow: null,
    usedTokens: null,
    measuredAt: null,
    compactedAt: null,
    compactedThroughSeq,
    uncompactedMessages: 0,
  });

  it("waits until the summary covers the requested message", () => {
    expect(compactionReached(context(null), 0)).toBe(false);
    expect(compactionReached(context(39), 40)).toBe(false);
    expect(compactionReached(context(40), 40)).toBe(true);
    expect(compactionReached(null, 0)).toBe(false);
  });
});
