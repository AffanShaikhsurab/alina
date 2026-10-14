import {
  ACTIVE_RUN_STATUSES,
  AiConsentBlocked,
  abortableDelay,
  callClientNonce,
  INTERIM_BARGE_IN_MS,
  isCallBargeIn,
  isFarewell,
  isInterimCallBargeIn,
  latestSpokenCallReply,
  spokenMemory,
} from "@rakazo/core";
import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { MobileSnapshot } from "./api";
import {
  applyMobileThreadEvent,
  blockText,
  captureApiRequestContext,
  rpc,
  subscribeThread,
} from "./api";
import {
  beginCallAudio,
  callRecognizerCategory,
  endCallAudio,
  reassertCallAudio,
  setCallSpeaker,
} from "./call-audio";
import type { CallCue } from "./call-sounds";
import {
  playCallCue,
  preloadWaitSound,
  releaseWaitSound,
  startWaitSound,
  stopWaitSound,
} from "./call-sounds";
import { loadTranscriptOpen, saveTranscriptOpen } from "./call-transcript";
import * as dictation from "./dictation";
import { getActiveUiLocale, t } from "./i18n";
import { errorText } from "./user-error";
import { speakText, stopSpeaking } from "./voice";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export type CallState = {
  botId: string;
  botName: string;
  botColor: string;
  phase: CallPhase;
  muted: boolean;
  /** Loudspeaker instead of the earpiece. Headsets and Bluetooth win either way. */
  speaker: boolean;
  transcriptOpen: boolean;
  caption: string;
  heard: string;
  /** The reply the bot is still writing, shown in the transcript before it is spoken. */
  draft: string;
  exchanges: CallExchange[];
};

export type CallClip = { base64: string; mimeType: string };

/** What one microphone session reports back: a running guess, then the finished turn. */
export type DictationHandlers = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  /** The session ended without hearing anything; the microphone is closed again. */
  onIdle?: () => void;
  /** The session failed before hearing anything; the microphone is closed again. */
  onError?: (code: string) => void;
};

/** The call's audio session: held from the first ring to the hang-up. */
export type CallAudio = {
  begin: () => Promise<void>;
  speaker: (on: boolean) => Promise<void>;
  end: () => Promise<void>;
};

/** Everything that touches the device or the server, so the loop stays testable. */
export type CallDeps = {
  /** On-device dictation for one turn. False when the device cannot recognise speech. */
  dictate: (handlers: DictationHandlers, signal: AbortSignal) => Promise<boolean>;
  /** Fallback when the device cannot: record a clip and send it to the voice provider. */
  record: (signal: AbortSignal) => Promise<CallClip | null>;
  transcribe: (clip: CallClip, signal: AbortSignal) => Promise<string>;
  /** The provider the server pins for transcription; every turn then goes to it. */
  pinnedTranscriber?: () => Promise<string | null>;
  /** Resolves with the run the message started, so only that run's reply is spoken. */
  send: (botId: string, text: string, clientNonce: string) => Promise<string | undefined>;
  /** Tells the server the caller hung up, so it files the call marker and the wrap-up run. */
  endCall: (botId: string, callId: string) => Promise<void>;
  speak: (botId: string, text: string) => Promise<void>;
  /** Cuts the reply off when the caller talks over it. */
  stopSpeaking: () => void;
  /** The opening cue as the call starts, the closing one once the caller's turn is heard. */
  cue: (cue: CallCue) => Promise<void>;
  /** The soft sound while the bot works on a turn: loaded at call start, freed at hang-up. */
  waitSound: (action: "preload" | "start" | "stop" | "release") => void;
  /** One phone-call audio session for the whole call; absent where nothing needs routing. */
  audio?: CallAudio;
  watch: (
    botId: string,
    onReply: (messageId: string, text: string, runId?: string) => void,
    onCallEnded: (ended: CallEnded) => void,
    /** The reply as the bot writes it, before its run settles and it is spoken. */
    onDraft?: (messageId: string, text: string, runId?: string) => void,
  ) => () => void;
};

