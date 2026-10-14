import type { ThinkingLevel, ThreadContext } from "@rakazo/contracts";
import { contextFraction, contextMeasuredBeforeCompaction, formatTokenCount } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ContextMeter } from "../components/context-meter";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup } from "../components/settings-group";
import { trailingHeaderOptions } from "../components/sheet-header";
import type { MobileBot, MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import {
  botModelChoices,
  botModelKey,
  compactionReached,
  effectiveModel,
  modelChangeInput,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from "../lib/bot-model";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

const COMPACTION_POLL_MS = 2_000;
/** A few summarizer batches; the server bounds each one. */
const COMPACTION_WAIT_MS = 3 * 60_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Switch the bot's model and see how full its context is, without leaving the chat. */
export default function BotModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<MobileBot | null>(null);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [context, setContext] = useState<ThreadContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fail = (text: string) => setNotice({ text, error: true });
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

  function refreshContext() {
    if (!botId) return;
    void rpc<ThreadContext>("threads/context", { botId })
      .then((next) => {
        if (alive.current) setContext(next);
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!botId) return;
    void Promise.all([
      rpc<MobileBot>("bots/get", { botId }),
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextBot, nextMe, nextCatalog, nextCredentials]) => {
        if (!alive.current) return;
        confirmed.current = nextBot;
        setBot(nextBot);
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
      })
      .catch((err) => {
        if (alive.current) fail(errorText(err, t("Could not load model settings")));
      });
    refreshContext();
  }, [botId]);

  const selectedKey = bot ? botModelKey(bot, catalog) : "";
  const spaceDefault = { provider: me?.defaultProvider ?? null, modelId: me?.defaultModel ?? null };
  const model = effectiveModel(selectedKey, spaceDefault);
  const thinkingLevels = thinkingLevelsFor(model, catalog, credentials);

  const modelChoices: MenuPickerChoice[] = useMemo(() => {
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

  const thinkingChoices: MenuPickerChoice[] = [
    { key: "", label: t("Default (medium)") },
    ...thinkingLevels.map((level) => ({ key: level, label: thinkingLevelLabel(level, t) })),
  ];

  async function save(input: {
    botId: string;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel: ThinkingLevel | null;
  }) {
    if (!bot) return;
    const previous = bot;
    const generation = ++saveGeneration.current;
    setBot({ ...bot, ...input });
    setNotice(null);
    // One update at a time, in pick order, so an older save can never land after a newer one.
    const request = saveQueue.current.then(() => rpc("bots/update", input));
    saveQueue.current = request.catch(() => undefined);
    try {
      await request;
      confirmed.current = { ...(confirmed.current ?? previous), ...input };
      if (generation === saveGeneration.current) refreshContext();
    } catch (err) {
      if (!alive.current || generation !== saveGeneration.current) return;
      setBot(confirmed.current ?? previous);
      fail(errorText(err, t("Could not save model")));
    }
  }

  async function compact() {
    if (!botId || compacting) return;
    setCompacting(true);
    setNotice(null);
    try {
      const result = await rpc<{ queued: boolean; throughSeq: number | null }>("threads/compact", {
        botId,
      });
      if (!result.queued || result.throughSeq === null) {
        if (alive.current) setNotice({ text: t("Nothing new to compact"), error: false });
        return;
      }
      const deadline = Date.now() + COMPACTION_WAIT_MS;
      while (alive.current && Date.now() < deadline) {
        await wait(COMPACTION_POLL_MS);
        const next = await rpc<ThreadContext>("threads/context", { botId }).catch(() => null);
        if (!alive.current) return;
        if (next) setContext(next);
        if (compactionReached(next, result.throughSeq)) return;
      }
      if (alive.current) fail(t("Could not compact. Try again."));
    } catch (err) {
      if (alive.current) fail(errorText(err, t("Could not compact. Try again.")));
    } finally {
      if (alive.current) setCompacting(false);
    }
  }

  const fraction = contextFraction(context?.usedTokens, context?.contextWindow);
  const used = context?.usedTokens ?? null;
  const total = context?.contextWindow ?? null;
  const usage =
    total !== null
      ? t("{used} of {total}", {
          used: used === null ? "—" : formatTokenCount(used),
          total: formatTokenCount(total),
        })
      : used !== null
        ? formatTokenCount(used)
        : "—";
  const stale = context ? contextMeasuredBeforeCompaction(context) : false;

  return (
    <>
      <Stack.Screen
        options={{
          title: t("Model and context"),
          ...trailingHeaderOptions(t("Done"), () => router.back()),
        }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          <MenuPicker
            key="model"
            choices={modelChoices}
            label={t("Model")}
            onChange={(key) => {
              if (botId && key !== selectedKey) void save(modelChangeInput(botId, key));
            }}
            value={selectedKey}
          />
          {thinkingLevels.length ? (
            <MenuPicker
              key="thinking"
              choices={thinkingChoices}
              label={t("Thinking")}
              onChange={(level) => {
                if (botId) {
                  // Resend the shown model too, so this save also settles a model pick still in flight.
                  void save({
                    ...modelChangeInput(botId, selectedKey),
                    thinkingLevel: (level || null) as ThinkingLevel | null,
                  });
                }
              }}
              value={bot?.thinkingLevel ?? ""}
            />
          ) : null}
        </SettingsGroup>
        <SettingsGroup>
          <View key="context" style={styles.contextRow}>
            <View style={styles.contextLine}>
              <Text style={styles.label}>{t("Context")}</Text>
              <Text numberOfLines={1} style={styles.value}>
                {usage}
              </Text>
            </View>
            {fraction !== null ? <ContextMeter fraction={fraction} label={t("Context")} /> : null}
            {stale ? <Text style={styles.detail}>{t("Updates after the next reply")}</Text> : null}
          </View>
        </SettingsGroup>
        <NativeActionButton
          busy={compacting}
          disabled={!context || context.uncompactedMessages === 0}
          label={t("Compact")}
          onPress={() => void compact()}
          prominence="secondary"
        />
        {notice ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[
              styles.notice,
              { color: notice.error ? tokens.destructive : native.secondaryLabel },
            ]}
          >
            {notice.text}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 20 },
    contextRow: { paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    contextLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    label: { color: native.label, fontSize: 16 },
    value: { flex: 1, color: native.secondaryLabel, fontSize: 16, textAlign: "right" },
    detail: { color: native.secondaryLabel, fontSize: 13 },
    notice: { fontSize: 13, paddingHorizontal: 16 },
  });
}
