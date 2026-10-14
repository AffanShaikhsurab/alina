import type {
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
  ThreadContext,
} from "@rakazo/contracts";
import {
  connectedModelChoices,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";

type BotModelFields = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export type ModelChoice = { key: string; label: string };

/** Picker key of the bot's own model; "" follows the space default. */
export function botModelKey(bot: BotModelFields, catalog: readonly ModelCatalogEntry[]): string {
  if (!bot.modelProvider || !bot.modelId) return "";
  return modelOptionKey(
    bot.modelProvider,
    resolveSelectableModelId(catalog, bot.modelProvider, bot.modelId),
  );
}

/** The space default first, then every connected model; a saved model that is gone stays listed. */
export function botModelChoices(options: {
  selectedKey: string;
  defaultLabel: string;
  catalog: readonly ModelCatalogEntry[];
  credentials: readonly ModelCredential[];
}): ModelChoice[] {
  const connected = connectedModelChoices(options.credentials, options.catalog);
  const choices: ModelChoice[] = [{ key: "", label: options.defaultLabel }];
  if (options.selectedKey && !connected.some((choice) => choice.key === options.selectedKey)) {
    choices.push({
      key: options.selectedKey,
      label: parseModelOptionKey(options.selectedKey)?.modelId ?? options.selectedKey,
    });
  }
  for (const choice of connected) choices.push({ key: choice.key, label: choice.label });
  return choices;
}

/** The model a key runs: the bot's own choice, or the space default for "". */
export function effectiveModel(
  key: string,
  spaceDefault: { provider: string | null; modelId: string | null },
): { provider: string; modelId: string } | null {
  const own = key ? parseModelOptionKey(key) : null;
  if (own) return own;
  return spaceDefault.provider && spaceDefault.modelId
    ? { provider: spaceDefault.provider, modelId: spaceDefault.modelId }
    : null;
}

/** Thinking levels the model offers, without "off" (the picker's default row covers it). */
export function thinkingLevelsFor(
  model: { provider: string; modelId: string } | null,
  catalog: readonly ModelCatalogEntry[],
  credentials: readonly ModelCredential[],
): ThinkingLevel[] {
  if (!model) return [];
  const credential = credentials.find(
    (entry) => entry.provider === model.provider && entry.modelId === model.modelId,
  );
  const entry = catalog.find(
    (item) =>
      item.provider === model.provider &&
      resolveSelectableModelId(catalog, item.provider, item.id) === model.modelId,
  );
  return (credential?.thinkingLevels ?? entry?.thinkingLevels ?? []).filter(
    (level) => level !== "off",
  );
}

/** `bots/update` input for a model pick. A new model starts on its default thinking level. */
export function modelChangeInput(botId: string, key: string) {
  const model = key ? parseModelOptionKey(key) : null;
  return {
    botId,
    modelProvider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
    thinkingLevel: null,
  };
}

/** A quick switch keeps the bot's thinking level when the new model offers it too. */
export function modelSwitchInput(
  botId: string,
  key: string,
  thinkingLevel: string | null,
  levels: readonly ThinkingLevel[],
) {
  const kept = levels.find((level) => level === thinkingLevel) ?? null;
  return { ...modelChangeInput(botId, key), thinkingLevel: kept };
}

/** A requested compaction is done once the summary reaches the message it was asked for. */
export function compactionReached(context: ThreadContext | null, throughSeq: number): boolean {
  return (context?.compactedThroughSeq ?? -1) >= throughSeq;
}

export type CompactionResult = "done" | "nothing" | "timeout" | "abandoned";

/**
 * Asks the server to compact the bot's thread, then polls its context until the summary reaches
 * the requested message. Errors from the request itself (an older server without the procedure,
 * consent refused) are thrown for the caller to show.
 */
export async function compactThread(
  request: <T>(path: string, body: unknown) => Promise<T>,
  botId: string,
  options: {
    alive: () => boolean;
    onContext?: (context: ThreadContext) => void;
    pollMs?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<CompactionResult> {
  const {
    alive,
    onContext,
    pollMs = 2_000,
    waitMs = 3 * 60_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;
  const result = await request<{ queued: boolean; throughSeq: number | null }>("threads/compact", {
    botId,
  });
  if (!result.queued || result.throughSeq === null) return "nothing";
  const deadline = now() + waitMs;
  while (alive() && now() < deadline) {
    await sleep(pollMs);
    const next = await request<ThreadContext>("threads/context", { botId }).catch(() => null);
    if (!alive()) return "abandoned";
    if (next) onContext?.(next);
    if (compactionReached(next, result.throughSeq)) return "done";
  }
  return alive() ? "timeout" : "abandoned";
}

export function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string) {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