/** The bot a caller asked to be put through to, and how to ring it once this call hangs up. */
export type CallSwitch = { name: string; ring: () => void };

/** What the bot's own `end_call` carries: the call it ends and the goodbye to speak. */
export type CallEnded = { callId?: string; farewell?: string };

/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
const FAREWELL_TIMEOUT_MS = 20_000;
/** A call that cannot reach the microphone or the server this many turns in a row hangs up. */
const MAX_TURN_FAILURES = 3;

/** A dropped live feed is reconnected from the last seq it saw, backing off as it retries. */
const FEED_RETRY_MIN_MS = 250;
const FEED_RETRY_MAX_MS = 5_000;

// ponytail: naive fixed-threshold endpointing on the fallback path only. Swap for a VAD
// model if rooms with steady background noise start cutting people off mid-sentence.
const SPEECH_LEVEL_DB = -35;
const SILENCE_HANG_MS = 1_200;
const METER_POLL_MS = 200;
const MAX_CLIP_MS = 30_000;
/** The pin lookup runs under the opening cue; past this the call keeps on-device recognition. */
const PIN_LOOKUP_TIMEOUT_MS = 5_000;

let state: CallState | null = null;
/** Shared by every message this call sends, so the thread can group one call's exchange. */
let callId = "";
/** Requests for this call that must persist before its server-side hang-up. */
const pendingCallSends = new Map<string, Set<Promise<unknown>>>();
/** The run this call's last turn started: replies to anything else are not spoken. */
let callRunId: string | null = null;
let deps: CallDeps = productionDeps();
let turn: AbortController | null = null;
let unwatch: (() => void) | null = null;
let hangUpAfterReply = false;
/** Caller farewell send already resolved; speech consent refuse can finish the hang-up. */
let farewellSent = false;
/** Disclosure was refused: do not start speech again until the caller unmutes. */
let consentBlocked = false;
/** The bot hung up itself: its farewell is the last thing this call speaks. */
let botEndedCall = false;
let hangUpTimer: ReturnType<typeof setTimeout> | null = null;
let spokenMessageId: string | null = null;
let failures = 0;
/** Counts the caller's turns, so a closing cue that ends late starts no waiting sound for a newer turn. */
let turnSeq = 0;
/** Whether the provider can transcribe, so the fallback path is worth trying at all. */
let canTranscribe = true;
/** Whether this device does its own speech recognition; unknown until the first turn. */
let onDevice: boolean | null = null;
/** The server pins a transcriber: every turn is recorded for it, the device only hears barge-ins. */
let serverTurns = false;
/** A microphone session is running, so playback can leave it open instead of restarting it. */
let micOpen = false;
/** True from ringing until the start cue ends: nothing may open the microphone before the greeting. */
let opening = false;
/** The caller cut the reply off: the speaker going idle must not reopen the microphone. */
let bargedIn = false;
/** Counting down a phrase heard over the reply, before it counts as cutting in. */
let interimTimer: ReturnType<typeof setTimeout> | null = null;
/** Takes over a turn that asks for another bot: the bot to hand over to, or nothing. */
let switchBot: ((text: string) => CallSwitch | undefined) | undefined;
let switching = false;
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  // The waiting sound belongs to "thinking" only: a reply, a retry, or a cut-in ends it.
  if (patch.phase && patch.phase !== "thinking" && state.phase === "thinking") {
    deps.waitSound("stop");
  }
  // So does a reply still being written: it is spoken, or abandoned, once thinking ends.
  if (patch.phase && patch.phase !== "thinking") patch = { draft: "", ...patch };
  state = { ...state, ...patch };
  emit();
}

