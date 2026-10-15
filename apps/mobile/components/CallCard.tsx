import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { mobileTokens } from "../lib/appearance";
import {
  CALL_UPWARD_STRETCH,
  callDragMinimizes,
  callDragOffset,
  callSlideDuration,
} from "../lib/call-gesture";
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
import { transparentColor } from "../lib/color";
import { selectionHaptic, tapHaptic } from "../lib/haptics";
import { useI18n } from "../lib/i18n";
import { MOTION_DISTANCE, MOTION_MS } from "../lib/motion-config";
import { BotAvatar } from "./bot-avatar";
import { GlassSurface } from "./glass-surface";
import { easeInOut, easeOut, PressScale, quietEntering, quietExiting } from "./motion";
import { NativeSymbol } from "./native-symbol";

/** The call is always dark, like a phone call, whatever the app's appearance. */
const callTokens = () => mobileTokens("dark");

const AVATAR_SIZE = 80;
const BUTTON_SIZE = 56;
const TOP_BUTTON_SIZE = 44;
/** How dark the chat gets behind the full-screen call while it is dragged or slides. */
const SCRIM_OPACITY = 0.5;
const TRANSCRIPT_FADE = 32;

// Fades play under Reduce Motion too; only movement is dropped there.
const fadeIn = { duration: MOTION_MS.enter, easing: easeOut, reduceMotion: ReduceMotion.Never };
const fadeOut = { duration: MOTION_MS.close, easing: easeInOut, reduceMotion: ReduceMotion.Never };

/**
 * A call lives in the foreground: once the screen locks, Android pauses the app and the
 * microphone, recognition, and reply feed stop until it is unlocked. Mounted only while a
 * call is up, so the screen sleeps normally the rest of the time.
 */
function KeepScreenOnDuringCall() {
  useKeepAwake("rakazo-call");
  return null;
}

/**
 * Keeps a layer mounted after it stops being visible, until its own closing motion calls
 * `gone`, so the session can flip at once while the screen finishes moving.
 */
function usePresence(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const gone = useCallback(() => setMounted(false), []);
  return { mounted: visible || mounted, leaving: !visible && mounted, gone };
}

type Leaving = "minimize" | "end" | null;

export function CallCard() {
  const call = useCallSession();
  // The call that just ended stays on screen, unchanged, while it fades back to the chat.
  const last = useRef<CallState | null>(null);
  if (call) last.current = call;
  const shown = call ?? last.current;
  const screen = usePresence(Boolean(call && !call.minimized));
  const pill = usePresence(Boolean(call?.minimized));
  return (
    <>
      {call ? <KeepScreenOnDuringCall /> : null}
      {shown && pill.mounted ? (
        <MinimizedCall call={shown} leaving={pill.leaving} onGone={pill.gone} />
      ) : null}
      {shown && screen.mounted ? (
        <CallScreen
          call={shown}
          leaving={screen.leaving ? (call ? "minimize" : "end") : null}
          onGone={screen.gone}
        />
      ) : null}
    </>
  );
}

/**
 * The full-screen call: who is on the line, the live transcript, and the call controls. It
 * rises from the bottom, folds back down when dragged past a quarter of the screen (or flicked),
 * and fades out on hang-up. Every move is a timing curve, so it stops once without bouncing.
 */
