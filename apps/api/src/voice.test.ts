import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectVoiceCredential,
  findTranscribePin,
  fishSpeechModelValue,
  MAX_SPEAK_REQUEST_BYTES,
  MAX_TRANSCRIBE_REQUEST_BYTES,
  mountVoiceHttpRoutes,
  synthesizeVoice,
  toVoiceStatus,
  transcribeVoice,
  updateVoiceSpeechModel,
  type VoiceDeps,
} from "./voice.js";

describe("toVoiceStatus", () => {
  it("treats a saved key without a voice as configured but not ready", () => {
    expect(toVoiceStatus({ provider: "elevenlabs", voiceId: "" })).toEqual({
      configured: true,
      ready: false,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "",
    });
  });

  it("is ready once a voice is chosen", () => {
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).ready).toBe(true);
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).transcribe).toBe(false);
  });

  it("is off when nothing is connected", () => {
    expect(toVoiceStatus(null)).toEqual({
      configured: false,
      ready: false,
      transcribe: false,
      provider: null,
      voiceId: "",
    });
  });
});

describe("voice HTTP routes", () => {
  it("rejects unauthenticated speak and transcribe", async () => {
    const app = new Hono();
    mountVoiceHttpRoutes(app, {} as VoiceDeps, async () => null);
    const speak = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const transcribe = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/webm" }),
    });
    expect(speak.status).toBe(401);
    expect(transcribe.status).toBe(401);
  });

  it.each([
    ["/api/voice/speak", MAX_SPEAK_REQUEST_BYTES],
    ["/api/voice/transcribe", MAX_TRANSCRIBE_REQUEST_BYTES],
  ])(
    "rejects a declared oversized body on %s without waiting for cancellation",
    async (path, max) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const app = new Hono();
      mountVoiceHttpRoutes(
        app,
        {} as VoiceDeps,
        async () => ({ userId: "user", spaceId: "space" }) as Actor,
      );

      const response = await app.request(request);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops reading a streamed oversized speak body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SPEAK_REQUEST_BYTES + 1));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {} as VoiceDeps,
      async () => ({ userId: "user", spaceId: "space" }) as Actor,
    );

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

function makeDisconnectDeps(
  overrides: {
    existing?: Array<{ id: string; secretId: string; userId: string; provider: string }>;
    modelReferences?: number;
    voiceReferences?: number;
  } = {},
) {
  const rows = overrides.existing ?? [];
  const findMany = vi.fn().mockResolvedValue(rows);
  const preferenceDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const credentialDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const modelCount = vi.fn().mockResolvedValue(overrides.modelReferences ?? 0);
  const voiceCount = vi.fn().mockResolvedValue(overrides.voiceReferences ?? 0);
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    userVoiceCredential: {
      findMany,
      deleteMany: credentialDeleteMany,
      count: voiceCount,
    },
    spaceVoicePreference: { deleteMany: preferenceDeleteMany },
    userModelCredential: { count: modelCount },
    secret: { deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: { put: vi.fn(), load: vi.fn() },
  } as unknown as VoiceDeps;
  return {
    deps,
    findMany,
    preferenceDeleteMany,
    credentialDeleteMany,
    secretDeleteMany,
    transaction: prisma.$transaction,
  };
}

