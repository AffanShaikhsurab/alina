import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { SubagentDetail } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { trailingHeaderOptions } from "../components/sheet-header";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import {
  fetchSubagent,
  redoSubagent,
  subagentToolLabel,
  subagentToolSymbol,
} from "../lib/subagent";
import { errorText } from "../lib/user-error";

const RUNNING_REFRESH_MS = 2_000;

function newClientNonce(): string {
  return `subagent-redo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

/** One sub-agent a run started: what it was asked, what it did, what it returned. */
export default function SubagentScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const { botId, groupId, runId, agentId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    runId: string;
    agentId: string;
  }>();
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redoing, setRedoing] = useState(false);
  const active = useRef(true);

  const load = useCallback(async () => {
    if (!runId || !agentId || (!botId && !groupId)) return;
    try {
      const next = await fetchSubagent(groupId ? { groupId } : { botId: botId! }, runId, agentId);
      if (!active.current) return;
      setDetail(next);
      setError(null);
    } catch (err) {
      if (active.current) setError(errorText(err, t("Try again.")));
    }
  }, [agentId, botId, groupId, runId, t]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);

  const running = detail?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), RUNNING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, running]);

  async function redo() {
    if (!detail || !botId || redoing) return;
    setRedoing(true);
    try {
      await redoSubagent(botId, detail.runId, detail.agentId, newClientNonce());
      if (active.current && router.canGoBack()) router.back();
    } catch (err) {
      if (active.current) Alert.alert(t("Run again"), errorText(err, t("Try again.")));
    } finally {
      if (active.current) setRedoing(false);
    }
  }

  const statusLabel =
    detail?.status === "running"
      ? t("Running")
      : detail?.status === "failed"
        ? t("Failed")
        : t("Completed");
  const statusColor =
    detail?.status === "failed"
      ? tokens.destructive
      : detail?.status === "running"
        ? tokens.warning
        : tokens.success;
  const output = detail?.result || detail?.progress || "";
  const sectionLabel = { color: tokens.mutedForeground, fontSize: 13, marginTop: 20 } as const;

  return (
    <>
      <Stack.Screen
        options={{
          title: detail?.name || t("subagent"),
          ...(botId && !groupId
            ? trailingHeaderOptions(t("Run again"), () => void redo(), !detail?.canRedo || redoing)
            : {}),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {!detail ? (
          error ? (
            <Text style={{ color: tokens.destructive }}>{error}</Text>
          ) : (
            <ActivityIndicator color={tokens.mutedForeground} />
          )
        ) : (
          <>
            <Text accessibilityRole="text" style={{ color: statusColor, fontSize: 14 }}>
              {statusLabel}
            </Text>
            <Text style={sectionLabel}>{t("Prompt")}</Text>
            <Text selectable style={{ color: tokens.foreground, fontSize: 15, marginTop: 6 }}>
              {detail.task}
            </Text>
            {detail.instructions ? (
              <Text
                selectable
                style={{ color: tokens.mutedForeground, fontSize: 14, marginTop: 8 }}
              >
                {detail.instructions}
              </Text>
            ) : null}
            {detail.modelId ? (
              <>
                <Text style={sectionLabel}>{t("Model")}</Text>
                <Text style={{ color: tokens.foreground, fontSize: 15, marginTop: 6 }}>
                  {detail.modelId}
                </Text>
              </>
            ) : null}
            {detail.tools.length > 0 ? (
              <>
                <Text style={sectionLabel}>{t("Tools")}</Text>
                <View style={{ marginTop: 6, gap: 10 }}>
                  {detail.tools.map((call) => {
                    const symbol = subagentToolSymbol(call.status);
                    const label = subagentToolLabel(call);
                    return (
                      <View key={call.executionId} accessible accessibilityLabel={label}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <NativeSymbol
                            ios={symbol.ios}
                            android={symbol.android}
                            size={15}
                            color={
                              call.status === "error" ? tokens.destructive : tokens.mutedForeground
                            }
                          />
                          <Text style={{ color: tokens.foreground, fontSize: 15, flexShrink: 1 }}>
                            {label}
                          </Text>
                        </View>
                        {call.error ? (
                          <Text
                            selectable
                            style={{
                              color: tokens.mutedForeground,
                              fontSize: 13,
                              marginTop: 2,
                              marginStart: 23,
                            }}
                          >
                            {call.error}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}
            {output ? (
              <View style={{ marginTop: 20 }}>
                <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
                  {output}
                </ChatMarkdown>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}