export function startCall(
  // `transcribe` says whether the voice provider can turn audio into text; a speak-only
  // provider is fine as long as the device recognises speech itself.
  call: {
    botId: string;
    botName: string;
    botColor?: string;
    transcribe?: boolean;
    /** Spoken as the call connects, before the caller's first turn. */
    greeting?: string;
    /** Called with each finished turn; a target means the caller asked for that bot instead. */
    switchBot?: (text: string) => CallSwitch | undefined;
  },
  overrides: Partial<CallDeps> = {},
): string {
  endCall();
  deps = { ...productionDeps(), ...overrides };
  switchBot = call.switchBot;
  callId = randomId();
  callRunId = null;
  canTranscribe = call.transcribe ?? true;
  onDevice = null;
  serverTurns = false;
  micOpen = false;
  bargedIn = false;
  spokenMemory.clear();
  const pinned = (deps.pinnedTranscriber?.() ?? Promise.resolve(null)).catch(() => null);
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    phase: "listening",
    muted: false,
    speaker: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    draft: "",
    exchanges: [],
  };
  unwatch = deps.watch(call.botId, onReply, onCallEnded, onDraft);
  emit();
  const startedCallId = callId;
  // The transcript opens the way the caller left it on their last call.
  void loadTranscriptOpen()
    .then((open) => {
      if (open && state && callId === startedCallId) set({ transcriptOpen: true });
    })
    .catch(() => undefined);
  void openCall(callId, pinned, call.greeting);
  return callId;
}

/** The opening cue, then the greeting, then the caller's first turn. */
async function openCall(
  openedCallId: string,
  pinned: Promise<string | null>,
  greeting?: string,
): Promise<void> {
  deps.waitSound("preload");
  opening = true;
  // The call's audio session is in place before the first sound, so even the ring is on
  // the earpiece and nothing reroutes mid-call.
  await deps.audio?.begin().catch(() => undefined);
  if (!state || callId !== openedCallId) return;
  await deps.cue("start").catch(() => undefined);
  const transcriber = await pinned;
  if (!state || callId !== openedCallId) return;
  opening = false;
  if (transcriber) {
    serverTurns = true;
    canTranscribe = true;
  }
  if (greeting) speakAndListen(greeting);
  else void listen();
}

/** A background voice/status result can enable provider fallback after the call has started. */
export function setCallProviderTranscribe(enabled: boolean, forCallId?: string): void {
  if (!state || (forCallId !== undefined && forCallId !== callId)) return;
  canTranscribe = enabled;
  // Dictation can fail before the probe returns, which leaves the mic closed.
  if (enabled && !opening && state.phase === "listening" && !micOpen && !state.muted) void listen();
}

export function endCall(): void {
  // The bot's own end_call already closed the call server-side; only a caller hang-up
  // has to say so. Fire and forget: the card is going away either way.
  if (state && !botEndedCall) {
    const { botId } = state;
    const closingCallId = callId;
    const closeServerCall = deps.endCall;
    const pendingSends = [...(pendingCallSends.get(closingCallId) ?? [])];
    // The server checks durable user messages, so its close must follow an in-flight write.
    if (pendingSends.length === 0)
      void closeServerCall(botId, closingCallId).catch(() => undefined);
    else
      void Promise.allSettled(pendingSends)
        .then(() => closeServerCall(botId, closingCallId))
        .catch(() => undefined);
  }
  if (state) {
    deps.waitSound("release");
    void deps.audio?.end().catch(() => undefined);
  }
  turn?.abort();
  turn = null;
  unwatch?.();
  unwatch = null;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = null;
  hangUpAfterReply = false;
  farewellSent = false;
  consentBlocked = false;
  botEndedCall = false;
  callRunId = null;
  spokenMessageId = null;
  failures = 0;
  serverTurns = false;
  micOpen = false;
  opening = false;
  bargedIn = false;
  switchBot = undefined;
  switching = false;
  clearInterim();
  spokenMemory.clear();
  if (!state) return;
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  if (muted) {
    turn?.abort();
    turn = null;
    micOpen = false;
    clearInterim();
    return;
  }
  consentBlocked = false;
  if (state.phase === "listening" && !opening) void listen();
}

