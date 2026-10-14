import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { BackHandler, Keyboard, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import type { EntryExitAnimationFunction, SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutUp,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { callClock, callPresence } from "../lib/call-screen";
import type { CallState } from "../lib/call-session";
import {
  endCall,
  setCallMinimized,
  setSpeaker,
  toggleMute,
  toggleTranscript,
  useCallSession,
} from "../lib/call-session";
import { callTranscript, transcriptLineLayout } from "../lib/call-transcript";
import { selectionHaptic, tapHaptic } from "../lib/haptics";
import { useI18n } from "../lib/i18n";
import { BotAvatar } from "./bot-avatar";
import { GlassSurface } from "./glass-surface";
import { PressScale, quietEntering, quietExiting } from "./motion";
import { NativeSymbol } from "./native-symbol";

/** The call is always dark, like a phone call, whatever the app's appearance. */
const callTokens = () => mobileTokens("dark");

const AVATAR_SIZE = 76;
const BUTTON_SIZE = 56;

/**
 * A call lives in the foreground: once the screen locks, Android pauses the app and the
 * microphone, recognition, and reply feed stop until it is unlocked. Mounted only while a
 * call is up, so the screen sleeps normally the rest of the time.
 */
function KeepScreenOnDuringCall() {
  useKeepAwake("rakazo-call");
  return null;
}

// The call rises into place and settles back as one piece; Reduce Motion gets a plain fade.
const callEntering: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 48 }] },
    animations: {
      opacity: withTiming(1, { duration: 220 }),
      transform: [{ translateY: withSpring(0, { damping: 22, stiffness: 220 }) }],
    },
  };
};
const callExiting: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 200 }),
      transform: [{ scale: withTiming(0.96, { duration: 200 }) }],
    },
  };
};

export function CallCard() {
  const call = useCallSession();
  if (!call) return null;
  return (
    <>
      <KeepScreenOnDuringCall />
      {call.minimized ? <MinimizedCall call={call} /> : <CallScreen call={call} />}
    </>
  );
}

/** The full-screen call: who is on the line, the live transcript, and the call controls. */
function CallScreen({ call }: { call: CallState }) {
  const { t } = useI18n();
  const tokens = callTokens();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    Keyboard.dismiss();
    // Android's back gesture folds the call over the chat instead of leaving the screen below.
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setCallMinimized(true);
      return true;
    });
    return () => back.remove();
  }, []);
  return (
    <Animated.View
      accessibilityViewIsModal
      entering={reduceMotion ? FadeIn.duration(180) : callEntering}
      exiting={reduceMotion ? FadeOut.duration(160) : callExiting}
      style={[
        styles.screen,
        {
          backgroundColor: tokens.background,
          paddingTop: insets.top + 8,
          paddingBottom: Math.max(insets.bottom, 16),
        },
      ]}
    >
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <CallButton
          label={t("Minimise call")}
          ios="chevron.up"
          android="chevron-up"
          size={44}
          onPress={() => {
            selectionHaptic();
            setCallMinimized(true);
          }}
        />
      </View>
      <View style={styles.identity}>
        <CallPresence call={call} size={AVATAR_SIZE} />
        <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
          {call.botName}
        </Text>
        <CallTimer
          startedAt={call.startedAt}
          style={[styles.timer, { color: tokens.mutedForeground }]}
        />
      </View>
      <View style={styles.middle}>
        {call.transcriptOpen ? <CallTranscript call={call} /> : null}
      </View>
      {call.caption ? (
        <Animated.Text
          entering={quietEntering}
          exiting={quietExiting}
          accessibilityLiveRegion="polite"
          style={[styles.caption, { color: tokens.mutedForeground }]}
        >
          {call.caption}
        </Animated.Text>
      ) : null}
      <View style={styles.controls}>
        <CallButton
          label={call.muted ? t("Unmute") : t("Mute")}
          ios={call.muted ? "mic.slash.fill" : "mic.fill"}
          android={call.muted ? "mic-off" : "mic"}
          selected={call.muted}
          onPress={() => {
            tapHaptic();
            toggleMute();
          }}
        />
        <CallSettings call={call} />
        <View style={styles.controlsGap} />
        <CallButton
          label={t("End call")}
          ios="xmark"
          android="close"
          destructive
          onPress={() => {
            tapHaptic();
            endCall();
          }}
        />
      </View>
    </Animated.View>
  );
}

