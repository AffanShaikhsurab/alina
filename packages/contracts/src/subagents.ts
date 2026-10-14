import * as z from "zod";
import { Id } from "./ids.js";

/** Runtime agent ids are opaque strings (a JSON-encoded tool call id for Pi). */
const AgentId = z.string().min(1).max(1000);

export const SubagentRefInput = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
    runId: Id,
    agentId: AgentId,
  })
  .superRefine((input, ctx) => {
    if (Boolean(input.botId) === Boolean(input.groupId)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });
export type SubagentRefInput = z.infer<typeof SubagentRefInput>;

export const SubagentRedoInput = z.object({
  botId: Id,
  runId: Id,
  agentId: AgentId,
  clientNonce: z.string().min(1).max(200).optional(),
});
export type SubagentRedoInput = z.infer<typeof SubagentRedoInput>;

export const SubagentToolCallSchema = z.object({
  executionId: z.string(),
  name: z.string(),
  status: z.enum(["running", "succeeded", "error", "paused"]),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type SubagentToolCall = z.infer<typeof SubagentToolCallSchema>;

export const SubagentDetailSchema = z.object({
  runId: Id,
  agentId: z.string(),
  name: z.string(),
  task: z.string(),
  instructions: z.string().optional(),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]),
  progress: z.string().optional(),
  result: z.string().optional(),
  tools: z.array(SubagentToolCallSchema),
  /** False when the chat cannot start the same sub-agent again right now. */
  canRedo: z.boolean(),
});
export type SubagentDetail = z.infer<typeof SubagentDetailSchema>;