export function toggleTranscript(): void {
  if (!state) return;
  const transcriptOpen = !state.transcriptOpen;
  set({ transcriptOpen });
  void saveTranscriptOpen(transcriptOpen).catch(() => undefined);
}

/** Moves the call between the earpiece and the loudspeaker, without touching the turn. */
export function toggleSpeaker(): void {
  if (!state) return;
  const speaker = !state.speaker;
  set({ speaker });
  void deps.audio?.speaker(speaker).catch(() => undefined);
}

async function listen(): Promise<void> {
  if (!state) return;
  // The caller said goodbye: every path back to listening hangs up instead.
  if (hangUpAfterReply) {
    endCall();
    return;
  }
  set({ phase: "listening", heard: "", caption: "" });
  if (state.muted) return;
  if (serverTurns) {
    // The device session that watched the reply for a barge-in must not take the turn.
    turn?.abort();
    turn = null;
    micOpen = false;
    clearInterim();
  }
  await openMic();
}

/** Opens one microphone session, unless one is already running or the call is muted. */
async function openMic(): Promise<void> {
  if (!state || micOpen || state.muted) return;
  micOpen = true;
  const controller = new AbortController();
  turn = controller;
  const { botId } = state;
  const mine = () => !controller.signal.aborted && state?.botId === botId;
  try {
    // A pinned server transcriber hears every turn; the device only listens over a reply.
    if (onDevice !== false && (!serverTurns || state.phase === "speaking")) {
      // The session stays open until it delivers a turn, so the microphone is still the
      // caller's while the reply plays and a barge-in can land.
      const started = await deps.dictate(
        {
          onInterim: (text) => {
            if (mine()) heardInterim(text);
          },
          onFinal: (text) => {
            if (!mine()) return;
            if (serverTurns) heardOverReply(text);
            else void handleTranscript(text);
          },
          onIdle: () => {
            if (mine()) micIdle();
          },
          onError: () => {
            if (mine()) micFailed();
          },
        },
        controller.signal,
      );
      if (started) {
        onDevice = true;
        return;
      }
      onDevice = false;
    }
    // Muting or hanging up while the device was deciding: no microphone after all.
    if (!mine() || !state || state.muted) {
      micOpen = false;
      return;
    }
    // The recorder would only record the reply; it waits for playback to end.
    if (serverTurns && state.phase === "speaking") {
      micOpen = false;
      return;
    }
    if (!canTranscribe) {
      micOpen = false;
      set({
        caption: t(
          "Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio.",
        ),
      });
      return;
    }
    const clip = await deps.record(controller.signal);
    if (!mine()) return;
    const text = clip ? await deps.transcribe(clip, controller.signal) : "";
    if (!mine()) return;
    micOpen = false;
    await handleTranscript(text);
  } catch (error) {
    micOpen = false;
    if (!mine()) return;
    failTurn(error);
  }
}

