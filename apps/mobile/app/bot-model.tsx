import type { ThinkingLevel, ThreadContext } from "@rakazo/contracts";
import { contextFraction, contextMeasuredBeforeCompaction, formatTokenCount } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ContextMeter } from "../components/context-meter";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup } from "../components/settings-group";
import { trailingHeaderOptions } from "../components/sheet-header";
import { rpc } from "../lib/api";
import { compactThread, modelChangeInput, thinkingLevelLabel } from "../lib/bot-model";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import type { BotModelUpdate } from "../lib/use-bot-model";
import { useBotModel } from "../lib/use-bot-model";
import { errorText } from "../lib/user-error";

/** Switch the bot's model and see how full its context is, without leaving the chat. */
export default function BotModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const botModel = useBotModel(botId);
  const { bot, selectedKey, thinkingLevels } = botModel;
  const [context, setContext] = useState<ThreadContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fail = (text: string) => setNotice({ text, error: true });
  const alive = useRef(true);

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
    refreshContext();
  }, [botId]);

  useEffect(() => {
    if (botModel.loadError) fail(botModel.loadError);
  }, [botModel.loadError]);

  const modelChoices: MenuPickerChoice[] = botModel.modelChoices;

  const thinkingChoices: MenuPickerChoice[] = [
    { key: "", label: t("Default (medium)") },
    ...thinkingLevels.map((level) => ({ key: level, label: thinkingLevelLabel(level, t) })),
  ];

  async function save(input: BotModelUpdate) {
    if (!bot) return;
    setNotice(null);
    const result = await botModel.save(input);
    if (!alive.current || !result.latest) return;
    if (result.ok) refreshContext();
    else fail(result.error);
  }

  async function compact() {
    if (!botId || compacting) return;
    setCompacting(true);
    setNotice(null);
    try {
      const result = await compactThread(rpc, botId, {
        alive: () => alive.current,
        onContext: setContext,
      });
      if (result === "nothing") setNotice({ text: t("Nothing new to compact"), error: false });
      else if (result === "timeout") fail(t("Could not compact. Try again."));
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