function CallScreen({
  call,
  leaving,
  onGone,
}: {
  call: CallState;
  leaving: Leaving;
  onGone: () => void;
}) {
  const { t } = useI18n();
  const tokens = callTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const offset = useSharedValue(reduceMotion ? 0 : height);
  const opacity = useSharedValue(reduceMotion ? 0 : 1);
  const dragStart = useSharedValue(0);
  const releaseVelocity = useSharedValue(0);

  useEffect(() => {
    Keyboard.dismiss();
  }, []);

  useEffect(() => {
    if (leaving) return;
    // Android's back gesture folds the call over the chat instead of leaving the screen below.
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setCallMinimized(true);
      return true;
    });
    return () => back.remove();
  }, [leaving]);

  useEffect(() => {
    const finished = (done?: boolean) => {
      "worklet";
      if (done) scheduleOnRN(onGone);
    };
    if (leaving === "end") {
      opacity.value = withTiming(0, fadeOut, finished);
      if (!reduceMotion) {
        offset.value = withTiming(offset.value + MOTION_DISTANCE.close, {
          duration: MOTION_MS.close,
          easing: easeInOut,
        });
      }
    } else if (leaving === "minimize") {
      if (reduceMotion) {
        opacity.value = withTiming(0, fadeOut, finished);
      } else {
        const remaining = height - offset.value;
        const duration = callSlideDuration(remaining, releaseVelocity.value, height);
        releaseVelocity.value = 0;
        offset.value = withTiming(height, { duration, easing: easeOut }, finished);
      }
    } else {
      opacity.value = withTiming(1, fadeIn);
      offset.value = reduceMotion
        ? 0
        : withTiming(0, { duration: MOTION_MS.sheetIn, easing: easeOut });
    }
  }, [leaving, reduceMotion, height, onGone, offset, opacity, releaseVelocity]);

  const minimize = useCallback(() => {
    tapHaptic();
    setCallMinimized(true);
  }, []);

  // Only the top of the call (controls, name, and the empty space above the transcript) drags;
  // the transcript sits outside this detector, so scrolling it never moves the call.
  const drag = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!leaving)
        .activeOffsetY([-12, 12])
        .failOffsetX([-24, 24])
        .onStart(() => {
          cancelAnimation(offset);
          dragStart.value = offset.value;
        })
        .onUpdate((event) => {
          offset.value = callDragOffset(dragStart.value + event.translationY);
        })
        .onEnd((event) => {
          if (callDragMinimizes(offset.value, event.velocityY, height)) {
            releaseVelocity.value = event.velocityY;
            scheduleOnRN(minimize);
            return;
          }
          offset.value = withTiming(0, { duration: MOTION_MS.settle, easing: easeOut });
        }),
    [leaving, height, minimize, offset, dragStart, releaseVelocity],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: offset.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity:
      opacity.value *
      interpolate(offset.value, [0, height], [SCRIM_OPACITY, 0], Extrapolation.CLAMP),
  }));

  return (
    <View
      pointerEvents={leaving ? "none" : "box-none"}
      importantForAccessibility={leaving ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={Boolean(leaving)}
      style={styles.layer}
    >
      {/* Light text on the dark call until the call has fully left the screen. */}
      <StatusBar style="light" />
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: tokens.background }, scrimStyle]}
      />
      <Animated.View
        accessibilityViewIsModal={!leaving}
        style={[
          styles.screen,
          {
            backgroundColor: tokens.background,
            paddingTop: insets.top + 8,
            // The sheet runs past the bottom edge, so a stretch upwards never shows the chat.
            paddingBottom: Math.max(insets.bottom + 8, 24) + CALL_UPWARD_STRETCH,
          },
          sheetStyle,
        ]}
      >
        <GestureDetector gesture={drag}>
          <View style={styles.grabArea}>
            <View style={styles.topBar}>
              <CallButton
                label={t("Minimise call")}
                ios="chevron.up"
                android="chevron-up"
                size={TOP_BUTTON_SIZE}
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
          </View>
        </GestureDetector>
        {call.transcriptOpen ? <CallTranscript call={call} /> : null}
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
    </View>
  );
}

/** The call folded over the chat: tap to open it again, or hang up from here. */
function MinimizedCall({
  call,
  leaving,
  onGone,
}: {
  call: CallState;
  leaving: boolean;
  onGone: () => void;
}) {
  const { t } = useI18n();
  const tokens = callTokens();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const shift = useSharedValue(reduceMotion ? 0 : -MOTION_DISTANCE.pill);
  const opacity = useSharedValue(0);
  useEffect(() => {
    const finished = (done?: boolean) => {
      "worklet";
      if (done) scheduleOnRN(onGone);
    };
    const target = leaving ? -MOTION_DISTANCE.pill : 0;
    const timing = leaving
      ? { duration: MOTION_MS.exit, easing: easeInOut }
      : { duration: MOTION_MS.enter, easing: easeOut };
    opacity.value = withTiming(
      leaving ? 0 : 1,
      { ...timing, reduceMotion: ReduceMotion.Never },
      leaving ? finished : undefined,
    );
    shift.value = reduceMotion ? 0 : withTiming(target, timing);
  }, [leaving, reduceMotion, onGone, opacity, shift]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: shift.value }],
  }));
  return (
    <Animated.View
      pointerEvents={leaving ? "none" : "box-none"}
      style={[styles.pillWrap, { top: insets.top + 52 }, style]}
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
        <RoundGlass size={BUTTON_SIZE}>
          <NativeSymbol
            ios="gearshape.fill"
            android="settings"
            size={BUTTON_SIZE * 0.4}
            color={tokens.foreground}
          />
        </RoundGlass>
      </View>
    </MenuView>
  );
}

