import { setAudioModeAsync } from "expo-audio";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginCallAudio,
  callRecognizerCategory,
  endCallAudio,
  isCallAudioActive,
  isCallSpeakerOn,
  PLAYBACK_AUDIO_MODE,
  reassertCallAudio,
  setCallSpeaker,
} from "./call-audio";

vi.mock("expo-audio", () => ({ setAudioModeAsync: vi.fn(async () => undefined) }));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    setCategoryIOS: vi.fn(),
    setAudioSessionActiveIOS: vi.fn(),
  },
}));

const recognizer = vi.mocked(ExpoSpeechRecognitionModule);
const earpiece = {
  category: "playAndRecord",
  categoryOptions: ["allowBluetooth"],
  mode: "voiceChat",
};
const loudspeaker = {
  category: "playAndRecord",
  categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
  mode: "voiceChat",
};

beforeEach(() => {
  vi.mocked(setAudioModeAsync).mockClear();
  recognizer.setCategoryIOS.mockClear();
  recognizer.setAudioSessionActiveIOS.mockClear();
});

afterEach(async () => {
  await endCallAudio();
});

describe("call audio session", () => {
  it("holds one earpiece voice-chat session from the start of the call", async () => {
    await beginCallAudio();

    expect(isCallAudioActive()).toBe(true);
    expect(isCallSpeakerOn()).toBe(false);
    expect(setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: true,
      allowsRecording: true,
      interruptionMode: "doNotMix",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: true,
    });
    expect(recognizer.setCategoryIOS).toHaveBeenCalledWith(earpiece);
    expect(recognizer.setAudioSessionActiveIOS).toHaveBeenCalledWith(true);
    expect(callRecognizerCategory()).toEqual(earpiece);
  });

  it("moves to the loudspeaker and back without leaving the call session", async () => {
    await beginCallAudio();
    vi.mocked(setAudioModeAsync).mockClear();

    await setCallSpeaker(true);
    expect(isCallSpeakerOn()).toBe(true);
    expect(setAudioModeAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowsRecording: true, shouldRouteThroughEarpiece: false }),
    );
    expect(recognizer.setCategoryIOS).toHaveBeenLastCalledWith(loudspeaker);
    expect(callRecognizerCategory()).toEqual(loudspeaker);

    await setCallSpeaker(false);
    expect(setAudioModeAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowsRecording: true, shouldRouteThroughEarpiece: true }),
    );
    expect(recognizer.setCategoryIOS).toHaveBeenLastCalledWith(earpiece);
  });

  it("puts voice chat back after the recorder resets the mode", async () => {
    await beginCallAudio();
    recognizer.setCategoryIOS.mockClear();
    vi.mocked(setAudioModeAsync).mockClear();

    await reassertCallAudio();

    expect(recognizer.setCategoryIOS).toHaveBeenCalledWith(earpiece);
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  });

  it("restores normal playback and releases the session when the call ends", async () => {
    await beginCallAudio();
    await setCallSpeaker(true);

    await endCallAudio();

    expect(isCallAudioActive()).toBe(false);
    expect(isCallSpeakerOn()).toBe(false);
    expect(callRecognizerCategory()).toBeUndefined();
    expect(setAudioModeAsync).toHaveBeenLastCalledWith({
      ...PLAYBACK_AUDIO_MODE,
      allowsRecording: false,
    });
    expect(recognizer.setAudioSessionActiveIOS).toHaveBeenLastCalledWith(false, {
      notifyOthersOnDeactivation: true,
    });
  });

  it("does nothing to the session outside a call", async () => {
    await setCallSpeaker(true);
    await reassertCallAudio();
    await endCallAudio();

    expect(setAudioModeAsync).not.toHaveBeenCalled();
    expect(recognizer.setCategoryIOS).not.toHaveBeenCalled();
  });

  it("leaves a redialled call's session alone when the old call's teardown runs late", async () => {
    let releaseFirst!: () => void;
    vi.mocked(setAudioModeAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const first = beginCallAudio();
    const ended = endCallAudio();
    const second = beginCallAudio();
    await vi.waitFor(() => expect(setAudioModeAsync).toHaveBeenCalledOnce());
    releaseFirst();
    await Promise.all([first, ended, second]);

    expect(isCallAudioActive()).toBe(true);
    // The teardown step saw the new call and skipped: no playback mode, no deactivation.
    expect(setAudioModeAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: false }),
    );
    expect(recognizer.setAudioSessionActiveIOS).not.toHaveBeenCalledWith(false, expect.anything());
  });

  it("keeps the call routed when the voice-chat refinement is unavailable", async () => {
    recognizer.setCategoryIOS.mockImplementationOnce(() => {
      throw new Error("not supported");
    });

    await expect(beginCallAudio()).resolves.toBeUndefined();

    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ shouldRouteThroughEarpiece: true }),
    );
    expect(isCallAudioActive()).toBe(true);
  });
});
