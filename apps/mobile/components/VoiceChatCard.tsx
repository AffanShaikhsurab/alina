import type { VoiceChatGroup } from "@rakazo/core";
import { speechFromBlocks, voiceChatDuration, voiceChatSummary } from "@rakazo/core";
import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import type { MobileMessage } from "../lib/api";
import { voiceChatClock } from "../lib/call-screen";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { MotionView, popoverLayout, quietEntering } from "./motion";
import { NativeSymbol } from "./native-symbol";

/** One call's exchange as a centred "Voice chat · 00:21" line; tapping it shows the transcript. */
export function VoiceChatCard({ group }: { group: VoiceChatGroup<MobileMessage> }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const summary = voiceChatSummary(group);
  return (
    <MotionView layout={popoverLayout} style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? t("Hide transcript") : t("Show transcript")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((wasOpen) => !wasOpen)}
        style={({ pressed }) => [styles.header, { opacity: pressed ? 0.6 : 1 }]}
      >
        <NativeSymbol
          ios="waveform"
          android="pulse-outline"
          size={14}
          color={tokens.mutedForeground}
        />
        <Text style={[styles.title, { color: tokens.mutedForeground }]}>
          {t("Voice chat")}
          {" · "}
          <Text style={styles.duration}>{voiceChatClock(voiceChatDuration(group))}</Text>
        </Text>
        <NativeSymbol
          ios={open ? "chevron.up" : "chevron.down"}
          android={open ? "chevron-up" : "chevron-down"}
          size={12}
          color={tokens.mutedForeground}
        />
      </Pressable>
      {open ? (
        <MotionView entering={quietEntering} style={styles.transcript}>
          {group.messages.map((message) => {
            // The marker is the card's summary line, never a transcript turn.
            if (message === group.marker) return null;
            const text = speechFromBlocks(message.blocks).trim();
            if (!text) return null;
            return message.role === "user" ? (
              <Text key={message.id} style={[styles.user, { color: tokens.mutedForeground }]}>
                {text}
              </Text>
            ) : (
              <Text
                key={message.id}
                style={[
                  styles.bot,
                  { backgroundColor: native.fillPressed, color: tokens.foreground },
                ]}
              >
                {text}
              </Text>
            );
          })}
        </MotionView>
      ) : summary ? (
        <Text numberOfLines={1} style={[styles.summary, { color: tokens.mutedForeground }]}>
          {summary}
        </Text>
      ) : null}
    </MotionView>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", alignItems: "center", paddingVertical: 4 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
  },
  title: { fontSize: 14, fontWeight: "500" },
  duration: { fontVariant: ["tabular-nums"] },
  summary: {
    maxWidth: "80%",
    fontSize: 13,
    textAlign: "center",
    writingDirection: "auto",
  },
  transcript: { alignSelf: "stretch", paddingTop: 6, gap: 6 },
  user: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    fontSize: 14,
    textAlign: "right",
    writingDirection: "auto",
  },
  bot: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    fontSize: 14,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    overflow: "hidden",
    writingDirection: "auto",
  },
});
