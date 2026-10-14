// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createElement, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadComposerHandle } from "../components/thread-composer";
import { ThreadComposer } from "../components/thread-composer";
import { settleComposer } from "./thread-feedback";

const input = vi.hoisted(() => ({
  change: (_value: string) => {},
  key: (_event: { nativeEvent: { key: string } }) => {},
}));
const models = vi.hoisted(() => ({
  state: {
    bot: { thinkingLevel: "high" } as { thinkingLevel: string | null } | null,
    loaded: true,
    loadError: null as string | null,
    selectedKey: "anthropic::claude",
    modelChoices: [
      { key: "", label: "Space default" },
      { key: "anthropic::claude", label: "Claude Sonnet" },
      { key: "openrouter::kimi-k2", label: "Kimi K2" },
      { key: "openrouter::kimi-dev", label: "Kimi Dev" },
    ],
    levelsFor: (_key: string): string[] => ["low", "high"],
    save: async (_input: unknown): Promise<unknown> => ({ ok: true, latest: true }),
  },
  loads: [] as number[],
}));
const api = vi.hoisted(() => ({
  rpc: async (_path: string, _body?: unknown): Promise<unknown> => ({}),
}));
vi.mock("./use-bot-model", () => ({
  useBotModel: (_botId: string | undefined, loadKey: number) => {
    models.loads.push(loadKey);
    return models.state;
  },
}));
vi.mock("./api", () => ({ rpc: (path: string, body?: unknown) => api.rpc(path, body) }));
vi.mock("./haptics", () => ({
  selectionHaptic: vi.fn(),
  tapHaptic: vi.fn(),
  successHaptic: vi.fn(),
  errorHaptic: vi.fn(),
}));
vi.mock("react-native", () => {
  const Surface = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: Surface,
    ScrollView: Surface,
    Text: Surface,
    ActivityIndicator: () => createElement("div", { "data-testid": "busy" }),
    StyleSheet: { hairlineWidth: 0.5 },
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
      disabled,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel: string;
      accessibilityState?: { selected?: boolean };
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-pressed": accessibilityState?.selected,
          disabled,
        },
        children,
      ),
    TextInput: ({
      value,
      onChangeText,
      onKeyPress,
    }: {
      value: string;
      onChangeText: typeof input.change;
      onKeyPress: typeof input.key;
    }) => {
      input.change = onChangeText;
      input.key = onKeyPress;
      return createElement("input", { value, readOnly: true });
    },
  };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/glass-surface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/motion", async () => {
  const { createElement: h } = await import("react");
  const Pass = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    MotionView: Pass,
    LayoutAnimationConfig: Pass,
    popoverEntering: undefined,
    popoverExiting: undefined,
    popoverLayout: undefined,
    quietEntering: undefined,
    quietExiting: undefined,
    PressScale: ({
      children,
      onPress,
      accessibilityLabel,
      disabled,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel: string;
      disabled?: boolean;
    }) =>
      h(
        "button",
        { type: "button", onClick: onPress, "aria-label": accessibilityLabel, disabled },
        children,
      ),
  };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? `{${key}}`);
  return { t, useI18n: () => ({ t }) };
});

const skill = {
  id: "skill-1",
  name: "Writing",
  description: "Write",
  source: "user",
  readOnly: false,
} as const;
const bot = { kind: "bot", id: "bot-2", name: "Helper" } as const;
const props: Omit<ComponentProps<typeof ThreadComposer>, "ref"> = {
  agentSkills: [skill],
  composerMentionTargets: [bot],
  composerPrompt: "Message…",
  replyQuote: null,
  attachmentIds: [],
  botId: "bot-1",
  onCall: false,
  working: false,
  sending: false,
  styles: { circleButton: {}, composerFill: {} },
  attachActions: [],
  attachFrom: vi.fn(),
  send: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  startVoiceCall: vi.fn(async () => {}),
  onSlashAction: vi.fn(),
  openModelSheet: vi.fn(),
};

