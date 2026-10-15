import { describe, expect, it } from "vitest";
import {
  CALL_UPWARD_STRETCH,
  callDragMinimizes,
  callDragOffset,
  callSlideDuration,
} from "./call-gesture";
import { MOTION_MS } from "./motion-config";

const HEIGHT = 800;

describe("callDragOffset", () => {
  it("follows the finger 1:1 downwards", () => {
    expect(callDragOffset(0)).toBe(0);
    expect(callDragOffset(120)).toBe(120);
  });

  it("resists upwards and never stretches past its limit", () => {
    expect(callDragOffset(-40)).toBeLessThan(0);
    expect(callDragOffset(-40)).toBeGreaterThan(-40);
    expect(callDragOffset(-10_000)).toBeGreaterThan(-CALL_UPWARD_STRETCH);
    expect(callDragOffset(-200)).toBeLessThan(callDragOffset(-100));
  });
});

describe("callDragMinimizes", () => {
  it("minimises past a quarter of the screen", () => {
    expect(callDragMinimizes(HEIGHT * 0.26, 0, HEIGHT)).toBe(true);
    expect(callDragMinimizes(HEIGHT * 0.24, 0, HEIGHT)).toBe(false);
  });

  it("minimises on a fast downward flick from a short drag", () => {
    expect(callDragMinimizes(40, 1_400, HEIGHT)).toBe(true);
    expect(callDragMinimizes(40, 600, HEIGHT)).toBe(false);
  });

  it("returns to place when the finger heads back up or the call was pulled upwards", () => {
    expect(callDragMinimizes(HEIGHT * 0.4, -600, HEIGHT)).toBe(false);
    expect(callDragMinimizes(-20, 2_000, HEIGHT)).toBe(false);
    expect(callDragMinimizes(0, 2_000, HEIGHT)).toBe(false);
  });
});

describe("callSlideDuration", () => {
  it("uses the regular pace for a tap and never runs longer", () => {
    expect(callSlideDuration(HEIGHT, 0, HEIGHT)).toBe(MOTION_MS.sheetOut);
    expect(callSlideDuration(HEIGHT, 50, HEIGHT)).toBe(MOTION_MS.sheetOut);
  });

  it("carries a flick's speed, within the quickest the call may move", () => {
    const flicked = callSlideDuration(HEIGHT * 0.6, 2_500, HEIGHT);
    expect(flicked).toBeLessThan(MOTION_MS.sheetOut);
    expect(flicked).toBeGreaterThanOrEqual(MOTION_MS.sheetOutMin);
    expect(callSlideDuration(10, 9_000, HEIGHT)).toBe(MOTION_MS.sheetOutMin);
    expect(callSlideDuration(0, 0, HEIGHT)).toBe(MOTION_MS.sheetOutMin);
  });
});
