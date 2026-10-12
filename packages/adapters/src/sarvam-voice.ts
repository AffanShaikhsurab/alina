import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  MAX_SYNTHESIZED_AUDIO_BYTES,
  readVoiceJson,
  voiceDeadline,
  voiceHttpError,
  voiceUnreachable,
} from "./voice-http.js";
import { readBodyCapped } from "./web-ssrf.js";

const API = "https://api.sarvam.ai/text-to-speech";
const PROVIDER = "Sarvam AI";
const DEFAULT_MODEL = "bulbul:v3";
const DEFAULT_LANGUAGE = "en-IN";
const SAMPLE_RATE = 24_000;
/** Sarvam model id from a connection override or `SARVAM_TTS_MODEL`, e.g. `bulbul:v4-flash`. */
const MODEL_PATTERN = /^bulbul:[a-z0-9.-]{1,32}$/;
/** Sarvam language codes are BCP-47 with a region, e.g. `en-IN` or `hi-IN`. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}$/;
/** Audio arrives base64 inside JSON, so the read cap is the audio cap in base64 plus slack. */
const MAX_SARVAM_JSON_BYTES = 4 * Math.ceil(MAX_SYNTHESIZED_AUDIO_BYTES / 3) + 64 * 1024;

/** `bulbul:v3` speakers. The first is Sarvam's default. */
const SARVAM_SPEAKERS = [
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
];

const SARVAM_VOICES: VoiceInfo[] = SARVAM_SPEAKERS.map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
}));

export class SarvamVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "sarvam",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  /** Sarvam has no cheap key check, so this speaks two characters. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: sarvamHeaders(apiKey),
        body: JSON.stringify({
          text: "ok",
          language_code: DEFAULT_LANGUAGE,
          model: DEFAULT_MODEL,
          speaker: "priya",
        }),
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok) {
        cancelBody(res);
        return { ok: true };
      }
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          PROVIDER,
          "checking that key",
          await readVoiceJson(res),
        ),
      };
    } catch {
      return { ok: false, message: voiceUnreachable(PROVIDER) };
    }
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return SARVAM_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(API, {
      method: "POST",
      headers: sarvamHeaders(request.apiKey),
      body: JSON.stringify({
        text: request.text,
        language_code:
          setting(process.env.SARVAM_TTS_LANGUAGE, LANGUAGE_PATTERN) ?? DEFAULT_LANGUAGE,
        speaker: request.voiceId,
        model:
          setting(request.model, MODEL_PATTERN) ??
          setting(process.env.SARVAM_TTS_MODEL, MODEL_PATTERN) ??
          DEFAULT_MODEL,
        output_audio_codec: "mp3",
        speech_sample_rate: SAMPLE_RATE,
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(voiceHttpError(res.status, PROVIDER, "speaking", await readVoiceJson(res)));
    }
    const audio = (await readSarvamJson(res, signal))?.audios;
    const encoded = Array.isArray(audio) && typeof audio[0] === "string" ? audio[0] : "";
    if (!encoded) throw new Error("Sarvam AI returned no audio.");
    // Check the size before decoding so an oversized clip is never buffered twice.
    if (Math.floor((encoded.length * 3) / 4) - 2 > MAX_SYNTHESIZED_AUDIO_BYTES) {
      throw new Error("Voice response is too large.");
    }
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    if (bytes.byteLength > MAX_SYNTHESIZED_AUDIO_BYTES) {
      throw new Error("Voice response is too large.");
    }
    return { bytes, mimeType: "audio/mpeg" };
  }
}

function sarvamHeaders(apiKey: string): Record<string, string> {
  return { "api-subscription-key": apiKey, "content-type": "application/json" };
}

/** A well-formed override, or nothing so the next fallback applies. */
function setting(value: string | null | undefined, pattern: RegExp): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed && pattern.test(trimmed) ? trimmed : undefined;
}

async function readSarvamJson(
  res: Response,
  signal: AbortSignal,
): Promise<{ audios?: unknown } | null> {
  const declared = Number(res.headers?.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SARVAM_JSON_BYTES) {
    cancelBody(res);
    throw new Error("Voice response is too large.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(res, MAX_SARVAM_JSON_BYTES, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Voice response is too large.");
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as { audios?: unknown }) : null;
  } catch {
    throw new Error("Voice provider returned invalid JSON.");
  }
}

function cancelBody(res: Response): void {
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}
