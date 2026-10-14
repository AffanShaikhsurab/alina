import { describe, expect, it } from "vitest";
import { arrivingKeys } from "./message-motion";

describe("arrivingKeys", () => {
  it("animates nothing on first load", () => {
    expect(arrivingKeys(null, ["m1", "m2"])).toEqual([]);
    expect(arrivingKeys([], ["m1", "m2"])).toEqual([]);
  });

  it("animates a sent message and the reply that starts streaming after it", () => {
    expect(arrivingKeys(["m1", "m2"], ["m1", "m2", "m3"])).toEqual(["m3"]);
    expect(arrivingKeys(["m1", "m2", "m3"], ["m1", "m2", "m3", "progress:run-1"])).toEqual([
      "progress:run-1",
    ]);
  });

  it("keeps the final reply still when it replaces the streaming row", () => {
    expect(arrivingKeys(["m1", "progress:run-1"], ["m1", "m4"])).toEqual([]);
  });

  it("never animates an older page or a catch-up burst", () => {
    expect(arrivingKeys(["m3", "m4"], ["m1", "m2", "m3", "m4"])).toEqual([]);
    expect(arrivingKeys(["m1"], ["m1", "m2", "m3", "m4", "m5"])).toEqual([]);
  });

  it("animates nothing when the rows share nothing, like a switched thread", () => {
    expect(arrivingKeys(["a1", "a2"], ["b1", "b2"])).toEqual([]);
  });

  it("does nothing when only existing rows changed", () => {
    expect(arrivingKeys(["m1", "m2"], ["m1", "m2"])).toEqual([]);
  });
});
