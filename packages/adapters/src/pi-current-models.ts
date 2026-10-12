import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

/** Fill catalog gaps until the bundled provider library includes these releases. */
export function supplementPiModels(models: MutableModels): MutableModels {
  function add(
    providerId: string,
    baseId: string,
    overrides: Partial<Model<Api>> & { id: string },
  ) {
    if (models.getModel(providerId, overrides.id)) return;
    const provider = models.getProvider(providerId);
    const base = models.getModel(providerId, baseId);
    if (!provider || !base) throw new Error(`Missing model baseline: ${providerId}/${baseId}`);
    const model = { ...base, ...overrides };
    models.setProvider({ ...provider, getModels: () => [model, ...provider.getModels()] });
  }
  add("anthropic", "claude-sonnet-5", {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    },
  });
  const sol = models.getModel("openai-codex", "gpt-6-sol");
  add("openai-codex", "gpt-6-sol", {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    // Subscription transport keeps its own window; the account catalog may narrow it.
    contextWindow: sol?.contextWindow ?? 272000,
  });
  // LifeOS: Kimi K3 on Bedrock is reachable only through the US cross-region inference profile
  // (the bare model id fails on demand). Same Converse API and limits as the bundled Kimi K2.5.
  add("amazon-bedrock", "moonshotai.kimi-k2.5", {
    id: "us.moonshotai.kimi-k3",
    name: "Kimi K3 (US inference profile)",
    input: ["text"],
  });
  return models;
}
