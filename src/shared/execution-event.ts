import {z} from "zod";

const id = z.string().max(200);
export const executionEventSchema = z.object({
  timestamp: z.number(), projectId: id, team: id, taskId: z.union([id, z.number()]).nullable(),
  role: id, threadId: id.nullable(), operationId: id,
  eventType: z.enum(["attempt", "handoff", "fallback", "decision"]),
  previousState: id.nullable(), nextState: id, reasonCode: id,
  message: z.string().max(200), provider: id.nullable(), model: id.nullable(),
}).strict();
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
