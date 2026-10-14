import { describe, expect, it } from "vitest";
import { callClock, callPresence, voiceChatClock } from "./call-screen";

describe("callClock", () => {
  it("counts minutes and seconds, then hours", () => {
    expect(callClock(0)).toBe("0:00");
    expect(callClock(8_400)).toBe("0:08");
    expect(callClock(21_000)).toBe("0:21");
    expect(callClock(12 * 60_000 + 40_000)).toBe("12:40");
    expect(callClock(3_723_000)).toBe("1:02:03");
    expect(callClock(-500)).toBe("0:00");
  });
});

describe("voiceChatClock", () => {
  it("shows a finished call as mm:ss", () => {
    expect(voiceChatClock(21)).toBe("00:21");
    expect(voiceChatClock(760)).toBe("12:40");
    expect(voiceChatClock(3723)).toBe("1:02:03");
  });
});

describe("callPresence", () => {
  it("shows the dots while listening or thinking, the avatar while speaking or muted", () => {
    expect(callPresence({ phase: "listening", muted: false })).toBe("dots");
    expect(callPresence({ phase: "thinking", muted: false })).toBe("dots");
    expect(callPresence({ phase: "thinking", muted: true })).toBe("dots");
    expect(callPresence({ phase: "speaking", muted: false })).toBe("avatar");
    expect(callPresence({ phase: "listening", muted: true })).toBe("avatar");
  });
});