/** One finished turn: drop the reply leaking back, cut in over playback, or send it. */
async function handleTranscript(raw: string): Promise<void> {
  if (!state) return;
  // The session stopped itself to deliver this.
  micOpen = false;
  failures = 0;
  const text = raw.trim();
  if (!text) {
    void listen();
    return;
  }
  if (state.phase === "speaking") {
    if (!isCallBargeIn(text)) {
      // The microphone caught the reply, not the caller: reopen so a real interruption
      // still lands, and let the reply play out.
      set({ heard: "" });
      void openMic();
      return;
    }
    // The caller talked over the reply: cut the audio, and never resume that message.
    bargedIn = true;
    clearInterim();
    deps.stopSpeaking();
    set({ phase: "thinking", caption: "" });
  }
  if (spokenMemory.isEcho(text)) {
    set({ heard: "" });
    void listen();
    return;
  }
  const handOver = switchBot?.(text);
  if (handOver) {
    void switchCall(handOver, text);
    return;
  }
  const { botId } = state;
  // The call this turn belongs to: hanging up and calling the same bot again before
  // send resolves must not hand the new call the old run.
  const turnCallId = callId;
  set({
    phase: "thinking",
    heard: text,
    draft: "",
    exchanges: [...state.exchanges, { role: "user", text }],
  });
  // The waiting sound follows the closing cue, and only if the bot has not answered yet.
  const cueTurn = ++turnSeq;
  void deps
    .cue("end")
    .catch(() => undefined)
    .then(() => {
      if (state?.phase !== "thinking" || callId !== turnCallId || turnSeq !== cueTurn) return;
      deps.waitSound("start");
    });
  if (isFarewell(text)) {
    hangUpAfterReply = true;
    // A second goodbye replaces this timer. Clear the previous one or it can
    // end the next call after this one has already hung up.
    if (hangUpTimer) clearTimeout(hangUpTimer);
    hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
  }
  let releasePendingSend: (() => void) | undefined;
  try {
    const sendRequest = deps.send(botId, text, callClientNonce(turnCallId));
    releasePendingSend = trackPendingCallSend(turnCallId, sendRequest);
    const runId = await sendRequest;
    if (state?.botId === botId && callId === turnCallId) {
      callRunId = runId ?? null;
      if (hangUpAfterReply) farewellSent = true;
    }
  } catch (error) {
    if (state?.botId !== botId || callId !== turnCallId) return;
    if (error instanceof AiConsentBlocked) {
      // Bot already closed server-side: do not clear its hang-up into a muted stuck call.
      if (botEndedCall) {
        endCall();
        return;
      }
      // Goodbye was not delivered; drop the armed hang-up so mute/retry can continue.
      if (hangUpTimer) clearTimeout(hangUpTimer);
      hangUpTimer = null;
      hangUpAfterReply = false;
      farewellSent = false;
      blockForConsent(error);
      return;
    }
    failTurn(error);
  } finally {
    releasePendingSend?.();
  }
}

function failTurn(error: unknown): void {
  failures += 1;
  if (failures >= MAX_TURN_FAILURES) {
    endCall();
    return;
  }
  set({ phase: "listening", caption: errorText(error, t("Could not hear that.")) });
  void listen();
}

/** A denied disclosure is not a transient call failure: wait for an explicit retry. */
function blockForConsent(error: AiConsentBlocked): void {
  consentBlocked = true;
  turn?.abort();
  turn = null;
  micOpen = false;
  clearInterim();
  set({
    phase: "listening",
    muted: true,
    heard: "",
    caption: errorText(error, t("Could not hear that.")),
  });
}

/**
 * A running guess: it shows what the caller is saying, and over a reply it is the only
 * signal that arrives while they are still talking. A phrase that stands for
 * INTERIM_BARGE_IN_MS stops the audio at once; the session keeps running, so its silence
 * window finishes the utterance and handleTranscript sends it as the next turn.
 */
function heardInterim(text: string): void {
  if (!state) return;
  if (state.phase !== "speaking") {
    clearInterim();
    set({ heard: text });
    return;
  }
  if (!isInterimCallBargeIn(text)) {
    clearInterim();
    return;
  }
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (state?.phase !== "speaking") return;
    bargedIn = true;
    deps.stopSpeaking();
    set({ phase: "listening", caption: "" });
    // A pinned server transcriber takes the turn: hand the microphone to the recorder.
    if (serverTurns) void listen();
  }, INTERIM_BARGE_IN_MS);
}

/** Pinned server transcriber: the device's words over a reply only decide whether to cut in. */
function heardOverReply(text: string): void {
  if (state?.phase !== "speaking") return;
  // The session stopped itself to deliver this.
  micOpen = false;
  if (!isCallBargeIn(text.trim())) {
    void openMic();
    return;
  }
  bargedIn = true;
  clearInterim();
  deps.stopSpeaking();
  void listen();
}

function clearInterim(): void {
  if (interimTimer) clearTimeout(interimTimer);
  interimTimer = null;
}

