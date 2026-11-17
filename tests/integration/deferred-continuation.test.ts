import {describe,it,expect,vi} from "vitest";
import {createFakePluginHost} from "@get-bb/plugin-sdk/testing";
import {scheduleDeferred,readDeferred,cancelDeferred,deferredKey,inspectDeferred} from "../../src/server/deferred-continuation";
import {quotaHeadroom,parseOllamaBalance} from "../../src/shared/ollama-usage";

const key=deferredKey("proj_1","main","lead");
function fixture(){
 let rows:Array<{id:string;sendAt:number|null;updatedAt:number;state:string}>=[];
 const retry=vi.fn(async({sendAt}:{sendAt?:number})=>{rows=[{id:"queue_retry",sendAt:sendAt!,updatedAt:1,state:"scheduled"}];return {ok:true,delivery:"queued",queuedMessageId:"queue_retry",sendAt,turnRequestId:"request",attempt:2};});
 const update=vi.fn(async(args:{queuedMessageId:string;sendAt?:number|null;expectedUpdatedAt:number})=>{const row=rows.find(r=>r.id===args.queuedMessageId)!;if(args.expectedUpdatedAt!==row.updatedAt)throw new Error("conflict");Object.assign(row,{sendAt:args.sendAt,updatedAt:row.updatedAt+1});return row;});
 const f=createFakePluginHost({pluginId:"team",sdk:{threads:{retry:retry as never,queuedMessages:{list:async()=>rows as never,update:update as never,delete:async({queuedMessageId})=>{rows=rows.filter(r=>r.id!==queuedMessageId);return {ok:true};}}}}});
 return {...f,retry,update,set:(v:typeof rows)=>{rows=v;},rows:()=>rows};
}
describe("native deferred continuation without a second scheduler",()=>{
 it("reserves before retry, persists exactly one native queued id, survives reload",async()=>{
  const f=fixture();try{
   const record=await scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,turnRequestId:"failed_1",sendAt:120_000},0);
   expect(f.retry).toHaveBeenCalledWith(expect.objectContaining({turnRequestId:"failed_1",sendAt:120_000}));expect(record).toMatchObject({stage:"scheduled",queuedMessageId:"queue_retry",owned:true});
   expect(await readDeferred(f.bb,key)).toEqual(record);
   await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt:120_000},0)).rejects.toThrow("existing");expect(f.retry).toHaveBeenCalledTimes(1);
   await cancelDeferred(f.bb,key);expect(f.rows()).toEqual([]);expect(await readDeferred(f.bb,key)).toBeNull();
  }finally{await f.harness.lifecycle.dispose();}
 });
 it("defers the existing original row and restores its date on cancel, never copies content",async()=>{
  const f=fixture();f.set([{id:"original",sendAt:null,updatedAt:4,state:"waiting"}]);try{
   await scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:"task_a",failed:false,sendAt:120_000},0);
   expect(f.retry).not.toHaveBeenCalled();expect(f.update).toHaveBeenCalledWith({threadId:"thr_a",queuedMessageId:"original",expectedUpdatedAt:4,sendAt:120_000});
   await cancelDeferred(f.bb,key);expect(f.rows()[0]?.sendAt).toBeNull();
  }finally{await f.harness.lifecycle.dispose();}
 });
 it("does not duplicate a retry whose response was lost",async()=>{
  const f=fixture();f.retry.mockImplementationOnce(async()=>{throw new Error("lost reply");});try{
   await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt:120_000},0)).rejects.toThrow("uncertain");
   expect(await readDeferred(f.bb,key)).toMatchObject({stage:"needs-decision",queuedMessageId:null});
   await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt:120_000},0)).rejects.toThrow();expect(f.retry).toHaveBeenCalledTimes(1);
  }finally{await f.harness.lifecycle.dispose();}
 });
 it("rejects idle/no work, multiple rows, changed cancellation and invalid time before a call",async()=>{
  const f=fixture();try{
   for(const sendAt of [1,32*86400_000])await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt},0)).rejects.toThrow("Choose");
   await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:false,sendAt:120_000},0)).rejects.toThrow("No queued work");
   f.set([{id:"a",sendAt:null,updatedAt:1,state:"queued"},{id:"b",sendAt:null,updatedAt:1,state:"queued"}]);
   await expect(scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt:120_000},0)).rejects.toThrow("multiple");
   f.set([{id:"a",sendAt:null,updatedAt:1,state:"queued"}]);await scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:false,sendAt:120_000},0);f.rows()[0]!.sendAt=130_000;
   await expect(cancelDeferred(f.bb,key)).rejects.toThrow("changed");expect(f.retry).not.toHaveBeenCalled();
  }finally{await f.harness.lifecycle.dispose();}
 });
});
describe("shared quota headroom",()=>{
 it("holds at 10% even when another window is healthy; reset requires every limiting window",()=>{
  const u=parseOllamaBalance({included:{session:{remaining_percent:10,resets_at:"2026-11-15T02:00:00Z"},weekly:{remaining_percent:0,resets_at:"2026-11-16T00:00:00Z"}}},100);
  expect(quotaHeadroom(u)).toMatchObject({unknown:false,held:true,remainingPercent:0,resetAtMs:Date.parse("2026-11-16T00:00:00Z")});
  expect(quotaHeadroom({...u,windows:[{name:"session",remainingPercent:10.1,resetsAtMs:null}]}).held).toBe(false);
  expect(quotaHeadroom({...u,windows:[{name:"session",remainingPercent:5,resetsAtMs:null}]}).resetAtMs).toBeNull();
 });
 it("unknown is not evidence of recovery; a last-known low balance stays held",()=>{
  expect(quotaHeadroom(undefined)).toMatchObject({unknown:true,held:false,remainingPercent:null});
  const u=parseOllamaBalance({included:{weekly:{remaining_percent:9}}},1);expect(quotaHeadroom({...u,status:"unavailable"})).toMatchObject({unknown:true,held:true});
  expect(quotaHeadroom(u,{pauseBelowPercent:0}).held).toBe(false);
 });
});