describe("thread composer isolation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let threadRenders: number;
  const composer = createRef<ThreadComposerHandle>();
  function ThreadHarness({
    threadKey = "bot-1",
    ...changes
  }: Partial<typeof props> & { threadKey?: string }) {
    threadRenders += 1;
    return <ThreadComposer key={threadKey} ref={composer} {...props} {...changes} />;
  }
  function render(changes: Partial<typeof props> & { threadKey?: string } = {}) {
    act(() => root.render(<ThreadHarness {...changes} />));
  }
  function type(value: string) {
    act(() => input.change(value));
  }
  function press(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    act(() => button.click());
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    threadRenders = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("types 20 characters without rendering the parent and sends the latest ref snapshot", () => {
    const mounted = threadRenders;
    const text = "abcdefghijklmnopqrst";
    for (let length = 1; length <= text.length; length += 1) type(text.slice(0, length));
    expect(threadRenders - mounted).toBe(0);
    expect(container.querySelector("input")!.value).toBe(text);
    expect(composer.current!.snapshot().promptText).toBe(text);
    press("Send");
    expect(props.send).toHaveBeenCalledOnce();
  });

  it("preserves draft across reply, attachment, and sending updates and resets on thread switch", () => {
    type("Draft");
    render({
      replyTargetId: "reply-1",
      replyQuote: "Quote",
      attachmentIds: ["attachment-1"],
      sending: true,
    });
    expect(composer.current!.snapshot()).toMatchObject({
      promptText: "Draft",
      replyTargetId: "reply-1",
      replyQuote: "Quote",
      attachmentIds: ["attachment-1"],
    });
    render({ threadKey: "bot-2" });
    expect(composer.current!.snapshot()).toMatchObject({
      promptText: "",
      mentions: [],
      skill: null,
    });
    expect(container.querySelector("input")!.value).toBe("");
  });

  it("keeps edits during send and clears an unchanged composition, including popovers", () => {
    type("Submitted");
    const submitted = composer.current!.snapshot();
    render({ sending: true });
    type("Dictated replacement @He");
    expect(container.querySelector('[data-testid="mention-picker"]')).not.toBeNull();
    expect(settleComposer(submitted, composer.current!.snapshot()).clearComposer).toBe(false);
    const current = composer.current!.snapshot();
    expect(settleComposer(current, composer.current!.snapshot()).clearComposer).toBe(true);
    act(() => composer.current!.reset());
    expect(composer.current!.snapshot().promptText).toBe("");
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
  });

  it("selects mention and skill popovers and removes chips with backspace", () => {
    type("Hello @He");
    press("@Helper");
    expect(composer.current!.snapshot().mentions).toEqual([bot]);
    expect(container.querySelector("input")!.value).toBe("Hello ");
    expect(container.querySelector('[data-testid="mention-picker"]')).toBeNull();
    type("/Wri");
    press("Skill Writing");
    expect(composer.current!.snapshot().skill).toEqual(skill);
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
    act(() => input.key({ nativeEvent: { key: "Backspace" } }));
    expect(composer.current!.snapshot().mentions).toEqual([]);
    expect(composer.current!.snapshot().skill).toEqual(skill);
    act(() => input.key({ nativeEvent: { key: "Backspace" } }));
    expect(composer.current!.snapshot().skill).toBeNull();
  });

  it("clears a slash query before routing and uses the call control for an empty draft", () => {
    type("/settings");
    press("Chat Settings");
    expect(props.onSlashAction).toHaveBeenCalledWith("chat-settings");
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
    press("Call");
    expect(props.startVoiceCall).toHaveBeenCalledOnce();
  });

  function rowLabels(testId: string) {
    return [
      ...container.querySelectorAll<HTMLButtonElement>(`[data-testid="${testId}"] button`),
    ].map((button) => button.getAttribute("aria-label"));
  }
  function button(label: string) {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  }

  it("lists commands first, then skills, then settings, and filters as you type", () => {
    type("/");
    expect(rowLabels("slash-picker")).toEqual([
      "Model",
      "Compact",
      "Context",
      "Skill Writing",
      "Chat Settings",
      "Settings: General",
      "Settings: Usage",
    ]);
    type("/mo");
    expect(rowLabels("slash-picker")).toEqual(["Model"]);
    type("/co");
    expect(rowLabels("slash-picker")).toEqual(["Compact", "Context"]);
  });

  it("offers no chat commands in a group thread", () => {
    render({ botId: undefined });
    type("/");
    expect(rowLabels("slash-picker")).not.toContain("Model");
    expect(rowLabels("slash-picker")).toContain("Skill Writing");
  });

  it("turns the popup into the model list, checks the current model and filters it", () => {
    type("/");
    press("Model");
    expect(container.querySelector("input")!.value).toBe("/model ");
    expect(models.loads.at(-1)).toBeGreaterThan(0);
    expect(rowLabels("slash-picker")).toEqual([
      "Space default",
      "Claude Sonnet",
      "Kimi K2",
      "Kimi Dev",
    ]);
    expect(button("Claude Sonnet")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Kimi K2")!.getAttribute("aria-pressed")).toBe("false");
    type("/model kimi");
    expect(rowLabels("slash-picker")).toEqual(["Kimi K2", "Kimi Dev"]);
    type("/model kimi k2");
    expect(rowLabels("slash-picker")).toEqual(["Kimi K2"]);
  });

  it("switches the model through the bot update, keeps thinking, clears and confirms", async () => {
    const save = vi.spyOn(models.state, "save");
    type("/model kimi");
    await act(async () => button("Kimi K2")!.click());
    expect(save).toHaveBeenCalledWith({
      botId: "bot-1",
      modelProvider: "openrouter",
      modelId: "kimi-k2",
      thinkingLevel: "high",
    });
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelector('[data-testid="slash-picker"]')).toBeNull();
    expect(container.textContent).toContain("Now using Kimi K2");
    expect(props.send).not.toHaveBeenCalled();
  });

  it("shows the save error when the switch fails", async () => {
    vi.spyOn(models.state, "save").mockResolvedValueOnce({
      ok: false,
      latest: true,
      error: "Could not save model",
    });
    type("/model ");
    await act(async () => button("Kimi Dev")!.click());
    expect(container.textContent).toContain("Could not save model");
  });

  it("never sends a bare slash or an unknown command, but sends a slash mid-sentence", () => {
    type("/");
    expect(button("Send")!.disabled).toBe(true);
    press("Send");
    type("/shrug");
    expect(button("Send")!.disabled).toBe(true);
    press("Send");
    expect(props.send).not.toHaveBeenCalled();
    expect(container.querySelector("input")!.value).toBe("/shrug");
    type("try a / here");
    press("Send");
    expect(props.send).toHaveBeenCalledOnce();
  });

  it("holds Send on a /model query that fits no model or several, and says so when none fit", () => {
    type("/model gemini");
    expect(rowLabels("slash-picker")).toEqual([]);
    expect(container.textContent).toContain("No matching models");
    expect(button("Send")!.disabled).toBe(true);
    type("/model kimi");
    expect(button("Send")!.disabled).toBe(true);
    press("Send");
    expect(props.send).not.toHaveBeenCalled();
  });

  it("picks a /model query sent before the list loaded once it lands", async () => {
    const save = vi.spyOn(models.state, "save");
    models.state.loaded = false;
    try {
      type("/model kimi k2");
      await act(async () => button("Send")!.click());
      expect(save).not.toHaveBeenCalled();
      expect(props.send).not.toHaveBeenCalled();
      models.state.loaded = true;
      render();
      await act(async () => {});
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelId: "kimi-k2" }));
    } finally {
      models.state.loaded = true;
    }
  });

  it("holds an unknown command beside a mention, and sends one while skills are unknown", () => {
    type("Hi @He");
    press("@Helper");
    type("/shrug");
    expect(button("Send")!.disabled).toBe(true);
    render({ agentSkillsLoaded: false });
    type("/my-skill run it");
    press("Send");
    expect(props.send).toHaveBeenCalledOnce();
  });

  it("runs a typed command on Send instead of sending it", async () => {
    type("/context");
    press("Send");
    expect(props.openModelSheet).toHaveBeenCalledOnce();
    expect(container.querySelector("input")!.value).toBe("");
    type("/model kimi k2");
    const save = vi.spyOn(models.state, "save");
    await act(async () => button("Send")!.click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelId: "kimi-k2" }));
    expect(props.send).not.toHaveBeenCalled();
  });

  it("compacts from /compact and shows an older server's error without crashing", async () => {
    const calls: string[] = [];
    api.rpc = async (path) => {
      calls.push(path);
      if (path === "threads/compact") return { queued: false, throughSeq: null };
      return {};
    };
    type("/compact");
    await act(async () => button("Send")!.click());
    expect(calls).toEqual(["threads/compact"]);
    expect(container.textContent).toContain("Nothing new to compact");
    expect(props.send).not.toHaveBeenCalled();

    api.rpc = async () => {
      throw new Error("Not found");
    };
    type("/");
    await act(async () => button("Compact")!.click());
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.textContent).toMatch(/Not found|Could not compact/);
  });
});