/** The recognizer gave up on a quiet stretch: open a fresh session, or the call goes deaf. */
function micIdle(): void {
  micOpen = false;
  if (!state || state.muted || opening) return;
  if (state.phase === "listening" || state.phase === "speaking") void openMic();
}

/** The recognizer failed outright. Over a reply the reply plays out; otherwise retry the turn. */
function micFailed(): void {
  micOpen = false;
  if (state?.phase !== "listening") return;
  failTurn(new Error(t("Could not hear that.")));
}

function onReply(messageId: string, text: string, runId?: string): void {
  // Work the bot files after hanging up belongs in the thread, not in the caller's ear.
  if (!state || switching || botEndedCall || messageId === spokenMessageId) return;
  // A reply to something typed into the thread mid-call belongs on screen only.
  if (callRunId && runId && runId !== callRunId) return;
  spokenMessageId = messageId;
  speakAndListen(text);
}

/** The reply forming while the bot works, so the transcript is live before it is spoken. */
function onDraft(messageId: string, text: string, runId?: string): void {
  if (!state || switching || botEndedCall || messageId === spokenMessageId) return;
  if (callRunId && runId && runId !== callRunId) return;
  if (state.phase !== "thinking" || state.draft === text) return;
  set({ draft: text });
}

/** The bot on the line says it is handing over, then this call hangs up and the other bot rings. */
async function switchCall(target: CallSwitch, heard: string): Promise<void> {
  if (!state || switching) return;
  switching = true;
  const { botId } = state;
  const switchingCallId = callId;
  const notice = t("OK, switching to {name}.", { name: target.name });
  turn?.abort();
  turn = null;
  micOpen = false;
  set({
    phase: "speaking",
    heard: "",
    exchanges: [...state.exchanges, { role: "user", text: heard }, { role: "bot", text: notice }],
  });
  // The caller can hang up during either await: then nothing more is said and nobody rings.
  const stillOn = () => state !== null && callId === switchingCallId;
  await deps.cue("end").catch(() => undefined);
  if (!stillOn()) return;
  try {
    await deps.speak(botId, notice);
  } catch (error) {
    if (!stillOn()) return;
    // A refused voice disclosure stays refused: mute here rather than ring a bot that would ask again.
    if (error instanceof AiConsentBlocked) {
      switching = false;
      blockForConsent(error);
      return;
    }
  }
  if (!stillOn()) return;
  endCall();
  target.ring();
}

function speakAndListen(text: string): void {
  if (!state) return;
  const { botId } = state;
  const speakingCallId = callId;
  let blockedByConsent = false;
  bargedIn = false;
  clearInterim();
  set({ exchanges: [...state.exchanges, { role: "bot", text }] });
  // A prior disclosure refuse stays muted until unmute; do not re-open speech consent.
  if (consentBlocked) {
    set({ phase: "listening", heard: "" });
    return;
  }
  spokenMemory.remember(text);
  // Only the on-device path can hear the caller over the reply; the recorder would just
  // record the speaker, so it stays shut until playback ends. With a pinned server
  // transcriber the device still watches the reply for a barge-in when it can.
  const watchReply = serverTurns ? onDevice !== false : onDevice;
  if (!onDevice || serverTurns) {
    turn?.abort();
    turn = null;
    micOpen = false;
  }
  set({ phase: "speaking", heard: "" });
  if (watchReply) void openMic();
  void deps
    .speak(botId, text)
    .catch((error: unknown) => {
      if (state?.botId !== botId || callId !== speakingCallId) return;
      if (error instanceof AiConsentBlocked) {
        blockedByConsent = true;
        // Hang-up already committed server-side or via a sent goodbye.
        if (botEndedCall || farewellSent) {
          endCall();
          return;
        }
        blockForConsent(error);
        return;
      }
      set({ caption: errorText(error, t("Could not speak that.")) });
    })
    .finally(() => {
      if (state?.botId !== botId || callId !== speakingCallId) return;
      if (blockedByConsent) return;
      // The caller cut in: the microphone is already theirs and their turn is on its way.
      if (bargedIn) return;
      void listen();
    });
}

