import { manualHistoryCompactJob } from "@rakazo/adapter-kit";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { DEFAULT_MODEL_CONTEXT_WINDOW } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { BotThreadContextTarget } from "./thread-context.js";
import {
  requestThreadCompaction,
  resolveModelContextWindow,
  threadContextStatus,
} from "./thread-context.js";

const actor: Actor = {
  userId: "user-fixture",
  spaceId: "space-fixture",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

const catalogModel = listPiCatalog().find(
  (entry) => entry.contextWindow && !entry.placeholder && entry.provider !== "openai-compatible",
)!;

function target(overrides: Partial<BotThreadContextTarget["bot"]> = {}): BotThreadContextTarget {
  return {
    botId: "bot-fixture",
    threadId: "thread-fixture",
    bot: {
      modelProvider: null,
      modelId: null,
      thread: { nextMessageSeq: 12, historyCompactedUpToSeq: 3 },
      ...overrides,
    },
  };
}

type UsageRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  createdAt: Date;
  run: { trigger: string } | null;
};

function harness(
  options: { answers?: UsageRow[]; compactedAt?: Date | null; secretPlaintext?: string } = {},
) {
  const findMany = vi.fn(async () => options.answers ?? []);
  const findFirst = vi.fn(async () =>
    options.compactedAt ? { createdAt: options.compactedAt } : null,
  );
  const credential = options.secretPlaintext
    ? {
        id: "credential-fixture",
        userId: actor.userId,
        provider: "openai-compatible",
        label: "Local",
        secretId: "secret-fixture",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    : null;
  const prisma = {
    usageRecord: { findMany, findFirst },
    spaceModelPreference: { findMany: vi.fn(async () => []) },
    userModelCredential: { findMany: vi.fn(async () => (credential ? [credential] : [])) },
    secret: {
      findFirst: vi.fn(async () =>
        options.secretPlaintext ? { ciphertext: "ciphertext-fixture" } : null,
      ),
    },
  } as unknown as PrismaClient;
  const secrets = { load: vi.fn(async () => options.secretPlaintext ?? "") };
  return { deps: { prisma, secrets }, findMany, findFirst };
}

describe("resolveModelContextWindow", () => {
  it("uses the catalog window for a catalog model", async () => {
    const { deps } = harness();
    await expect(
      resolveModelContextWindow(deps, actor, catalogModel.provider, catalogModel.id),
    ).resolves.toBe(catalogModel.contextWindow);
  });

  it("prefers a connection's own limit", async () => {
    const { deps } = harness({
      secretPlaintext: serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 65_536,
      }),
    });
    await expect(
      resolveModelContextWindow(deps, actor, "openai-compatible", "local-model"),
    ).resolves.toBe(65_536);
  });

  it("falls back to the runtime default for a custom connection without a limit", async () => {
    const { deps } = harness();
    await expect(
      resolveModelContextWindow(deps, actor, "openai-compatible", "local-model"),
    ).resolves.toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
  });

  it("reports an unknown model as unknown", async () => {
    const { deps } = harness();
    await expect(
      resolveModelContextWindow(deps, actor, "unknown-provider", "unknown-model"),
    ).resolves.toBeNull();
  });
});

describe("threadContextStatus", () => {
  it("measures the latest conversational call on the bot's own model", async () => {
    const { deps, findMany } = harness({
      answers: [
        {
          inputTokens: 90_000,
          outputTokens: 10,
          createdAt: new Date(3),
          run: { trigger: "routine" },
        },
        {
          inputTokens: 2_000,
          cacheReadTokens: 40_000,
          outputTokens: 500,
          createdAt: new Date(2),
          run: { trigger: "user" },
        },
      ],
      compactedAt: new Date(1),
    });

    const status = await threadContextStatus(
      deps,
      actor,
      target({ modelProvider: catalogModel.provider, modelId: catalogModel.id }),
      { provider: "space-provider", modelId: "space-model" },
    );

    expect(status).toEqual({
      provider: catalogModel.provider,
      modelId: catalogModel.id,
      contextWindow: catalogModel.contextWindow,
      usedTokens: 42_500,
      measuredAt: new Date(2).toISOString(),
      compactedAt: new Date(1).toISOString(),
      compactedThroughSeq: 3,
      uncompactedMessages: 8,
    });
    // Usage is read only for this owner's bot in this thread.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: "bot-fixture",
          operationKind: "answer",
          run: { threadId: "thread-fixture" },
        },
      }),
    );
  });

  it("follows the space default and reports nothing measured yet", async () => {
    const { deps } = harness();

    const status = await threadContextStatus(
      deps,
      actor,
      target({ thread: { nextMessageSeq: 0, historyCompactedUpToSeq: null } }),
      { provider: "unknown-provider", modelId: "unknown-model" },
    );

    expect(status).toMatchObject({
      provider: "unknown-provider",
      modelId: "unknown-model",
      contextWindow: null,
      usedTokens: null,
      measuredAt: null,
      compactedAt: null,
      compactedThroughSeq: null,
      uncompactedMessages: 0,
    });
  });
});

describe("requestThreadCompaction", () => {
  it("queues the server's compaction through the latest message", async () => {
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await expect(requestThreadCompaction({ jobs }, target())).resolves.toEqual({
      queued: true,
      throughSeq: 11,
    });
    expect(jobs.enqueue).toHaveBeenCalledWith(manualHistoryCompactJob("thread-fixture", 11));
  });

  it("does nothing when every message is already summarized", async () => {
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await expect(
      requestThreadCompaction(
        { jobs },
        target({ thread: { nextMessageSeq: 12, historyCompactedUpToSeq: 11 } }),
      ),
    ).resolves.toEqual({ queued: false, throughSeq: null });
    await expect(
      requestThreadCompaction(
        { jobs },
        target({ thread: { nextMessageSeq: 0, historyCompactedUpToSeq: null } }),
      ),
    ).resolves.toEqual({ queued: false, throughSeq: null });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
