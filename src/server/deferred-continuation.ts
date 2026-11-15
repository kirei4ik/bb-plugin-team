import {createHash} from "node:crypto";
import {z} from "zod";
import type {BbPluginApi} from "@get-bb/plugin-sdk";
import type {TaskId} from "../shared/snapshot";

export const deferredContinuationSchema=z.object({
 threadId:z.string(),taskId:z.union([z.string(),z.number()]).nullable(),sendAt:z.number().finite(),
 stage:z.enum(["preparing","scheduled","needs-decision","released"]),
 fingerprint:z.string().nullable(),queuedMessageId:z.string().nullable(),owned:z.boolean(),previousSendAt:z.number().nullable(),
 reason:z.string().max(1000).nullable(),
}).strict();
export type DeferredContinuation=z.infer<typeof deferredContinuationSchema>;
export const deferredKey=(projectId:string,team:string,role:string)=>`deferred:${projectId}:${team}:${role}`;
export async function readDeferred(bb:BbPluginApi,key:string):Promise<DeferredContinuation|null>{
 const raw=await bb.storage.kv.get(key);if(raw==null)return null;
 return deferredContinuationSchema.parse(raw); // damaged intent must not allow a duplicate
}
// State/retry timestamps can change while core waits; the actual input and
// execution selection must stay exactly the ones the user deferred.
export function queuedFingerprint(row:Record<string,unknown>){
 return createHash("sha256").update(JSON.stringify([row.content,row.payload,row.model,row.reasoningLevel,row.serviceTier,row.permissionMode,row.initiator,row.senderThreadId,row.groupWithNext])).digest("hex");
}
/** Only stores a binding. Core BB owns time, message content and dispatch. */
export async function scheduleDeferred(bb:BbPluginApi,key:string,input:{threadId:string;taskId:TaskId|null;sendAt:number;failed:boolean;turnRequestId?:string},now=Date.now()){
 if(input.sendAt<now+60_000||input.sendAt>now+31*86400_000)throw new Error("Choose a time from one minute to 31 days ahead");
 const prior=await readDeferred(bb,key);
 if(prior&&prior.stage!=="released")throw new Error("An existing continuation needs inspection or cancellation first");
 const queue=await bb.sdk.threads.queuedMessages.list({threadId:input.threadId});
 if(queue.length>1)throw new Error("Inspect multiple queued messages in the thread before scheduling");
 const existing=queue[0];
 if(existing&&!["queued","scheduled","waiting"].includes(existing.state))throw new Error("The queued message is already being processed");
 if(!existing&&!input.failed)throw new Error("No queued work or failed turn to continue; send the employee a concrete task first");
 const record:DeferredContinuation={threadId:input.threadId,taskId:input.taskId,sendAt:input.sendAt,stage:"preparing",fingerprint:null,queuedMessageId:existing?.id??null,owned:!existing,previousSendAt:existing?.sendAt??null,reason:null};
 // Write-ahead: a lost RPC response cannot cause a second retry.
 await bb.storage.kv.set(key,record);
 try{
  let confirmed:Record<string,unknown>|undefined;
  if(existing)confirmed=await bb.sdk.threads.queuedMessages.update({threadId:input.threadId,queuedMessageId:existing.id,expectedUpdatedAt:existing.updatedAt,sendAt:input.sendAt});
  else {
   const result=await bb.sdk.threads.retry({threadId:input.threadId,...(input.turnRequestId?{turnRequestId:input.turnRequestId}:{}),sendAt:input.sendAt,reason:"Team: user scheduled continuation; quota and budgets will be checked again"});
   if(result.delivery!=="queued"||result.sendAt!==input.sendAt)throw new Error("Core did not confirm the scheduled retry");
   record.queuedMessageId=result.queuedMessageId;
   confirmed=(await bb.sdk.threads.queuedMessages.list({threadId:input.threadId})).find(r=>r.id===result.queuedMessageId);
  }
  if(!confirmed||confirmed.sendAt!==input.sendAt)throw new Error("Queued row confirmation missing");
  record.fingerprint=queuedFingerprint(confirmed);
  record.stage="scheduled";await bb.storage.kv.set(key,record);return record;
 }catch{
  record.stage="needs-decision";record.reason="Queue result is uncertain. Inspect the thread queue; do not repeat the operation blindly.";
  await bb.storage.kv.set(key,record);throw new Error(record.reason);
 }
}
export async function cancelDeferred(bb:BbPluginApi,key:string){
 const record=await readDeferred(bb,key);if(!record)return;
 if(record.stage==="released") {await bb.storage.kv.delete(key);return;}
 if(!record.queuedMessageId)throw new Error("Queue result is uncertain; inspect the thread queue before clearing the intent");
 const row=(await bb.sdk.threads.queuedMessages.list({threadId:record.threadId})).find(r=>r.id===record.queuedMessageId);
 if(row){
  if(!["queued","scheduled","waiting"].includes(row.state)||row.sendAt!==record.sendAt)throw new Error("Queued work changed; inspect it before cancelling");
  if(record.owned)await bb.sdk.threads.queuedMessages.delete({threadId:record.threadId,queuedMessageId:row.id});
  else await bb.sdk.threads.queuedMessages.update({threadId:record.threadId,queuedMessageId:row.id,expectedUpdatedAt:row.updatedAt,sendAt:record.previousSendAt});
 }
 await bb.storage.kv.delete(key);
}