/** The call folded over the chat: tap to open it again, or hang up from here. */
function MinimizedCall({ call }: { call: CallState }) {
  const { t } = useI18n();
  const tokens = callTokens();
  const insets = useSafeAreaInsets();
  return (
    <Animated.View
      entering={FadeInUp.springify().damping(20).stiffness(220)}
      exiting={FadeOutUp.duration(160)}
      style={[styles.pillWrap, { top: insets.top + 52 }]}
    >
      <GlassSurface
        colorScheme="dark"
        tint={tokens.card}
        style={styles.pill}
        fallbackStyle={[
          styles.pillFallback,
          { backgroundColor: tokens.card, borderColor: tokens.border },
        ]}
      >
        <PressScale
          accessibilityLabel={t("On a call with {name}", { name: call.botName })}
          pressedScale={0.97}
          haptic={selectionHaptic}
          onPress={() => setCallMinimized(false)}
          style={styles.pillBody}
        >
          <CallPresence call={call} size={28} />
          <Text numberOfLines={1} style={[styles.pillName, { color: tokens.foreground }]}>
            {call.botName}
          </Text>
          <CallTimer
            startedAt={call.startedAt}
            style={[styles.pillTimer, { color: tokens.mutedForeground }]}
          />
        </PressScale>
        <CallButton
          label={t("End call")}
          ios="xmark"
          android="close"
          size={32}
          destructive
          onPress={() => {
            tapHaptic();
            endCall();
          }}
        />
      </GlassSurface>
    </Animated.View>
  );
}

/** Audio output, the transcript and the voice, in the system menu. */
function CallSettings({ call }: { call: CallState }) {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = callTokens();
  const actions: MenuAction[] = [
    {
      id: "output",
      title: "",
      displayInline: true,
      subactions: [
        {
          id: "earpiece",
          title: Platform.OS === "ios" ? t("iPhone") : t("Phone"),
          image: "iphone",
          state: call.speaker ? "off" : "on",
        },
        {
          id: "speaker",
          title: t("Speaker"),
          image: "speaker.wave.2",
          state: call.speaker ? "on" : "off",
        },
      ],
    },
    {
      id: "more",
      title: "",
      displayInline: true,
      subactions: [
        {
          id: "transcript",
          title: t("Transcript"),
          image: "captions.bubble",
          state: call.transcriptOpen ? "on" : "off",
        },
        { id: "voice", title: t("Voice"), image: "waveform" },
      ],
    },
  ];
  return (
    <MenuView
      actions={actions}
      colorScheme="dark"
      onPressAction={({ nativeEvent }) => {
        selectionHaptic();
        if (nativeEvent.event === "earpiece") setSpeaker(false);
        else if (nativeEvent.event === "speaker") setSpeaker(true);
        else if (nativeEvent.event === "transcript") toggleTranscript();
        else if (nativeEvent.event === "voice") {
          // The settings sheet opens over the chat, so the call folds out of its way.
          setCallMinimized(true);
          router.push("/voice");
        }
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("Call settings")}
        style={{ width: BUTTON_SIZE, height: BUTTON_SIZE }}
      >
        <GlassSurface
          shape="circle"
          colorScheme="dark"
          style={[styles.round, { width: BUTTON_SIZE, height: BUTTON_SIZE }]}
          fallbackStyle={{ borderRadius: BUTTON_SIZE / 2, backgroundColor: tokens.muted }}
        >
          <NativeSymbol
            ios="gearshape.fill"
            android="settings"
            size={22}
            color={tokens.foreground}
          />
        </GlassSurface>
      </View>
    </MenuView>
  );
}

function CallButton({
  label,
  ios,
  android,
  size = BUTTON_SIZE,
  selected,
  destructive,
  onPress,
}: {
  label: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  size?: number;
  selected?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  const tokens = callTokens();
  const fill = destructive ? tokens.destructive : selected ? tokens.foreground : tokens.muted;
  const iconColor = destructive
    ? tokens.destructiveForeground
    : selected
      ? tokens.background
      : tokens.foreground;
  const round = { width: size, height: size, borderRadius: size / 2 };
  const icon = <NativeSymbol ios={ios} android={android} size={size * 0.4} color={iconColor} />;
  return (
    <PressScale
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      onPress={onPress}
      style={round}
    >
      {destructive || selected ? (
        // Solid fills read at a glance: red to hang up, white while muted.
        <View style={[styles.round, round, { backgroundColor: fill }]}>{icon}</View>
      ) : (
        <GlassSurface
          shape="circle"
          colorScheme="dark"
          style={[styles.round, round]}
          fallbackStyle={{ borderRadius: size / 2, backgroundColor: fill }}
        >
          {icon}
        </GlassSurface>
      )}
    </PressScale>
  );
}

/** The bot's face while it talks or the line rests; the activity dots while it listens or thinks. */
function CallPresence({ call, size }: { call: CallState; size: number }) {
  const presence = callPresence(call);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {presence === "avatar" ? (
        <Crossfade key="avatar">
          <SpeakingPulse active={call.phase === "speaking"}>
            <BotAvatar color={call.botColor} identity={call.botId} size={size} />
          </SpeakingPulse>
        </Crossfade>
      ) : (
        <Crossfade key="dots">
          <ActivityDots thinking={call.phase === "thinking"} dot={Math.max(6, size / 8)} />
        </Crossfade>
      )}
    </View>
  );
}

function Crossfade({ children }: { children: ReactNode }) {
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(160)}
      style={styles.crossfade}
    >
      {children}
    </Animated.View>
  );
}

