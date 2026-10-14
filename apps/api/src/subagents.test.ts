import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { getSubagentDetail, redoSubagent } from "./subagents.js";
import type { ThreadTarget } from "./thread-target.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const agentId = JSON.stringify(["pi-tool", "main", "call-1"]);
const nested = (callId: string) => JSON.stringify(["pi-tool", agentId, callId]);

function botTarget(bot: { disabledBuiltinTools?: string[]; archivedAt?: Date | null } = {}) {
  return {
    kind: "bot",
    botId: "bot-1",
    threadId: "thread-1",
    bot: { disabledBuiltinTools: [], archivedAt: null, ...bot },
  } as unknown as ThreadTarget;
}

function fakePrisma(options: {
  first?: Record<string, unknown> | null;
  last?: Record<string, unknown> | null;
  tools?: Array<{ type: string; payload: unknown }>;
  busy?: boolean;
}) {
  const findFirst = vi.fn(async (args: { orderBy: { seq: "asc" | "desc" } }) => {
    const payload = args.orderBy.seq === "asc" ? options.first : options.last;
    return payload ? { payload } : null;
  });
  const findMany = vi.fn(async () => options.tools ?? []);
  const runFindFirst = vi.fn(async () => (options.busy ? { id: "run-busy" } : null));
  return {
    prisma: {
      event: { findFirst, findMany },
      run: { findFirst: runFindFirst },
    } as unknown as PrismaClient,
    findFirst,
    findMany,
    runFindFirst,
  };
}

const started = {
  agentId,
  name: "Research",
  task: "Find facts.",
  instructions: "Be brief.",
  modelProvider: "openai",
  modelId: "gpt-test",
  status: "running",
  progress: "starting…",
};
const completed = {
  agentId,
  name: "Research",
  task: "Find facts.",
  status: "completed",
  result: "Three facts.",
};

describe("getSubagentDetail", () => {
  it("returns the stored input, latest state, and only this sub-agent's tool calls", async () => {
    const { prisma, findFirst, findMany } = fakePrisma({
      first: started,
      last: completed,
      tools: [
        { type: "agent.tool.called", payload: { name: "run_subagent", executionId: agentId } },
        { type: "agent.tool.called", payload: { name: "web_search", executionId: nested("a") } },
        {
          type: "agent.tool.completed",
          payload: { name: "web_search", executionId: nested("a"), outcome: "succeeded" },
        },
      ],
    });

    const detail = await getSubagentDetail(prisma, botTarget(), { runId: "run-1", agentId });

    expect(detail).toEqual({
      runId: "run-1",
      agentId,
      name: "Research",
      task: "Find facts.",
      instructions: "Be brief.",
      modelProvider: "openai",
      modelId: "gpt-test",
      status: "completed",
      result: "Three facts.",
      tools: [{ executionId: nested("a"), name: "web_search", status: "succeeded" }],
      canRedo: true,
    });
    // Every read is scoped to the authorized thread and the requested run.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          runId: "run-1",
          type: "thread.subagent",
          payload: { path: ["agentId"], equals: agentId },
        },
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1", runId: "run-1" }),
      }),
    );
  });

  it("is not found outside the authorized thread", async () => {
    const { prisma } = fakePrisma({ first: null, last: null });
    await expect(
      getSubagentDetail(prisma, botTarget(), { runId: "run-2", agentId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot redo while running, while the bot is busy, in a group, or with subagents off", async () => {
    const running = fakePrisma({ first: started, last: started });
    expect(
      (await getSubagentDetail(running.prisma, botTarget(), { runId: "run-1", agentId })).canRedo,
    ).toBe(false);

    const busy = fakePrisma({ first: started, last: completed, busy: true });
    expect(
      (await getSubagentDetail(busy.prisma, botTarget(), { runId: "run-1", agentId })).canRedo,
    ).toBe(false);

    const group = fakePrisma({ first: started, last: completed });
    const groupTarget = {
      kind: "group",
      groupId: "group-1",
      threadId: "thread-1",
      groupName: "Team",
      members: [],
      memberBotIds: [],
    } as ThreadTarget;
    expect(
      (await getSubagentDetail(group.prisma, groupTarget, { runId: "run-1", agentId })).canRedo,
    ).toBe(false);

    const off = fakePrisma({ first: started, last: completed });
    expect(
      (
        await getSubagentDetail(off.prisma, botTarget({ disabledBuiltinTools: ["run_subagent"] }), {
          runId: "run-1",
          agentId,
        })
      ).canRedo,
    ).toBe(false);
  });
});

describe("redoSubagent", () => {
  function deps(prisma: PrismaClient, runId: string | null = "run-new") {
    return {
      prisma,
      events: {
        sendUserMessage: vi.fn(async () => ({
          messageId: "message-1",
          seq: 4,
          taskId: runId ? "task-1" : null,
          runId,
        })),
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn() },
    };
  }

  it("starts a user run that makes the same run_subagent call", async () => {
    const { prisma } = fakePrisma({ first: started, last: completed });
    const redo = deps(prisma);

    await expect(
      redoSubagent(redo as never, actor, botTarget(), {
        runId: "run-1",
        agentId,
        clientNonce: "nonce-1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run-new" });

    const sent = redo.events.sendUserMessage.mock.calls[0] as unknown as [
      { prompt: string; blocks: unknown; trigger: string; botId: string; clientNonce: string },
    ];
    expect(sent[0]).toMatchObject({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      trigger: "user",
      clientNonce: "nonce-1",
      blocks: [{ kind: "text", text: 'Run "Research" again' }],
    });
    expect(JSON.parse(sent[0].prompt.split("\n").at(-1) ?? "")).toEqual({
      name: "Research",
      task: "Find facts.",
      instructions: "Be brief.",
      model_provider: "openai",
      model_id: "gpt-test",
    });
    expect(redo.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("refuses when the bot cannot take it now", async () => {
    const busy = fakePrisma({ first: started, last: completed, busy: true });
    await expect(
      redoSubagent(deps(busy.prisma) as never, actor, botTarget(), { runId: "run-1", agentId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const running = fakePrisma({ first: started, last: started });
    await expect(
      redoSubagent(deps(running.prisma) as never, actor, botTarget(), {
        runId: "run-1",
        agentId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const off = fakePrisma({ first: started, last: completed });
    const offDeps = deps(off.prisma);
    await expect(
      redoSubagent(offDeps as never, actor, botTarget({ disabledBuiltinTools: ["run_subagent"] }), {
        runId: "run-1",
        agentId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(offDeps.events.sendUserMessage).not.toHaveBeenCalled();

    const missing = fakePrisma({ first: null, last: null });
    await expect(
      redoSubagent(deps(missing.prisma) as never, actor, botTarget(), { runId: "run-1", agentId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