describe("read-only continuation snapshot",()=>{
 it("reports the source queue and detects external changes without mutating or retrying",async()=>{
  const f=fixture();try{
   await scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:"task_a",failed:true,sendAt:120_000},0);
   expect(await inspectDeferred(f.bb,"proj_1","main","lead","thr_a")).toMatchObject({stage:"scheduled",source:"bb-queue",queueState:"scheduled",queueSendAt:120_000});
   const saved=await readDeferred(f.bb,key);f.rows()[0]!.sendAt=180_000;
   expect(await inspectDeferred(f.bb,"proj_1","main","lead","thr_a")).toMatchObject({stage:"needs-decision",queueSendAt:180_000});
   expect(await readDeferred(f.bb,key)).toEqual(saved);expect(f.retry).toHaveBeenCalledTimes(1);expect(f.update).not.toHaveBeenCalled();
   f.set([]);expect(await inspectDeferred(f.bb,"proj_1","main","lead","thr_a")).toMatchObject({stage:"needs-decision",queueState:null});
  }finally{await f.harness.lifecycle.dispose();}
 });
 it("distinguishes released intent from an observed start and preserves stale-session uncertainty",async()=>{
  const f=fixture();try{
   const r=await scheduleDeferred(f.bb,key,{threadId:"thr_a",taskId:null,failed:true,sendAt:120_000},0);
   await f.bb.storage.kv.set(key,{...r,stage:"released"});f.set([]);
   expect(await inspectDeferred(f.bb,"proj_1","main","lead","thr_a")).toMatchObject({stage:"released",queueState:null});
   expect(await inspectDeferred(f.bb,"proj_1","main","lead","new-session")).toMatchObject({stage:"needs-decision"});
   await f.bb.storage.kv.set(key,{broken:true});expect(await inspectDeferred(f.bb,"proj_1","main","lead","thr_a")).toMatchObject({stage:"needs-decision",sendAt:null});
  }finally{await f.harness.lifecycle.dispose();}
 });
});
