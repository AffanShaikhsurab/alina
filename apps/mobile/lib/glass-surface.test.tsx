// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassSurface } from "../components/glass-surface.ios";

const native = vi.hoisted(() => ({
  glass: true,
  hosts: [] as Array<Record<string, unknown>>,
  absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
}));

vi.mock("@expo/ui/swift-ui", () => {
  const shape = (name: string) => () => createElement("b", { "data-shape": name });
  return {
    Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
      native.hosts.push(props);
      return createElement("div", { "data-host": true }, props.children);
    },
    Circle: shape("circle"),
    Capsule: shape("capsule"),
    RoundedRectangle: shape("roundedRectangle"),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  foregroundStyle: () => ({}),
  glassEffect: () => ({}),
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => native.glass }));
vi.mock("react-native", () => {
  const flat = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flat))
      : style && typeof style === "object"
        ? (style as Record<string, unknown>)
        : {};
  return {
    View: ({ style, children }: { style?: unknown; children?: ReactNode }) =>
      createElement("div", { "data-style": JSON.stringify(flat(style)) }, children),
    StyleSheet: { absoluteFill: native.absoluteFill },
  };
});

describe("GlassSurface on iOS", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    native.glass = true;
    native.hosts.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("fills its box with glass that ignores safe areas, with the content centred on top", () => {
    act(() =>
      root.render(
        <GlassSurface
          shape="circle"
          colorScheme="dark"
          style={[
            { width: 56, height: 56 },
            { alignItems: "center", justifyContent: "center" },
          ]}
        >
          <i data-icon />
        </GlassSurface>,
      ),
    );
    const box = container.firstElementChild;
    expect(JSON.parse(box?.getAttribute("data-style") ?? "{}")).toEqual({
      width: 56,
      height: 56,
      alignItems: "center",
      justifyContent: "center",
    });
    // The glass and the content are siblings in that one box: the glass behind, sized to it.
    expect(box?.children[0]?.getAttribute("data-host")).not.toBeNull();
    expect(box?.children[1]?.hasAttribute("data-icon")).toBe(true);
    const host = native.hosts.at(-1);
    expect(host?.style).toBe(native.absoluteFill);
    expect(host?.ignoreSafeArea).toBe("all");
    expect(host?.pointerEvents).toBe("none");
    expect(host?.colorScheme).toBe("dark");
    expect(box?.querySelector('[data-shape="circle"]')).not.toBeNull();
  });

  it("draws the flat fallback in the same box before iOS 26", () => {
    native.glass = false;
    act(() =>
      root.render(
        <GlassSurface style={{ width: 44, height: 44 }} fallbackStyle={{ borderRadius: 22 }}>
          <i data-icon />
        </GlassSurface>,
      ),
    );
    const box = container.firstElementChild;
    expect(JSON.parse(box?.getAttribute("data-style") ?? "{}")).toEqual({
      width: 44,
      height: 44,
      borderRadius: 22,
    });
    expect(native.hosts).toHaveLength(0);
    expect(box?.firstElementChild?.hasAttribute("data-icon")).toBe(true);
  });
});
