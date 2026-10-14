import type { SetCategoryOptions } from "expo-speech-recognition";

/**
 * One phone-call audio session for the whole call. Without it every turn re-categorised
 * the iOS session (the recorder, each reply clip and each recognizer start all set their
 * own), which rerouted audio, clipped syllables and could take the microphone away from
 * the barge-in listener mid-reply.
 *
 * The call holds `.playAndRecord` + `.voiceChat`, on the earpiece by default and on the
 * loudspeaker when the caller turns the speaker on; headsets and Bluetooth take over the
 * way they do in a phone call. Android gets expo-audio's earpiece routing.
 */

/** What a reply read aloud outside a call uses; the call puts it back when it ends. */
export const PLAYBACK_AUDIO_MODE = {
  playsInSilentMode: true,
  interruptionMode: "mixWithOthers",
  shouldPlayInBackground: false,
} as const;

let active = false;
let speaker = false;
/** Session changes run one at a time, so hanging up and redialling cannot interleave. */
let chain: Promise<void> = Promise.resolve();

function enqueue(step: () => Promise<void>): Promise<void> {
  chain = chain.then(step).catch(() => undefined);
  return chain;
}

export function isCallAudioActive(): boolean {
  return active;
}

export function isCallSpeakerOn(): boolean {
  return active && speaker;
}

/** The category every recognizer start uses during a call, so it stops resetting the route. */
export function callRecognizerCategory(): SetCategoryOptions | undefined {
  if (!active) return undefined;
  return {
    category: "playAndRecord",
    categoryOptions: speaker ? ["defaultToSpeaker", "allowBluetooth"] : ["allowBluetooth"],
    mode: "voiceChat",
  };
}

export function beginCallAudio(): Promise<void> {
  active = true;
  speaker = false;
  return enqueue(async () => {
    if (active) await applyCallAudio(true);
  });
}

export function setCallSpeaker(on: boolean): Promise<void> {
  if (!active) return chain;
  speaker = on;
  return enqueue(async () => {
    if (active) await applyCallAudio(false);
  });
}

/** expo-audio's recorder resets the mode to `.default` each turn; put `.voiceChat` back. */
export function reassertCallAudio(): Promise<void> {
  return enqueue(async () => {
    if (active) await applyVoiceChat(false);
  });
}

export function endCallAudio(): Promise<void> {
  if (!active) return chain;
  active = false;
  speaker = false;
  return enqueue(async () => {
    // A new call started before this step ran: it owns the session now.
    if (active) return;
    const { setAudioModeAsync } = await import("expo-audio");
    await setAudioModeAsync({ ...PLAYBACK_AUDIO_MODE, allowsRecording: false });
    // Let the music the call paused carry on. iOS only; a no-op stub elsewhere.
    const recognizer = await loadRecognizer();
    try {
      recognizer?.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
    } catch {
      // Still busy with a closing recognizer: the next playback reconfigures it anyway.
    }
  });
}

async function applyCallAudio(activate: boolean): Promise<void> {
  const { setAudioModeAsync } = await import("expo-audio");
  await setAudioModeAsync({
    playsInSilentMode: true,
    allowsRecording: true,
    // A call pauses other audio, like a phone call does.
    interruptionMode: "doNotMix",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: !speaker,
  });
  await applyVoiceChat(activate);
}

async function applyVoiceChat(activate: boolean): Promise<void> {
  const category = callRecognizerCategory();
  if (!category) return;
  const recognizer = await loadRecognizer();
  if (!recognizer) return;
  try {
    // iOS only: the Android module exposes these as no-op stubs.
    recognizer.setCategoryIOS(category);
    if (activate) recognizer.setAudioSessionActiveIOS(true);
  } catch {
    // expo-audio already routed the call; `.voiceChat` is the refinement.
  }
}

type SessionModule = {
  setCategoryIOS(options: SetCategoryOptions): void;
  setAudioSessionActiveIOS(value: boolean, options?: { notifyOthersOnDeactivation: boolean }): void;
};

async function loadRecognizer(): Promise<SessionModule | null> {
  try {
    const { ExpoSpeechRecognitionModule } = await import("expo-speech-recognition");
    return ExpoSpeechRecognitionModule as unknown as SessionModule;
  } catch {
    return null;
  }
}
