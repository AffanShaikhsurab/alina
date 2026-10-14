import type { ModelCatalogEntry, ModelCredential, ThreadContext } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  botModelChoices,
  botModelKey,
  compactionReached,
  effectiveModel,
  modelChangeInput,
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
