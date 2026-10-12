import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  voiceDeadline,
  voiceHttpError,
  voiceUnreachable,
} from "./voice-http.js";

const API = "https://api.deepgram.com";
const PROVIDER = "Deepgram";
const DEFAULT_STT_MODEL = "nova-3";
/** Query-safe Deepgram model id for `DEEPGRAM_STT_MODEL`. */
const STT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** BCP-47 tag for `DEEPGRAM_STT_LANGUAGE`, e.g. `en` or `en-IN`. */
const STT_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** Flux voices speak through `/v2/speak`; Aura-2 voices through `/v1/speak`. */
const DEEPGRAM_VOICES: VoiceInfo[] = [
  { id: "flux-hannah-en", label: "Hannah", description: "Flux · Young, clear" },
  { id: "flux-alexis-en", label: "Alexis", description: "Flux · Calm, professional" },
  { id: "flux-sienna-en", label: "Sienna", description: "Flux · Warm" },
  { id: "flux-elise-en", label: "Elise", description: "Flux · Calm, caring" },
  { id: "flux-haley-en", label: "Haley", description: "Flux · Professional" },
  { id: "flux-bree-en", label: "Bree", description: "Flux · Mature, sweet" },
  { id: "flux-brittany-en", label: "Brittany", description: "Flux · Mature, soft" },
  { id: "flux-paige-en", label: "Paige", description: "Flux · Calm" },
  { id: "flux-meghan-en", label: "Meghan", description: "Flux · Friendly" },
  { id: "flux-kelsey-en", label: "Kelsey", description: "Flux · Calm" },
  { id: "aura-2-thalia-en", label: "Thalia", description: "Aura-2 · Clear, confident" },
  { id: "aura-2-andromeda-en", label: "Andromeda", description: "Aura-2 · Casual, expressive" },
  { id: "aura-2-helena-en", label: "Helena", description: "Aura-2 · Caring, natural" },
  { id: "aura-2-apollo-en", label: "Apollo", description: "Aura-2 · Confident, casual" },
  { id: "aura-2-arcas-en", label: "Arcas", description: "Aura-2 · Natural, smooth" },
];

export class DeepgramVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "deepgram",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${API}/v1/projects`, {
        headers: deepgramHeaders(apiKey),
        signal: voiceDeadline(context.signal, 20_000),
      });
      // 403 is a valid key without project read scope: it still speaks and transcribes.
      if (res.ok || res.status === 403) return { ok: true };
      return {
        ok: false,
        message: voiceHttpError(
          res.status,
          PROVIDER,
          "checking that key",
          deepgramError(await readVoiceJson(res)),
        ),
      };
    } catch {
      return { ok: false, message: voiceUnreachable(PROVIDER) };
    }
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return DEEPGRAM_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const voiceId = request.voiceId.trim();
    const path = voiceId.startsWith("flux-") ? "/v2/speak" : "/v1/speak";
    const params = new URLSearchParams({ model: voiceId, encoding: "mp3" });
    const res = await fetch(`${API}${path}?${params}`, {
      method: "POST",
      headers: { ...deepgramHeaders(request.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ text: request.text }),
      signal,
    });
    if (!res.ok) {
      throw new Error(
        voiceHttpError(res.status, PROVIDER, "speaking", deepgramError(await readVoiceJson(res))),
      );
    }
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const params = new URLSearchParams({
      model: deploymentSetting("DEEPGRAM_STT_MODEL", STT_MODEL_PATTERN) ?? DEFAULT_STT_MODEL,
      smart_format: "true",
      punctuate: "true",
    });
    const language = deploymentSetting("DEEPGRAM_STT_LANGUAGE", STT_LANGUAGE_PATTERN);
    if (language) params.set("language", language);
    const res = await fetch(`${API}/v1/listen?${params}`, {
      method: "POST",
      headers: {
        ...deepgramHeaders(request.apiKey),
        "content-type": uploadType(request.mimeType),
      },
      body: new Uint8Array(request.audio),
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) {
      throw new Error(voiceHttpError(res.status, PROVIDER, "transcribing", deepgramError(body)));
    }
    return { text: transcriptFrom(body).trim() };
  }
}

function deepgramHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Token ${apiKey}` };
}

/** A deployment override when it is well formed; otherwise the provider default. */
function deploymentSetting(name: string, pattern: RegExp): string | undefined {
  const value = process.env[name]?.trim() ?? "";
  return value && pattern.test(value) ? value : undefined;
}

/** Deepgram sniffs the container itself; the header only has to name an audio type. */
function uploadType(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() || "audio/webm";
  return mime === "audio/m4a" || mime === "audio/x-m4a" ? "audio/mp4" : mime;
}

/** Deepgram reports `err_msg`; the shared error text reads `message`. */
function deepgramError(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const message = (body as { err_msg?: unknown }).err_msg;
  return typeof message === "string" ? { message } : body;
}

function transcriptFrom(body: unknown): string {
  const channel = (body as { results?: { channels?: unknown } } | null)?.results?.channels;
  const first = Array.isArray(channel) ? (channel[0] as { alternatives?: unknown }) : undefined;
  const alternative = Array.isArray(first?.alternatives)
    ? (first.alternatives[0] as { transcript?: unknown })
    : undefined;
  return typeof alternative?.transcript === "string" ? alternative.transcript : "";
}
