import type { SubagentDetail, SubagentToolCall } from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { rpc } from "./api";

export type SubagentTarget = { botId: string } | { groupId: string };

export function fetchSubagent(
  target: SubagentTarget,
  runId: string,
  agentId: string,
): Promise<SubagentDetail> {
  return rpc<SubagentDetail>("subagents/get", { ...target, runId, agentId });
}

/** The server starts the run; the thread shows it through its live subscription. */
export function redoSubagent(
  botId: string,
  runId: string,
  agentId: string,
  clientNonce: string,
): Promise<{ ok: true; runId: string }> {
  return rpc("subagents/redo", { botId, runId, agentId, clientNonce });
}

/** "Web search ×2 · Read file" for a turn's tool steps. */
export function toolStepsText(steps: ReadonlyArray<{ label: string; count: number }>): string {
  return steps
    .filter((step) => step.label)
    .map((step) => (step.count > 1 ? `${step.label} ×${step.count}` : step.label))
    .join(" · ");
}

export function subagentToolLabel(call: Pick<SubagentToolCall, "name">): string {
  return humanizeToolName(call.name) || call.name;
}

/** SF Symbol / Ionicon for a tool call's state. */
export function subagentToolSymbol(status: SubagentToolCall["status"]): {
  ios: string;
  android: "checkmark-circle" | "close-circle" | "pause-circle" | "ellipsis-horizontal-circle";
} {
  if (status === "succeeded") return { ios: "checkmark.circle", android: "checkmark-circle" };
  if (status === "error") return { ios: "xmark.circle", android: "close-circle" };
  if (status === "paused") return { ios: "pause.circle", android: "pause-circle" };
  return { ios: "ellipsis.circle", android: "ellipsis-horizontal-circle" };
}
