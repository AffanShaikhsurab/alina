// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallCard } from "../components/CallCard";
import type { CallDeps, DictationHandlers } from "./call-session";
import { endCall, startCall } from "./call-session";

const { activeTags, useKeepAwake, menu, push, motion } = vi.hoisted(() => ({
  activeTags: new Set<string>(),
  useKeepAwake: vi.fn(),
  menu: {
    actions: [] as Array<{ id?: string; state?: string; subactions?: unknown[] }>,
    press: (_id: string) => {},
  },
  push: vi.fn(),
  // Timing animations finish at once unless a test holds them to look mid-motion.
  motion: { hold: false, pending: [] as Array<() => void> },
}));

function finishMotion() {
  act(() => {
    const pending = motion.pending.splice(0);
    for (const done of pending) done();
  });
}

type Style = Record<string, unknown>;
function flatStyle(style: unknown): Style {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return style && typeof style === "object" ? (style as Style) : {};
}

vi.mock("expo-keep-awake", () => ({ useKeepAwake }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    actions: typeof menu.actions;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    menu.actions = props.actions;
    menu.press = (id) => props.onPressAction({ nativeEvent: { event: id } });
    return props.children;
  },
}));
vi.mock("react-native-reanimated", async () => {
  const { createElement: h } = await import("react");
  // Every preset and modifier chain (FadeIn.duration(...).easing(...)) is inert here.
  const builder: unknown = new Proxy(() => builder, { get: () => builder });
  const View = ({ children }: { children?: ReactNode }) => h("div", null, children);
  const Text = ({ children }: { children?: ReactNode }) => h("span", null, children);
  return {
    default: { View, Text },
    FadeIn: builder,
    FadeInUp: builder,
    FadeOut: builder,
    FadeOutUp: builder,
    Easing: builder,
    Extrapolation: { CLAMP: "clamp" },
    ReduceMotion: { Never: "never", System: "system" },
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: () => ({}),
    cancelAnimation: () => undefined,
    interpolate: () => 0,
    withRepeat: () => 0,
    withSequence: () => 0,
    withTiming: (value: number, _config?: unknown, done?: (finished: boolean) => void) => {
      if (done) {
        if (motion.hold) motion.pending.push(() => done(true));
        else done(true);
      }
      return value;
    },
  };
});
vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));
vi.mock("react-native-gesture-handler", () => {
  const pan: unknown = new Proxy(() => pan, { get: () => pan });
  return {
    Gesture: { Pan: () => pan },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native", () => {
  function View({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) {
    return createElement("div", { "aria-label": accessibilityLabel }, children);
  }
  return {
    View,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    ScrollView: View,
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Keyboard: { dismiss: () => undefined },
    Platform: { OS: "ios", Version: 18 },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  };
});
vi.mock("../components/motion", async () => {
  const { createElement: h } = await import("react");
  return {
    PressScale: (props: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel: string;
      accessibilityState?: { selected?: boolean };
    }) =>
      h(
        "button",
        {
          type: "button",
          onClick: props.onPress,
          "aria-label": props.accessibilityLabel,
          "aria-pressed": props.accessibilityState?.selected,
        },
        props.children,
      ),
    quietEntering: undefined,
    quietExiting: undefined,
    easeOut: undefined,
    easeInOut: undefined,
  };
});
vi.mock("../components/glass-surface", async () => {
  const { createElement: h } = await import("react");
  return {
    GlassSurface: ({
      children,
      shape,
      style,
    }: {
      children?: ReactNode;
      shape?: string;
      style?: unknown;
    }) => {
      const { width, height } = flatStyle(style);
      return h(
        "div",
        { "data-glass": shape ?? "capsule", "data-width": width, "data-height": height },
        children,
      );
    },
  };
});
vi.mock("./haptics", () => ({ selectionHaptic: vi.fn(), tapHaptic: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./call-audio", () => ({
  beginCallAudio: vi.fn(async () => undefined),
  callRecognizerCategory: vi.fn(() => undefined),
  endCallAudio: vi.fn(async () => undefined),
  reassertCallAudio: vi.fn(async () => undefined),
  setCallSpeaker: vi.fn(async () => undefined),
}));
vi.mock("./api", () => ({
  rpc: vi.fn().mockResolvedValue({ name: "Test" }),
  applyMobileThreadEvent: vi.fn(),
  blockText: vi.fn(),
  captureApiRequestContext: vi.fn(),
  subscribeThread: vi.fn(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? `{${key}}`);
  return { useI18n: () => ({ t }), t, getActiveUiLocale: () => "en" };
});
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-symbol", async () => {
  const { createElement: h } = await import("react");
  return { NativeSymbol: ({ ios }: { ios: string }) => h("i", { "data-symbol": ios }) };
});
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("./voice", () => ({ speakText: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("./dictation", () => ({ available: vi.fn(), listen: vi.fn() }));
vi.mock("./call-sounds", () => ({
  playCallCue: vi.fn(),
  preloadWaitSound: vi.fn(),
  releaseWaitSound: vi.fn(),
  startWaitSound: vi.fn(),
  stopWaitSound: vi.fn(),
}));

function callDeps(overrides: Partial<CallDeps> = {}): CallDeps {
  return {
    dictate: async () => true,
    record: vi.fn(),
    transcribe: vi.fn(),
    send: vi.fn(),
    endCall: async () => undefined,
    speak: async () => undefined,
    watch: () => vi.fn(),
    stopSpeaking: vi.fn(),
    cue: async () => undefined,
    waitSound: vi.fn(),
    ...overrides,
  };
}

describe("CallCard", () => {
  let root: Root;
  let container: HTMLDivElement;

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const press = (label: string) => {
    const target = button(label);
    expect(target).not.toBeNull();
    act(() => target!.click());
  };
  async function startOnScreen(deps: CallDeps) {
    act(() => root.render(<CallCard />));
    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useKeepAwake.mockImplementation((tag: string) => {
      useEffect(() => {
        activeTags.add(tag);
        return () => {
          activeTags.delete(tag);
        };
      }, [tag]);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    motion.hold = false;
    motion.pending.length = 0;
    act(() => {
      endCall();
      root.unmount();
    });
    container.remove();
    activeTags.clear();
    useKeepAwake.mockReset();
    push.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the screen awake only while a call is active", async () => {
    act(() => root.render(<CallCard />));
    expect(container.childElementCount).toBe(0);
    expect(useKeepAwake).not.toHaveBeenCalled();
    expect(activeTags.has("rakazo-call")).toBe(false);

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, callDeps());
    });
    expect(container.textContent).toContain("Ada");
    expect(useKeepAwake).toHaveBeenCalledWith("rakazo-call");
    expect(activeTags.has("rakazo-call")).toBe(true);

    await act(async () => endCall());
    expect(container.childElementCount).toBe(0);
    expect(activeTags.has("rakazo-call")).toBe(false);
  });

  it("labels every control and hangs up from the end button", async () => {
    await startOnScreen(callDeps());
    for (const label of ["Minimise call", "Mute", "Call settings", "End call"]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    press("End call");
    expect(container.childElementCount).toBe(0);
  });

  it("draws each round control as one glass circle the button's full size around its icon", async () => {
    await startOnScreen(callDeps());
    for (const [label, size, symbol] of [
      ["Minimise call", 44, "chevron.up"],
      ["Mute", 56, "mic.fill"],
      ["Call settings", 56, "gearshape.fill"],
    ] as const) {
      const control = container.querySelector(`[aria-label="${label}"]`);
      const glass = control?.firstElementChild;
      expect(glass?.getAttribute("data-glass")).toBe("circle");
      expect(glass?.getAttribute("data-width")).toBe(String(size));
      expect(glass?.getAttribute("data-height")).toBe(String(size));
      expect(glass?.childElementCount).toBe(1);
      expect(glass?.firstElementChild?.getAttribute("data-symbol")).toBe(symbol);
    }
    // Hanging up is a solid red fill, never glass.
    expect(button("End call")?.querySelector("[data-glass]")).toBeNull();
  });

  it("keeps the call on screen until its closing motion ends, then leaves the chat", async () => {
    await startOnScreen(callDeps());
    motion.hold = true;
    press("End call");
    // The session is over at once (screen may sleep again), but the view is still fading out.
    expect(activeTags.has("rakazo-call")).toBe(false);
    expect(container.textContent).toContain("Ada");
    expect(motion.pending).toHaveLength(1);
    finishMotion();
    expect(container.childElementCount).toBe(0);
  });

  it("slides the call away before it rests as a pill, and fades the pill out on hang-up", async () => {
    await startOnScreen(callDeps());
    motion.hold = true;
    press("Minimise call");
    // Both are up while the call moves out of the way of the pill.
    expect(button("Minimise call")).not.toBeNull();
    expect(button("On a call with Ada")).not.toBeNull();
    finishMotion();
    expect(button("Minimise call")).toBeNull();
    expect(button("On a call with Ada")).not.toBeNull();

    press("End call");
    expect(button("On a call with Ada")).not.toBeNull();
    finishMotion();
    expect(container.childElementCount).toBe(0);
  });

  it("shows both sides of the call in order, with the caller's words as they come", async () => {
    const mic: { handlers?: DictationHandlers } = {};
    let reply: (messageId: string, text: string, runId?: string) => void = () => undefined;
    await startOnScreen(
      callDeps({
        dictate: async (handlers) => {
          mic.handlers = handlers;
          return true;
        },
        send: async () => "run-1",
        // The reply keeps playing for the whole test.
        speak: () => new Promise<void>(() => undefined),
        watch: (_botId, onReply) => {
          reply = onReply;
          return vi.fn();
        },
      }),
    );
    expect(mic.handlers).toBeDefined();

    await act(async () => mic.handlers?.onInterim("how is the"));
    expect(container.textContent).toContain("how is the");

    await act(async () => {
      mic.handlers?.onFinal("how is the deploy going");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => reply("message-1", "It is green.", "run-1"));

    const text = container.textContent ?? "";
    expect(text.indexOf("how is the deploy going")).toBeGreaterThan(-1);
    expect(text.indexOf("It is green.")).toBeGreaterThan(text.indexOf("how is the deploy going"));
  });

  it("shows the muted state on the mic button and stops listening while muted", async () => {
    const signals: AbortSignal[] = [];
    await startOnScreen(
      callDeps({
        dictate: async (_handlers, signal) => {
          signals.push(signal);
          return true;
        },
      }),
    );
    expect(signals).toHaveLength(1);
    press("Mute");
    expect(button("Unmute")?.getAttribute("aria-pressed")).toBe("true");
    expect(signals[0]?.aborted).toBe(true);
    press("Unmute");
    expect(button("Mute")?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(signals).toHaveLength(2);
  });

  it("minimises to a pill that keeps the call running and opens it again", async () => {
    await startOnScreen(callDeps());
    press("Minimise call");
    expect(button("Minimise call")).toBeNull();
    expect(container.textContent).toContain("Ada");
    expect(activeTags.has("rakazo-call")).toBe(true);
    press("On a call with Ada");
    expect(button("Minimise call")).not.toBeNull();
  });

  it("switches audio output from call settings, starting on the earpiece", async () => {
    const speaker = vi.fn(async () => undefined);
    await startOnScreen(
      callDeps({ audio: { begin: async () => undefined, speaker, end: async () => undefined } }),
    );
    const output = () =>
      ((menu.actions[0]?.subactions ?? []) as Array<{ id: string; state: string }>).map(
        (action) => `${action.id}:${action.state}`,
      );
    expect(output()).toEqual(["earpiece:on", "speaker:off"]);
    act(() => menu.press("speaker"));
    expect(speaker).toHaveBeenLastCalledWith(true);
    expect(output()).toEqual(["earpiece:off", "speaker:on"]);
    act(() => menu.press("speaker"));
    expect(speaker).toHaveBeenCalledTimes(1);
    act(() => menu.press("earpiece"));
    expect(speaker).toHaveBeenLastCalledWith(false);
    expect(output()).toEqual(["earpiece:on", "speaker:off"]);
  });

  it("hides the transcript and opens voice settings over the chat from call settings", async () => {
    let reply: (messageId: string, text: string, runId?: string) => void = () => undefined;
    await startOnScreen(
      callDeps({
        speak: () => new Promise<void>(() => undefined),
        watch: (_botId, onReply) => {
          reply = onReply;
          return vi.fn();
        },
      }),
    );
    await act(async () => reply("message-1", "Hello there.", undefined));
    expect(container.textContent).toContain("Hello there.");
    act(() => menu.press("transcript"));
    expect(container.textContent).not.toContain("Hello there.");
    act(() => menu.press("voice"));
    expect(push).toHaveBeenCalledWith("/voice");
    expect(button("On a call with Ada")).not.toBeNull();
  });

  it("counts the call's elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await startOnScreen(callDeps());
    expect(container.textContent).toContain("0:00");
    await act(async () => vi.advanceTimersByTime(21_000));
    expect(container.textContent).toContain("0:21");
  });
});