/** A slow, small breath while the bot is speaking. */
function SpeakingPulse({ active, children }: { active: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!active || reduceMotion) {
      cancelAnimation(scale);
      scale.value = withTiming(1, { duration: 160 });
      return;
    }
    scale.value = withRepeat(
      withSequence(
        withTiming(1.06, { duration: 520, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 520, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
    return () => cancelAnimation(scale);
  }, [active, reduceMotion, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

const DOTS = [0, 1, 2];

/** Three dots, the middle one brighter: a wave while thinking, a slow breath while listening. */
function ActivityDots({ thinking, dot }: { thinking: boolean; dot: number }) {
  const tokens = callTokens();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: thinking ? 1_000 : 1_800, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, reduceMotion, thinking]);
  return (
    <View style={[styles.dots, { gap: dot * 0.8 }]}>
      {DOTS.map((index) => (
        <Dot
          key={index}
          index={index}
          size={dot}
          color={tokens.foreground}
          progress={progress}
          thinking={thinking}
          still={reduceMotion}
        />
      ))}
    </View>
  );
}

function Dot({
  index,
  size,
  color,
  progress,
  thinking,
  still,
}: {
  index: number;
  size: number;
  color: string;
  progress: SharedValue<number>;
  thinking: boolean;
  still: boolean;
}) {
  const rest = index === 1 ? 1 : 0.4;
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: rest, transform: [{ scale: 1 }] };
    if (thinking) {
      const phase = (progress.value + index / 3) % 1;
      return {
        opacity: interpolate(phase, [0, 0.5, 1], [rest * 0.5, rest, rest * 0.5]),
        transform: [{ scale: interpolate(phase, [0, 0.5, 1], [0.85, 1.15, 0.85]) }],
      };
    }
    const breath = Math.sin(progress.value * Math.PI * 2) * 0.5 + 0.5;
    return {
      opacity: index === 1 ? interpolate(breath, [0, 1], [0.7, 1]) : rest,
      transform: [{ scale: index === 1 ? interpolate(breath, [0, 1], [0.92, 1.12]) : 1 }],
    };
  });
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/** Ticks once a second on its own, so the rest of the call does not re-render with it. */
function CallTimer({
  startedAt,
  style,
}: {
  startedAt: number;
  style: ComponentProps<typeof Text>["style"];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text style={[style, { fontVariant: ["tabular-nums"] }]}>{callClock(now - startedAt)}</Text>
  );
}

/** Both sides, newest at the bottom: the bot leading in primary text, the caller trailing in grey. */
function CallTranscript({ call }: { call: CallState }) {
  const tokens = callTokens();
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ScrollView>(null);
  const lines = callTranscript(call);
  return (
    <ScrollView
      ref={scroll}
      style={styles.transcript}
      contentContainerStyle={styles.transcriptLines}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: !reduceMotion })}
    >
      {lines.map((line) => {
        const layout = transcriptLineLayout(line);
        return (
          <Animated.View
            key={line.key}
            entering={FadeIn.duration(220)}
            style={layout.align === "end" ? styles.userLine : styles.botLine}
          >
            <Text
              style={[
                styles.line,
                layout.align === "end" && styles.userText,
                {
                  color: layout.tone === "primary" ? tokens.foreground : tokens.mutedForeground,
                },
              ]}
            >
              {line.text}
            </Text>
          </Animated.View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    paddingHorizontal: 20,
  },
  topBar: { flexDirection: "row", height: 44 },
  identity: { alignItems: "center", gap: 6, marginTop: 4 },
  name: { fontSize: 20, fontWeight: "600", marginTop: 10, writingDirection: "auto" },
  timer: { fontSize: 15 },
  middle: { flex: 1, justifyContent: "flex-end", paddingTop: 24 },
  caption: { fontSize: 14, textAlign: "center", marginBottom: 12, writingDirection: "auto" },
  controls: { flexDirection: "row", alignItems: "center", gap: 16, paddingTop: 12 },
  controlsGap: { flex: 1 },
  round: { alignItems: "center", justifyContent: "center" },
  crossfade: { position: "absolute", alignItems: "center", justifyContent: "center" },
  dots: { flexDirection: "row", alignItems: "center" },
  transcript: { flexGrow: 0, maxHeight: "100%" },
  transcriptLines: { gap: 14, paddingBottom: 20 },
  line: { fontSize: 17, lineHeight: 24, writingDirection: "auto" },
  botLine: { alignSelf: "flex-start", maxWidth: "88%" },
  userLine: { alignSelf: "flex-end", maxWidth: "80%" },
  userText: { textAlign: "right" },
  pillWrap: { position: "absolute", alignSelf: "center", zIndex: 50 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingStart: 8,
    paddingEnd: 8,
    height: 48,
    borderRadius: 24,
  },
  pillFallback: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
  },
  pillBody: { flexDirection: "row", alignItems: "center", gap: 10, height: 48 },
  pillName: { fontSize: 15, fontWeight: "600", maxWidth: 140, writingDirection: "auto" },
  pillTimer: { fontSize: 14, fontVariant: ["tabular-nums"] },
});
