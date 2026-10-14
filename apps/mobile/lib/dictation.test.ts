import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginCallAudio, callRecognizerCategory, endCallAudio, setCallSpeaker } from "./call-audio";
import type { SpeechRecognizer } from "./dictation";
import { ENDPOINT_SILENCE_MS, listen, setSpeechRecognizer, stop } from "./dictation";

vi.mock("expo-audio", () => ({ setAudioModeAsync: vi.fn(async () => undefined) }));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: { setCategoryIOS: vi.fn(), setAudioSessionActiveIOS: vi.fn() },
}));

type Listener = (payload: never) => void;

/** Longest restart delay the module backs off to. */
const RESTART_CAP_MS = 2_000;

function fakeRecognizer() {
  const listeners = new Map<string, Set<Listener>>();
  const start = vi.fn();
  const abort = vi.fn();
  const recognizer: SpeechRecognizer = {
    start,
    stop: vi.fn(),
    abort,
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    addListener: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as Listener);
      listeners.set(event, set);
      return {
        remove: () => {
          set.delete(listener as Listener);
        },
      };
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])])
      (listener as (p: unknown) => void)(payload);
  };
  return {
    recognizer,
    start,
    abort,
    hear: (transcript: string, isFinal = false) =>
      emit("result", { isFinal, results: [{ transcript, confidence: 0.9 }] }),
    end: () => emit("end", null),
    fail: (error: string) => emit("error", { error, message: error }),
  };
}

let fake: ReturnType<typeof fakeRecognizer>;

beforeEach(() => {
  vi.useFakeTimers();
  fake = fakeRecognizer();
  setSpeechRecognizer(fake.recognizer);
});

afterEach(() => {
  stop();
  setSpeechRecognizer(null);
  vi.useRealTimers();
});

describe("mobile dictation", () => {
  it("ends the turn only after the silence window, not on the recognizer's own final", async () => {
    const onFinal = vi.fn();
    const interims: string[] = [];
    await listen({ onFinal, onInterim: (text) => interims.push(text) });
    expect(fake.start).toHaveBeenCalledWith({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    });

    fake.hear("how is the");
    fake.hear("how is the", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 400);
    expect(onFinal).not.toHaveBeenCalled();

    fake.hear("deploy going");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("how is the deploy going");
    expect(interims).toEqual(["how is the", "how is the", "how is the deploy going"]);
  });

  it("restarts a session that ended mid-turn and carries the words already heard", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("hello there");

    fake.end();
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);

    fake.hear("friend");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);
    expect(onFinal).toHaveBeenCalledWith("hello there friend");
  });

  it("gives up after restarts that hear nothing", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("half a sentence");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("half a sentence");
  });

  it("never finalizes an aborted session", async () => {
    const onFinal = vi.fn();
    const controller = new AbortController();
    await listen({ onFinal, signal: controller.signal });
    fake.hear("cancel this");

    controller.abort();
    expect(fake.abort).toHaveBeenCalled();
    fake.hear("and this", true);
    fake.end();
    vi.advanceTimersByTime(10_000);

    expect(onFinal).not.toHaveBeenCalled();
  });

  it("ends the turn on a permission error instead of hanging on the mic", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("open the door");
    fake.fail("not-allowed");
    expect(onFinal).toHaveBeenCalledWith("open the door");
  });

  it("starts every recognizer session in the call's audio session", async () => {
    const iosCategory = {
      category: "playAndRecord" as const,
      categoryOptions: ["allowBluetooth" as const],
      mode: "voiceChat" as const,
    };
    await listen({ onFinal: vi.fn(), iosCategory: () => iosCategory });
    expect(fake.start).toHaveBeenLastCalledWith({
      lang: "en-US",
      interimResults: true,
      continuous: true,
      iosCategory,
    });

    fake.end();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(fake.start).toHaveBeenLastCalledWith(expect.objectContaining({ iosCategory }));
  });

  it("keeps a Speaker toggle made mid-listen when the recognizer restarts", async () => {
    await beginCallAudio();
    await listen({ onFinal: vi.fn(), iosCategory: callRecognizerCategory });
    expect(fake.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        iosCategory: expect.objectContaining({ categoryOptions: ["allowBluetooth"] }),
      }),
    );

    await setCallSpeaker(true);
    fake.end();
    vi.advanceTimersByTime(250);

    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(fake.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        iosCategory: expect.objectContaining({
          categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
        }),
      }),
    );
    await endCallAudio();
  });

  it("says it went idle when restarts hear nothing at all, instead of going silent", async () => {
    const onFinal = vi.fn();
    const onIdle = vi.fn();
    await listen({ onFinal, onIdle });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(fake.abort).toHaveBeenCalled();
  });

  it("reports a fatal error that arrives before any words", async () => {
    const onFinal = vi.fn();
    const onIdle = vi.fn();
    const onError = vi.fn();
    await listen({ onFinal, onIdle, onError });
    fake.fail("audio-capture");
    expect(onError).toHaveBeenCalledWith("audio-capture");
    expect(onFinal).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stays quiet about an aborted session", async () => {
    const onIdle = vi.fn();
    const controller = new AbortController();
    await listen({ onFinal: vi.fn(), onIdle, signal: controller.signal });
    controller.abort();
    fake.end();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