/** The bot hung up: speak the goodbye it wrote, then end — the rest lands in the thread. */
function onCallEnded(ended: CallEnded): void {
  if (!state || switching || ended.callId !== callId || botEndedCall) return;
  hangUpAfterReply = true;
  botEndedCall = true;
  if (hangUpTimer) clearTimeout(hangUpTimer);
  hangUpTimer = setTimeout(endCall, FAREWELL_TIMEOUT_MS);
  const farewell = ended.farewell?.trim();
  // Nothing to say: hang up instead of waiting out the fallback.
  if (!farewell) {
    endCall();
    return;
  }
  speakAndListen(farewell);
}

function productionDeps(): CallDeps {
  return {
    dictate: dictateTurn,
    record: recordClip,
    transcribe: transcribeClip,
    pinnedTranscriber: loadPinnedTranscriber,
    send: sendHeard,
    endCall: closeCall,
    speak: speakReply,
    stopSpeaking,
    cue: playCallCue,
    waitSound: (action) => {
      if (action === "start") void startWaitSound().catch(() => undefined);
      else if (action === "stop") stopWaitSound();
      else if (action === "preload") void preloadWaitSound().catch(() => undefined);
      else releaseWaitSound();
    },
    audio: { begin: beginCallAudio, speaker: setCallSpeaker, end: endCallAudio },
    watch: watchReplies,
  };
}

/** The device's own speech recognition, which works with a speak-only voice provider. */
async function dictateTurn(handlers: DictationHandlers, signal: AbortSignal): Promise<boolean> {
  if (!(await dictation.available())) return false;
  await dictation.listen({
    ...handlers,
    signal,
    lang: getActiveUiLocale(),
    // Each recognizer start applies this; its own default is the loudspeaker in `.measurement`.
    iosCategory: callRecognizerCategory(),
  });
  return true;
}

/** Records one hands-free turn: wait for speech, stop once the speaker goes quiet. */
async function recordClip(signal: AbortSignal): Promise<CallClip | null> {
  const { AudioModule, RecordingPresets } = await import("expo-audio");
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error(t("Allow microphone access to call a bot."));
  let recorder: AudioRecorder | undefined;
  let heardSpeech = false;
  try {
    // The call's audio session already allows recording; flipping it per turn rerouted
    // the audio and took the microphone from the barge-in listener.
    recorder = new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await recorder.prepareToRecordAsync();
    recorder.record();
    let quietMs = 0;
    for (let elapsed = 0; elapsed < MAX_CLIP_MS && !signal.aborted; elapsed += METER_POLL_MS) {
      await abortableDelay(METER_POLL_MS, signal);
      if (signal.aborted) break;
      // Platforms without metering report nothing; keep recording to the cap.
      const level = recorder.getStatus().metering ?? 0;
      if (level > SPEECH_LEVEL_DB) {
        heardSpeech = true;
        quietMs = 0;
      } else if (heardSpeech) {
        quietMs += METER_POLL_MS;
        if (quietMs >= SILENCE_HANG_MS) break;
      }
    }
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri || !heardSpeech || signal.aborted) {
      deleteQuietly(uri);
      return null;
    }
    const file = new File(uri);
    const base64 = await file.base64();
    deleteQuietly(uri);
    return { base64, mimeType: "audio/m4a" };
  } finally {
    recorder?.release();
    // expo-audio's recorder resets the iOS mode to `.default`; the reply plays in `.voiceChat`.
    await reassertCallAudio();
  }
}

function deleteQuietly(uri: string | null): void {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // The clip is disposable; a leftover in the cache is fine.
  }
}