describe("disconnectVoiceCredential", () => {
  it("removes the actor credential, clears its default, and deletes an unreferenced secret", async () => {
    const existing = {
      id: "cred-1",
      secretId: "secret-1",
      userId: actor.userId,
      provider: "scripted",
    };
    const { deps, findMany, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps({ existing: [existing] });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, provider: "scripted" },
    });
    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-1"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-1"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-1" } });
  });

  it("removes every actor credential for that provider", async () => {
    const { deps, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps({
        existing: [
          {
            id: "cred-new",
            secretId: "secret-new",
            userId: actor.userId,
            provider: "scripted",
          },
          {
            id: "cred-old",
            secretId: "secret-old",
            userId: actor.userId,
            provider: "scripted",
          },
        ],
      });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-new", "cred-old"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-new", "cred-old"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-new" } });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("keeps a secret while another credential still references it", async () => {
    const { deps, credentialDeleteMany, secretDeleteMany } = makeDisconnectDeps({
      existing: [
        {
          id: "cred-1",
          secretId: "secret-shared",
          userId: actor.userId,
          provider: "scripted",
        },
      ],
      voiceReferences: 1,
    });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(credentialDeleteMany).toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("does not delete another actor's credential", async () => {
    const { deps, findMany, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps();

    await expect(
      disconnectVoiceCredential(deps, { ...actor, userId: "intruder" }, { provider: "scripted" }),
    ).resolves.toEqual({ ok: true });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "intruder", provider: "scripted" },
    });
    expect(preferenceDeleteMany).not.toHaveBeenCalled();
    expect(credentialDeleteMany).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects a blank provider before opening a transaction", async () => {
    const { deps, transaction } = makeDisconnectDeps();

    await expect(disconnectVoiceCredential(deps, actor, { provider: "   " })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("fishSpeechModelValue", () => {
  it("trims a Fish model id and treats blank as no override", () => {
    expect(fishSpeechModelValue("  s1  ")).toBe("s1");
    expect(fishSpeechModelValue(" ")).toBeNull();
  });

  it("rejects a model id that cannot be a Fish header", () => {
    expect(() => fishSpeechModelValue("s1\ninjected")).toThrow(
      "That speech model id is not valid.",
    );
  });
});

describe("updateVoiceSpeechModel", () => {
  function speechDeps(preference: { id: string; voiceId: string; isDefault: boolean } | null) {
    const credential = {
      id: "cred-1",
      userId: actor.userId,
      provider: "fish-audio",
      secretId: "secret-1",
    };
    const update = vi
      .fn()
      .mockImplementation(async ({ data }: { data: { speechModel: string | null } }) => ({
        speechModel: data.speechModel,
      }));
    const create = vi.fn();
    const prisma = {
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(credential) },
      spaceVoicePreference: {
        findUnique: vi.fn().mockResolvedValue(preference),
        create,
        update,
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
    return {
      deps: { prisma, secrets: { put: vi.fn(), load: vi.fn() } } as unknown as VoiceDeps,
      create,
      update,
      updateMany: prisma.spaceVoicePreference.updateMany,
    };
  }

  it("stores the override without changing the selected voice", async () => {
    const { deps, update, updateMany } = speechDeps({
      id: "pref-1",
      voiceId: "voice-1",
      isDefault: false,
    });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " s1 " }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "voice-1",
      speechModel: "s1",
      isDefault: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "pref-1" },
      data: { speechModel: "s1" },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("clears the override when the model is blank", async () => {
    const { deps, update } = speechDeps({ id: "pref-1", voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " " }),
    ).resolves.toMatchObject({ speechModel: "" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "pref-1" },
      data: { speechModel: null },
    });
  });

  it("stores a model before a voice is chosen without replacing the default", async () => {
    const { deps, create, update, updateMany } = speechDeps(null);
    create.mockResolvedValue({
      isDefault: false,
      voiceId: "",
      speechModel: "s1",
    });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "",
      speechModel: "s1",
      isDefault: false,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        credentialId: "cred-1",
        speechModel: "s1",
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects speech models for other providers before writing", async () => {
    const { deps, update } = speechDeps({ id: "pref-1", voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "elevenlabs", speechModel: "s1" }),
    ).rejects.toThrow("Speech model applies to Fish Audio.");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("synthesizeVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the speech model stored on that connection", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: "s1",
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "voice-1",
        apiKey: "fish-key",
        model: "s1",
      }),
      expect.anything(),
    );
  });

  it("omits the model when the connection has no override", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: null,
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ model: undefined });
  });
});

