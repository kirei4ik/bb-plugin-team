import { PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract";
import type { TaskId } from "./snapshot";

const text = z.string().trim().min(1).max(16000);
export const checkpointContentSchema = z
  .object({
    goal: text,
    criteria: z.array(text).min(1).max(100),
    progress: text,
    decisions: z.array(z.object({ what: text, why: text }).strict()).max(100),
    checks: z.array(z.object({ what: text, result: text }).strict()).max(100),
    blockers: z.array(text).max(100),
    nextAction: text,
    files: z.array(text).max(200),
  })
  .strict();

export const workCheckpointSchema = z
  .object({
    version: z.literal(1),
    taskId: z.union([z.number().int().positive(), z.string().min(1)]),
    role: z.string().min(1),
    threadId: z.string().min(1),
    environmentId: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().nullable(),
    commit: z.string().min(1),
    fingerprint: z.string().min(1),
    dirtyFiles: z.array(z.string()),
    atMs: z.number(),
    content: checkpointContentSchema,
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 65536,
    "Checkpoint must fit within 64 KiB",
  );
export type WorkCheckpoint = z.infer<typeof workCheckpointSchema>;

export async function environmentState(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (!thread.environmentId)
    throw new PluginCliError("Thread has no environment to preserve", {
      code: "environment_missing",
    });
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (!environment.path || environment.status !== "ready") {
    throw new PluginCliError(
      "The existing environment is not ready or has no path",
      { code: "environment_unavailable" },
    );
  }
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const state = await host.call(
    "gitState",
    { cwd: environment.path },
    { hostId: environment.hostId },
  );
  return { thread, environment, state };
}

export async function captureCheckpoint(
  bb: BbPluginApi,
  taskId: TaskId,
  role: string,
  threadId: string,
  content: unknown,
): Promise<WorkCheckpoint> {
  const parsed = checkpointContentSchema.parse(content);
  const { thread, environment, state } = await environmentState(bb, threadId);
  return workCheckpointSchema.parse({
    version: 1,
    taskId,
    role,
    threadId,
    environmentId: thread.environmentId,
    hostId: environment.hostId,
    path: environment.path,
    ...state,
    atMs: Date.now(),
    content: parsed,
  });
}

export async function verifyCheckpoint(
  bb: BbPluginApi,
  checkpoint: WorkCheckpoint,
): Promise<void> {
  const { thread, environment, state } = await environmentState(
    bb,
    checkpoint.threadId,
  );
  if (
    thread.environmentId !== checkpoint.environmentId ||
    environment.hostId !== checkpoint.hostId ||
    environment.path !== checkpoint.path ||
    state.branch !== checkpoint.branch ||
    state.commit !== checkpoint.commit ||
    state.fingerprint !== checkpoint.fingerprint
  ) {
    throw new PluginCliError(
      "Environment changed since checkpoint; save a fresh checkpoint before replacing the session",
      { code: "checkpoint_stale" },
    );
  }
}

/** Automatic quota recovery is narrower than an explicit human replacement.
 * A Git fingerprint cannot prove that external side effects after a checkpoint
 * were recorded. Require the refused request's causal marker and no earlier
 * work after the checkpoint. Never ask the exhausted model to fill this gap.
 */
export async function verifyQuotaBoundary(
  bb:BbPluginApi,
  failure:import("@get-bb/plugin-sdk").PluginTurnFailedEvent,
  checkpoint:WorkCheckpoint,
):Promise<void>{
  if(failure.inputAccepted)throw new PluginCliError("The failed turn accepted input; checkpoint coverage of its actions is uncertain. Inspect and checkpoint the work before manual recovery",{code:"quota_input_accepted"});
  const rows:Array<{seq:number;createdAt:number;type:string;data:Record<string,unknown>}>=[];
  let beforeSeq:string|undefined,complete=false;
  try{
    for(let page=0;page<20;page++){
      const batch=await bb.sdk.threads.events.list({threadId:failure.threadId,order:"desc",limit:"100",...(beforeSeq?{beforeSeq}:{}),types:["client/turn/requested","turn/started","turn/completed","turn/input/accepted"]});
      rows.push(...batch.map(row=>({seq:row.seq,createdAt:row.createdAt,type:row.type,data:row.data as unknown as Record<string,unknown>})));
      if(batch.length<100||batch.some(row=>row.createdAt<checkpoint.atMs)){complete=true;break;}
      beforeSeq=String(Math.min(...batch.map(row=>row.seq)));
    }
  }catch{throw new PluginCliError("Cannot verify the refused request's execution history; automatic quota handoff stopped",{code:"checkpoint_history_unavailable"});}
  const current=rows.find(row=>row.type==="client/turn/requested"&&row.data.requestId===failure.requestId);
  if(!complete||!current)throw new PluginCliError("The refused request's history is unavailable or incomplete; inspect the task before manual recovery",{code:"checkpoint_history_unavailable"});
  const after=rows.filter(row=>row.createdAt>=checkpoint.atMs);
  const uncovered=after.some(row=>row.type==="client/turn/requested"?row.data.requestId!==failure.requestId:
    row.seq<current.seq||row.type==="turn/input/accepted"||row.type==="turn/completed"&&row.data.status==="completed");
  if(uncovered)throw new PluginCliError("There was work after the saved checkpoint; a matching Git tree alone does not cover its side effects",{code:"checkpoint_history_stale"});
}
