import { describe, expect, it } from "vitest";
import { subagentRedoPrompt, subagentToolCalls, toolCallAgentId } from "./subagent-activity.js";

const agentId = JSON.stringify(["pi-tool", "main", "call-helper"]);
const nested = (callId: string, owner = agentId) => JSON.stringify(["pi-tool", owner, callId]);

describe("toolCallAgentId", () => {
  it("reads the namespace of a Pi tool call and ignores other ids", () => {
    expect(toolCallAgentId(agentId)).toBe("main");
    expect(toolCallAgentId(nested("read"))).toBe(agentId);
    expect(toolCallAgentId("run-1:shell:0")).toBeUndefined();
    expect(toolCallAgentId('["pi-tool",')).toBeUndefined();
    expect(toolCallAgentId('["pi-tool",1,"x"]')).toBeUndefined();
  });
});

describe("subagentToolCalls", () => {
  it("keeps only this sub-agent's calls and folds their completion", () => {
    const calls = subagentToolCalls(
      [
        { type: "agent.tool.called", payload: { name: "run_subagent", executionId: agentId } },
        { type: "agent.tool.called", payload: { name: "web_search", executionId: nested("a") } },
        { type: "agent.tool.called", payload: { name: "read_file", executionId: nested("b") } },
        {
          type: "agent.tool.called",
          payload: { name: "shell", executionId: nested("c", "other-agent") },
        },
        { type: "thread.progress", payload: { executionId: nested("a") } },
        {
          type: "agent.tool.completed",
          payload: {
            name: "web_search",
            executionId: nested("a"),
            durationMs: 1234.6,
            outcome: "succeeded",
          },
        },
        {
          type: "agent.tool.completed",
          payload: {
            name: "read_file",
            executionId: nested("b"),
            durationMs: 5,
            outcome: "error",
            error: "x".repeat(900),
          },
        },
        { type: "agent.tool.called", payload: { name: "ask_user", executionId: nested("d") } },
        {
          type: "agent.tool.completed",
          payload: { name: "ask_user", executionId: nested("d"), outcome: "paused" },
        },
        { type: "agent.tool.called", payload: { name: "shell", executionId: nested("e") } },
      ],
      agentId,
    );

    expect(calls).toEqual([
      { executionId: nested("a"), name: "web_search", status: "succeeded", durationMs: 1235 },
      {
        executionId: nested("b"),
        name: "read_file",
        status: "error",
        durationMs: 5,
        error: "x".repeat(500),
      },
      { executionId: nested("d"), name: "ask_user", status: "paused" },
      { executionId: nested("e"), name: "shell", status: "running" },
    ]);
  });

  it("tolerates malformed payloads", () => {
    expect(
      subagentToolCalls(
        [
          { type: "agent.tool.called", payload: null },
          { type: "agent.tool.completed", payload: { executionId: 4 } },
        ],
        agentId,
      ),
    ).toEqual([]);
  });
});

describe("subagentRedoPrompt", () => {
  it("passes the stored input as exact JSON arguments", () => {
    const prompt = subagentRedoPrompt({
      name: "Research",
      task: 'Find "quoted" facts\nand list them.',
      instructions: "Be brief.",
      modelProvider: "openai",
      modelId: "gpt-test",
    });
    const json = prompt.split("\n").at(-1) ?? "";
    expect(JSON.parse(json)).toEqual({
      name: "Research",
      task: 'Find "quoted" facts\nand list them.',
      instructions: "Be brief.",
      model_provider: "openai",
      model_id: "gpt-test",
    });
    expect(prompt).toContain("run_subagent exactly once");
    expect(prompt.toLowerCase()).toContain("subagent");
  });

  it("omits optional arguments the first call did not set", () => {
    const prompt = subagentRedoPrompt({ name: "helper", task: "Do it.", modelProvider: "x" });
    expect(JSON.parse(prompt.split("\n").at(-1) ?? "")).toEqual({
      name: "helper",
      task: "Do it.",
    });
  });
});
