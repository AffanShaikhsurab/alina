import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { manualHistoryCompactJob } from "@rakazo/adapter-kit";
import { listPiCatalog, modelCredentialDto } from "@rakazo/adapters";
import type { Actor, ThreadContext } from "@rakazo/contracts";
import { DEFAULT_MODEL_CONTEXT_WINDOW, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { contextTokensFromUsage, isConversationalRun } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";

/** A conversation turn makes several calls; this many covers the latest turn's calls. */
const RECENT_ANSWER_CALLS = 20;

export interface BotThreadContextTarget {
  botId: string;
  threadId: string;
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thread: { nextMessageSeq: number; historyCompactedUpToSeq: number | null } | null;
  };
}

interface ThreadContextDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "load">;
}

/**
 * The window the runtime would use for this model: a connection's own limit first, then the
 * catalog. Unknown models report null rather than a guess.
 */
export async function resolveModelContextWindow(
  deps: ThreadContextDeps,
  actor: Actor,
  provider: string,
  modelId: string,
): Promise<number | null> {
  const credential = await findModelCredential(deps.prisma, actor, provider, modelId);
  if (credential) {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
    if (secret) {
      try {
        const window = modelCredentialDto(
          credential,
          await deps.secrets.load(secret.ciphertext, credential.secretId),
        ).contextWindow;
        if (window) return window;
      } catch {
        // An unreadable connection still has a catalog window.
      }
    }
  }
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return DEFAULT_MODEL_CONTEXT_WINDOW;
  return (
    listPiCatalog().find((entry) => entry.provider === provider && entry.id === modelId)
      ?.contextWindow ?? null
  );
}

export async function threadContextStatus(
  deps: ThreadContextDeps,
  actor: Actor,
  target: BotThreadContextTarget,
  spaceDefault: { provider: string | null; modelId: string | null },
): Promise<ThreadContext> {
  const ownModel = Boolean(target.bot.modelProvider && target.bot.modelId);
  const provider = ownModel ? target.bot.modelProvider : spaceDefault.provider;
  const modelId = ownModel ? target.bot.modelId : spaceDefault.modelId;
  const [contextWindow, answers, compaction] = await Promise.all([
    provider && modelId
      ? resolveModelContextWindow(deps, actor, provider, modelId)
      : Promise.resolve(null),
    deps.prisma.usageRecord.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: target.botId,
        operationKind: "answer",
        run: { threadId: target.threadId },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ANSWER_CALLS,
      select: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        totalTokens: true,
        createdAt: true,
        run: { select: { trigger: true } },
      },
    }),
    deps.prisma.usageRecord.findFirst({
      where: {
        spaceId: actor.spaceId,
        botId: target.botId,
        operationKind: "compaction",
        operationId: { startsWith: `compact:${target.threadId}:` },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    }),
  ]);
  // Routine, webhook, and intro turns run on their own prompt, not the conversation.
  const measured = answers
    .filter((row) => isConversationalRun(row.run?.trigger))
    .map((row) => ({ tokens: contextTokensFromUsage(row), at: row.createdAt }))
    .find((row) => row.tokens !== null);
  const thread = target.bot.thread;
  const compactedThroughSeq = thread?.historyCompactedUpToSeq ?? null;
  return {
    provider: provider ?? null,
    modelId: modelId ?? null,
    contextWindow,
    usedTokens: measured?.tokens ?? null,
    measuredAt: measured?.at.toISOString() ?? null,
    compactedAt: compaction?.createdAt.toISOString() ?? null,
    compactedThroughSeq,
    uncompactedMessages: thread
      ? Math.max(0, thread.nextMessageSeq - 1 - (compactedThroughSeq ?? -1))
      : 0,
  };
}

/** Queue the server's own compaction through the latest message, if anything is new. */
export async function requestThreadCompaction(
  deps: { jobs: JobPublisher },
  target: BotThreadContextTarget,
): Promise<{ queued: boolean; throughSeq: number | null }> {
  const thread = target.bot.thread;
  if (!thread) return { queued: false, throughSeq: null };
  const throughSeq = thread.nextMessageSeq - 1;
  if (throughSeq <= (thread.historyCompactedUpToSeq ?? -1)) {
    return { queued: false, throughSeq: null };
  }
  await deps.jobs.enqueue(manualHistoryCompactJob(target.threadId, throughSeq));
  return { queued: true, throughSeq };
}
