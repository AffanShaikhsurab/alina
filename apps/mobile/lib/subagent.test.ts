import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc }));

const { fetchSubagent, redoSubagent, subagentToolLabel, subagentToolSymbol, toolStepsText } =
  await import("./subagent");

beforeEach(() => {
  rpc.mockReset();
});

describe("subagent client", () => {
  it("asks the server for one sub-agent of a bot or group chat", async () => {
    rpc.mockResolvedValue({});
    await fetchSubagent({ botId: "bot-1" }, "run-1", "agent-1");
    await fetchSubagent({ groupId: "group-1" }, "run-2", "agent-2");
    expect(rpc).toHaveBeenNthCalledWith(1, "subagents/get", {
      botId: "bot-1",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "subagents/get", {
      groupId: "group-1",
      runId: "run-2",
      agentId: "agent-2",
    });
  });

  it("sends only ids to run a sub-agent again", async () => {
    rpc.mockResolvedValue({ ok: true, runId: "run-new" });
    await expect(redoSubagent("bot-1", "run-1", "agent-1", "nonce-1")).resolves.toEqual({
      ok: true,
      runId: "run-new",
    });
    expect(rpc).toHaveBeenCalledWith("subagents/redo", {
      botId: "bot-1",
      runId: "run-1",
      agentId: "agent-1",
      clientNonce: "nonce-1",
    });
  });
});

describe("subagent presentation", () => {
  it("summarizes tool steps on one line", () => {
    expect(
      toolStepsText([
        { label: "Web search", count: 2 },
        { label: "Read file", count: 1 },
        { label: "", count: 1 },
      ]),
    ).toBe("Web search ×2 · Read file");
    expect(toolStepsText([])).toBe("");
  });

  it("labels tool calls and their state", () => {
    expect(subagentToolLabel({ name: "web_search" })).toBe("Web search");
    expect(subagentToolSymbol("succeeded").ios).toBe("checkmark.circle");
    expect(subagentToolSymbol("error").ios).toBe("xmark.circle");
    expect(subagentToolSymbol("paused").ios).toBe("pause.circle");
    expect(subagentToolSymbol("running").ios).toBe("ellipsis.circle");
  });
});