/** The call's round glass: exactly the button's size, with the icon centred on it. */
function RoundGlass({ size, children }: { size: number; children: ReactNode }) {
  const tokens = callTokens();
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <GlassSurface
      shape="circle"
      colorScheme="dark"
      style={[styles.round, round]}
      fallbackStyle={{ backgroundColor: tokens.muted }}
    >
      {children}
    </GlassSurface>
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
        <View
          style={[
            styles.round,
            round,
            { backgroundColor: destructive ? tokens.destructive : tokens.foreground },
          ]}
        >
          {icon}
        </View>
      ) : (
        <RoundGlass size={size}>{icon}</RoundGlass>
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
    <Animated.View entering={quietEntering} exiting={quietExiting} style={styles.crossfade}>
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
      scale.value = withTiming(1, { duration: 160, easing: easeOut });
      return;
    }
    scale.value = withRepeat(
      withSequence(
        withTiming(1.05, { duration: 600, easing: easeInOut }),
        withTiming(1, { duration: 600, easing: easeInOut }),
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

/**
 * Both sides, newest at the bottom: the bot leading in primary text, the caller trailing in
 * grey. Once it outgrows its space, older lines dissolve under a fade at the top.
 */
function CallTranscript({ call }: { call: CallState }) {
  const tokens = callTokens();
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ScrollView>(null);
  const size = useRef({ viewport: 0, content: 0 });
  const [overflowing, setOverflowing] = useState(false);
  const measure = (next: Partial<typeof size.current>) => {
    size.current = { ...size.current, ...next };
    const { viewport, content } = size.current;
    setOverflowing(viewport > 0 && content > viewport + 1);
  };
  const lines = callTranscript(call);
  return (
    <View style={styles.transcriptArea}>
      <ScrollView
        ref={scroll}
        style={styles.transcript}
        contentContainerStyle={[
          styles.transcriptLines,
          overflowing && { paddingTop: TRANSCRIPT_FADE },
        ]}
        showsVerticalScrollIndicator={false}
        onLayout={(event) => measure({ viewport: event.nativeEvent.layout.height })}
        onContentSizeChange={(_width, height) => {
          measure({ content: height });
          scroll.current?.scrollToEnd({ animated: !reduceMotion });
        }}
      >
        {lines.map((line) => {
          const layout = transcriptLineLayout(line);
          return (
            <Animated.View
              key={line.key}
              entering={quietEntering}
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
      {overflowing ? (
        <View
          pointerEvents="none"
          style={[
            styles.transcriptFade,
            {
              experimental_backgroundImage: `linear-gradient(to bottom, ${tokens.background} 0%, ${transparentColor(tokens.background)} 100%)`,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
  },
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: -CALL_UPWARD_STRETCH,
    left: 0,
    paddingHorizontal: 24,
  },
  // Takes the free space above the transcript, so that space drags the call too.
  grabArea: { flexGrow: 1, flexShrink: 0, paddingBottom: 24 },
  topBar: { flexDirection: "row", height: TOP_BUTTON_SIZE },
  identity: { alignItems: "center", marginTop: 8 },
  name: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "600",
    marginTop: 16,
    writingDirection: "auto",
  },
  timer: { fontSize: 15, lineHeight: 20, marginTop: 4 },
  caption: {
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 16,
    writingDirection: "auto",
  },
  controls: { flexDirection: "row", alignItems: "center", gap: 16, paddingTop: 16 },
  controlsGap: { flex: 1 },
  round: { alignItems: "center", justifyContent: "center" },
  crossfade: { position: "absolute", alignItems: "center", justifyContent: "center" },
  dots: { flexDirection: "row", alignItems: "center" },
  transcriptArea: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  transcript: { flexGrow: 0, flexShrink: 1 },
  transcriptLines: { gap: 16, paddingBottom: 24 },
  transcriptFade: { position: "absolute", top: 0, right: 0, left: 0, height: TRANSCRIPT_FADE },
  line: { fontSize: 17, lineHeight: 24, writingDirection: "auto" },
  botLine: { alignSelf: "flex-start", maxWidth: "88%" },
  userLine: { alignSelf: "flex-end", maxWidth: "80%" },
  userText: { textAlign: "right" },
  pillWrap: { position: "absolute", alignSelf: "center", zIndex: 50 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingStart: 10,
    paddingEnd: 8,
    height: 48,
    borderRadius: 24,
  },
  pillFallback: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
  },
  pillBody: { flexDirection: "row", alignItems: "center", gap: 10, height: 48 },
  pillName: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    maxWidth: 140,
    writingDirection: "auto",
  },
  pillTimer: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
});