async function transcribeClip(clip: CallClip, signal: AbortSignal): Promise<string> {
  const { apiBase, headers } = await captureApiRequestContext();
  const res = await fetch(`${apiBase}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
    body: JSON.stringify({ audioBase64: clip.base64, mimeType: clip.mimeType }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(errorText(body.error ?? "", t("Could not transcribe that.")));
  return body.text ?? "";
}

/** Set when the server pins transcription to a provider the caller connected. */
async function loadPinnedTranscriber(): Promise<string | null> {
  const status = await rpc<{ transcribeProvider?: string | null }>(
    "voice/status",
    {},
    { timeoutMs: PIN_LOOKUP_TIMEOUT_MS },
  );
  return status?.transcribeProvider || null;
}

async function sendHeard(
  botId: string,
  text: string,
  clientNonce: string,
): Promise<string | undefined> {
  const sent = await rpc<{ runId?: string }>("threads/send", { botId, clientNonce, text });
  return sent.runId;
}

async function closeCall(botId: string, id: string): Promise<void> {
  await rpc("threads/endCall", { botId, callId: id });
}

async function speakReply(botId: string, text: string): Promise<void> {
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

/** Live feed for the bot on the call, independent of whichever thread is on screen. */
function watchReplies(
  botId: string,
  onNewReply: (messageId: string, text: string, runId?: string) => void,
  onEnded: (ended: CallEnded) => void,
  onReplyDraft?: (messageId: string, text: string, runId?: string) => void,
): () => void {
  const controller = new AbortController();
  const watchedCallId = callId;
  void (async () => {
    let snapshot: MobileSnapshot | null = null;
    let lastSeen: string | null = null;
    let cursor = 0;
    let retry = FEED_RETRY_MIN_MS;
    // The stream returns on an idle timeout as well as on a real failure, and a call
    // outlives both: pick it back up from the last seq until the caller hangs up. The
    // first snapshot is loaded in here too, so a failed load retries instead of
    // leaving the call with an open microphone and no feed.
    while (!controller.signal.aborted) {
      try {
        if (!snapshot) {
          snapshot = await rpc<MobileSnapshot>(
            "threads/get",
            { botId },
            { signal: controller.signal },
          );
          lastSeen = latestSpokenCallReply(snapshot.messages, watchedCallId)?.id ?? null;
          cursor = snapshot.cursor ?? 0;
        }
        await subscribeThread(
          { botId },
          cursor,
          (event) => {
            if (typeof event.seq === "number") cursor = event.seq;
            if (event.type === "thread.call.ended") {
              onEnded({
                callId: asText(event.payload?.callId),
                farewell: asText(event.payload?.farewell),
              });
              return;
            }
            snapshot = applyMobileThreadEvent(snapshot, event) ?? snapshot;
            if (!snapshot) return;
            const message = latestSpokenCallReply(snapshot.messages, watchedCallId);
            if (!message || message.id === lastSeen) return;
            // Wait for the message's own run to settle so half-written blocks are never
            // spoken; another run still working says nothing about this one.
            const run = snapshot?.run;
            const fromAnotherRun = Boolean(message.runId && message.runId !== run?.id);
            if (!fromAnotherRun && run && ACTIVE_RUN_STATUSES.some((s) => s === run.status)) {
              // Not spoken yet, but the transcript can show it forming.
              const draft = blockText(message).trim();
              if (draft) onReplyDraft?.(message.id, draft, message.runId);
              return;
            }
            const text = blockText(message).trim();
            if (!text) return;
            lastSeen = message.id;
            onNewReply(message.id, text, message.runId);
          },
          controller.signal,
        );
        retry = FEED_RETRY_MIN_MS;
      } catch {
        if (controller.signal.aborted) return;
        retry = Math.min(FEED_RETRY_MAX_MS, retry * 2);
      }
      if (controller.signal.aborted) return;
      await abortableDelay(retry, controller.signal);
    }
  })().catch(() => undefined);
  return () => controller.abort();
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trackPendingCallSend(callId: string, request: Promise<unknown>): () => void {
  const pending = pendingCallSends.get(callId) ?? new Set<Promise<unknown>>();
  pending.add(request);
  pendingCallSends.set(callId, pending);
  return () => {
    pending.delete(request);
    if (pending.size === 0) pendingCallSends.delete(callId);
  };
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
