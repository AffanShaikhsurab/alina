import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, SubagentDetail } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  subagentBlockFromPayload,
  subagentRedoPrompt,
  subagentToolCalls,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ThreadTarget } from "./thread-target.js";

/** Tool audit rows read for one run; a run past this is summarized by its first calls. */
const MAX_TOOL_EVENTS = 2_000;

type SubagentRef = { runId: string; agentId: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The newest state of one sub-agent, plus the input carried on its first event. */
async function loadSubagent(prisma: PrismaClient, threadId: string, ref: SubagentRef) {
  const where = {
    threadId,
    runId: ref.runId,
    type: "thread.subagent",
    payload: { path: ["agentId"], equals: ref.agentId },
  };
  const [first, last] = await Promise.all([
    prisma.event.findFirst({ where, orderBy: { seq: "asc" }, select: { payload: true } }),
    prisma.event.findFirst({ where, orderBy: { seq: "desc" }, select: { payload: true } }),
  ]);
  if (!first || !last) throw new ORPCError("NOT_FOUND", { message: "Subagent not found." });
  const start = subagentBlockFromPayload(asRecord(first.payload));
  const latest = subagentBlockFromPayload(asRecord(last.payload));
  return {
    ...latest,
    instructions: latest.instructions ?? start.instructions,
    modelProvider: latest.modelProvider ?? start.modelProvider,
    modelId: latest.modelId ?? start.modelId,
  };
}

function offersSubagents(target: ThreadTarget): boolean {
  return (
    target.kind === "bot" &&
    !target.bot.archivedAt &&
    !target.bot.disabledBuiltinTools.includes("run_subagent")
  );
}

async function botBusy(prisma: PrismaClient, threadId: string, botId: string): Promise<boolean> {
  const active = await prisma.run.findFirst({
    where: { threadId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  return Boolean(active);
}

export async function getSubagentDetail(
  prisma: PrismaClient,
  target: ThreadTarget,
  ref: SubagentRef,
): Promise<SubagentDetail> {
  const subagent = await loadSubagent(prisma, target.threadId, ref);
  const [toolEvents, busy] = await Promise.all([
    prisma.event.findMany({
      where: {
        threadId: target.threadId,
        runId: ref.runId,
        type: { in: ["agent.tool.called", "agent.tool.completed"] },
      },
      orderBy: { seq: "asc" },
      take: MAX_TOOL_EVENTS,
      select: { type: true, payload: true },
    }),
    target.kind === "bot" ? botBusy(prisma, target.threadId, target.botId) : Promise.resolve(true),
  ]);
  return {
    runId: ref.runId,
    agentId: ref.agentId,
    name: subagent.name,
    task: subagent.task,
    ...(subagent.instructions ? { instructions: subagent.instructions } : {}),
    ...(subagent.modelProvider && subagent.modelId
      ? { modelProvider: subagent.modelProvider, modelId: subagent.modelId }
      : {}),
    status: subagent.status,
    ...(subagent.progress ? { progress: subagent.progress } : {}),
    ...(subagent.result ? { result: subagent.result } : {}),
    tools: subagentToolCalls(toolEvents, ref.agentId),
    canRedo: offersSubagents(target) && subagent.status !== "running" && !busy,
  };
}

/**
 * Run a finished sub-agent again with the input it was given. The bot gets a normal user
 * turn that makes the same run_subagent call, so model choice, budgets, and approval gates
 * all apply exactly as they did the first time.
 */
export async function redoSubagent(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "sendUserMessage">;
    jobs: JobPublisher;
  },
  actor: Actor,
  target: ThreadTarget,
  input: SubagentRef & { clientNonce?: string },
): Promise<{ ok: true; runId: string }> {
  if (target.kind !== "bot") throw new ORPCError("BAD_REQUEST", { message: "Not a bot chat." });
  if (!offersSubagents(target)) {
    throw new ORPCError("BAD_REQUEST", { message: "Subagents are turned off for this bot." });
  }
  const subagent = await loadSubagent(deps.prisma, target.threadId, input);
  if (subagent.status === "running") {
    throw new ORPCError("CONFLICT", { message: "This subagent is still running." });
  }
  if (await botBusy(deps.prisma, target.threadId, target.botId)) {
    throw new ORPCError("CONFLICT", { message: "Wait for the current reply to finish." });
  }
  const sent = await deps.events.sendUserMessage({
    spaceId: actor.spaceId,
    threadId: target.threadId,
    botId: target.botId,
    userId: actor.userId,
    blocks: [{ kind: "text", text: `Run "${subagent.name}" again` }],
    prompt: subagentRedoPrompt(subagent),
    trigger: "user",
    clientNonce: input.clientNonce,
    linkMessageToRun: true,
  });
  if (!sent.runId) {
    throw new ORPCError("CONFLICT", { message: "Wait for the current reply to finish." });
  }
  if (sent.taskId) {
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      // The run is durable; the reconciler repairs a missed immediate wake.
      getLogger().error("subagent redo enqueue", error);
    });
  }
  return { ok: true, runId: sent.runId };
}