describe("transcription pin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Connected = { provider: string; voiceId: string; isDefault: boolean };

  /** One user's connected voice providers, keyed by provider; each key is `<provider>-key`. */
  function pinDeps(connected: Connected[], transcribeProvider?: string) {
    const preference = (row: Connected) => ({
      isDefault: row.isDefault,
      voiceId: row.voiceId,
      speechModel: null,
      credential: {
        id: `cred-${row.provider}`,
        userId: actor.userId,
        provider: row.provider,
        secretId: `secret-${row.provider}`,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    const findFirst = vi.fn(
      async ({ where }: { where: { isDefault?: boolean; credential?: { provider: string } } }) => {
        const row = where.isDefault
          ? connected.find((entry) => entry.isDefault)
          : connected.find((entry) => entry.provider === where.credential?.provider);
        return row ? preference(row) : null;
      },
    );
    const prisma = {
      spaceVoicePreference: { findFirst },
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id.replace("secret-", ""),
        })),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn(async (ciphertext: string) => `${ciphertext}-key`), put: vi.fn() },
      transcribeProvider,
    } as unknown as VoiceDeps;
    return { deps, findFirst };
  }

  /** Fake adapters that record which provider handled each call. */
  function fakeProviders() {
    const used: Array<{ kind: string; op: string; apiKey: string }> = [];
    vi.spyOn(adapters, "createVoiceProvider").mockImplementation((kind: string) => {
      const speakOnly = kind === "sarvam";
      return {
        synthesize: vi.fn(async (request: { apiKey: string }) => {
          used.push({ kind, op: "speak", apiKey: request.apiKey });
          return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg" as const };
        }),
        ...(speakOnly
          ? {}
          : {
              transcribe: vi.fn(async (request: { apiKey: string }) => {
                used.push({ kind, op: "transcribe", apiKey: request.apiKey });
                return { text: "hello" };
              }),
            }),
      } as never;
    });
    return used;
  }

  const audio = { audio: new Uint8Array([1, 2]), mimeType: "audio/m4a" };

  it("speaks with the Sarvam default and transcribes with the pinned Deepgram key", async () => {
    const used = fakeProviders();
    const { deps } = pinDeps(
      [
        { provider: "sarvam", voiceId: "priya", isDefault: true },
        { provider: "deepgram", voiceId: "flux-hannah-en", isDefault: false },
      ],
      "deepgram",
    );

    await synthesizeVoice(deps, actor, { text: "Hello" });
    await expect(transcribeVoice(deps, actor, audio)).resolves.toEqual({ text: "hello" });

    expect(used).toEqual([
      { kind: "sarvam", op: "speak", apiKey: "sarvam-key" },
      { kind: "deepgram", op: "transcribe", apiKey: "deepgram-key" },
    ]);
  });

  it("keeps upstream behaviour when the pinned provider is not connected", async () => {
    fakeProviders();
    const { deps } = pinDeps(
      [{ provider: "sarvam", voiceId: "priya", isDefault: true }],
      "deepgram",
    );

    await expect(transcribeVoice(deps, actor, audio)).rejects.toThrow(
      "This voice provider does not transcribe audio.",
    );
  });

  it("transcribes with the default when the pin names a speak-only provider", async () => {
    const used = fakeProviders();
    const { deps, findFirst } = pinDeps(
      [
        { provider: "elevenlabs", voiceId: "abc", isDefault: true },
        { provider: "sarvam", voiceId: "priya", isDefault: false },
      ],
      "sarvam",
    );

    await transcribeVoice(deps, actor, audio);

    expect(used).toEqual([{ kind: "elevenlabs", op: "transcribe", apiKey: "elevenlabs-key" }]);
    expect(findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ credential: { provider: "sarvam" } }),
      }),
    );
  });

  it("reports the pinned transcriber in the voice status", async () => {
    const { deps } = pinDeps(
      [
        { provider: "sarvam", voiceId: "priya", isDefault: true },
        { provider: "deepgram", voiceId: "", isDefault: false },
      ],
      "deepgram",
    );
    const pinned = await findTranscribePin(deps, actor);

    expect(toVoiceStatus({ provider: "sarvam", voiceId: "priya" }, pinned)).toEqual({
      configured: true,
      ready: true,
      transcribe: true,
      provider: "sarvam",
      voiceId: "priya",
      transcribeProvider: "deepgram",
    });
    await expect(
      findTranscribePin({ ...deps, transcribeProvider: undefined }, actor),
    ).resolves.toBe(null);
  });

  it("speaks and transcribes with Deepgram when Deepgram is both the default and the pin", async () => {
    const used = fakeProviders();
    const { deps } = pinDeps(
      [{ provider: "deepgram", voiceId: "aura-2-thalia-en", isDefault: true }],
      "deepgram",
    );

    await synthesizeVoice(deps, actor, { text: "Hello" });
    await transcribeVoice(deps, actor, audio);

    expect(used).toEqual([
      { kind: "deepgram", op: "speak", apiKey: "deepgram-key" },
      { kind: "deepgram", op: "transcribe", apiKey: "deepgram-key" },
    ]);
  });

  it("transcribes with the pin even when the speech default can transcribe", async () => {
    const used = fakeProviders();
    const { deps } = pinDeps(
      [
        { provider: "openai", voiceId: "alloy", isDefault: true },
        { provider: "deepgram", voiceId: "", isDefault: false },
      ],
      "deepgram",
    );

    await synthesizeVoice(deps, actor, { text: "Hello" });
    await transcribeVoice(deps, actor, audio);

    expect(used).toEqual([
      { kind: "openai", op: "speak", apiKey: "openai-key" },
      { kind: "deepgram", op: "transcribe", apiKey: "deepgram-key" },
    ]);
  });

  it("transcribes with the default when nothing is pinned", async () => {
    const used = fakeProviders();
    const { deps } = pinDeps([
      { provider: "openai", voiceId: "alloy", isDefault: true },
      { provider: "deepgram", voiceId: "", isDefault: false },
    ]);

    await transcribeVoice(deps, actor, audio);

    expect(used).toEqual([{ kind: "openai", op: "transcribe", apiKey: "openai-key" }]);
  });

  it("routes the transcribe endpoint to the pinned Deepgram key", async () => {
    const used = fakeProviders();
    const { deps } = pinDeps(
      [
        { provider: "sarvam", voiceId: "priya", isDefault: true },
        { provider: "deepgram", voiceId: "", isDefault: false },
      ],
      "deepgram",
    );
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);

    const response = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/m4a" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "hello" });
    expect(used).toEqual([{ kind: "deepgram", op: "transcribe", apiKey: "deepgram-key" }]);
  });
});
