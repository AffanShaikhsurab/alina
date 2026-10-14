import type { ThinkingLevel } from "@rakazo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileBot, MobileMe, MobileModel, MobileModelCredential } from "./api";
import { rpc } from "./api";
import { botModelChoices, botModelKey, effectiveModel, thinkingLevelsFor } from "./bot-model";
import { useI18n } from "./i18n";
import { errorText } from "./user-error";

export type BotModelUpdate = {
  botId: string;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel: ThinkingLevel | null;
};

/** `latest` is false when a newer pick was made while this one was saving. */
export type BotModelSaveResult =
  | { ok: true; latest: boolean }
  | { ok: false; latest: boolean; error: string };

/**
 * The bot's model, the connected models it can run, and one ordered save path through
 * `bots/update`. The Model and context sheet and the composer's /model picker share it.
 * `loadKey` 0 waits; each new value loads again, so a reopened picker never shows a stale pick.
 */
export function useBotModel(botId: string | undefined, loadKey = 1) {
  const { t } = useI18n();
  const [bot, setBot] = useState<MobileBot | null>(null);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const alive = useRef(true);
  const saveGeneration = useRef(0);
  /** What the server last accepted, so a failed save never leaves an unsaved pick on screen. */
  const confirmed = useRef<MobileBot | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!botId || !loadKey) return;
    let current = true;
    // A load that a newer load or a later save has overtaken must not replace their state.
    const saveAtLoad = saveGeneration.current;
    const stillCurrent = () => alive.current && current && saveAtLoad === saveGeneration.current;
    setLoadError(null);
    void Promise.all([
      rpc<MobileBot>("bots/get", { botId }),
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextBot, nextMe, nextCatalog, nextCredentials]) => {
        if (!stillCurrent()) return;
        confirmed.current = nextBot;
        setBot(nextBot);
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
      })
      .catch((err) => {
        if (stillCurrent()) setLoadError(errorText(err, t("Could not load model settings")));
      });
    return () => {
      current = false;
    };
  }, [botId, loadKey]);

  const selectedKey = bot ? botModelKey(bot, catalog) : "";
  const spaceDefault = useMemo(
    () => ({ provider: me?.defaultProvider ?? null, modelId: me?.defaultModel ?? null }),
    [me],
  );

  const modelChoices = useMemo(() => {
    const defaultModel = me?.defaultModel
      ? (catalog.find(
          (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
        )?.label ?? me.defaultModel)
      : null;
    return botModelChoices({
      selectedKey,
      defaultLabel: defaultModel ? `${t("Space default")} (${defaultModel})` : t("Space default"),
      catalog,
      credentials,
    });
  }, [catalog, credentials, me, selectedKey, t]);

  /** Thinking levels the model behind a picker key offers. */
  function levelsFor(key: string): ThinkingLevel[] {
    return thinkingLevelsFor(effectiveModel(key, spaceDefault), catalog, credentials);
  }

  async function save(input: BotModelUpdate): Promise<BotModelSaveResult> {
    const previous = bot;
    const generation = ++saveGeneration.current;
    if (bot) setBot({ ...bot, ...input });
    // One update at a time, in pick order, so an older save can never land after a newer one.
    const request = saveQueue.current.then(() => rpc("bots/update", input));
    saveQueue.current = request.catch(() => undefined);
    try {
      await request;
      if (previous) confirmed.current = { ...(confirmed.current ?? previous), ...input };
      return { ok: true, latest: generation === saveGeneration.current };
    } catch (err) {
      const latest = generation === saveGeneration.current;
      if (alive.current && latest) setBot(confirmed.current ?? previous);
      return { ok: false, latest, error: errorText(err, t("Could not save model")) };
    }
  }

  return {
    bot,
    loaded: bot !== null,
    loadError,
    selectedKey,
    thinkingLevels: levelsFor(selectedKey),
    modelChoices,
    levelsFor,
    save,
  };
}
