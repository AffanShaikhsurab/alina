import { describe, expect, it, vi } from "vitest";
import type { BezierCurve } from "./motion-config";
import { EASE_IN_OUT, EASE_OUT, MOTION_MS } from "./motion-config";

/** True when the curve stays within its start and end values for the whole animation. */
function curveNeverOvershoots([x1, y1, x2, y2]: BezierCurve): boolean {
  const unit = (value: number) => value >= 0 && value <= 1;
  return unit(x1) && unit(y1) && unit(x2) && unit(y2);
}

// Records every modifier the shared presets are built with, and every animation they call.
const calls = vi.hoisted(() => [] as string[]);

vi.mock("react-native-reanimated", () => {
  const builder = (name: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        return (..._args: unknown[]) => {
          calls.push(`${name}.${key}`);
          return builder(name);
        };
      },
    });
  return {
    default: { View: () => null },
    Easing: { bezier: (...points: number[]) => ({ bezier: points }) },
    FadeIn: builder("FadeIn"),
    FadeInDown: builder("FadeInDown"),
    FadeOut: builder("FadeOut"),
    LinearTransition: builder("LinearTransition"),
    LayoutAnimationConfig: () => null,
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => {
      calls.push("withTiming");
      return value;
    },
    withSpring: (value: number) => {
      calls.push("withSpring");
      return value;
    },
  };
});
vi.mock("react-native", () => ({ Pressable: () => null }));

describe("motion", () => {
  it("uses curves that settle once, without passing their target", () => {
    expect(curveNeverOvershoots(EASE_OUT)).toBe(true);
    expect(curveNeverOvershoots(EASE_IN_OUT)).toBe(true);
    expect(curveNeverOvershoots([0.34, 1.56, 0.64, 1])).toBe(false);
  });

  it("keeps every duration short enough to feel direct", () => {
    for (const duration of Object.values(MOTION_MS)) {
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(320);
    }
  });

  it("builds every shared preset as a timed curve, never a spring", async () => {
    const motion = await import("../components/motion");
    expect(motion.popoverEntering).toBeDefined();
    expect(calls.some((call) => call.endsWith(".duration"))).toBe(true);
    expect(calls.some((call) => call.endsWith(".easing"))).toBe(true);
    for (const banned of ["springify", "damping", "stiffness", "mass", "withSpring"]) {
      expect(calls.filter((call) => call.includes(banned))).toEqual([]);
    }
  });
});
