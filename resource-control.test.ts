import {describe,it,expect} from "vitest";
import {createFakePluginHost,makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import type {MessageDispatchHookContext,PluginTurnFailedEvent,ThreadEventRow} from "@get-bb/plugin-sdk";
import {verifyQuotaBoundary,type WorkCheckpoint} from "./checkpoint";
import {ResourceControl,DEFAULT_RESOURCE_POLICY,type ResourceOwner} from "./resource-control";
function fixture(){
 let now=1000;const events=new Map<string,ThreadEventRow[]>();const owners=new Map<string,ResourceOwner>();
 const base={projectId:"p",team:"main",role:"dev",taskId:"task-1",ownerThreadId:"dev",hostId:"host"};
 for(const id of ["dev","helper","fresh","other","lead"]){owners.set(id,{...base,ownerThreadId:id==="helper"?"dev":id,role:id==="lead"?"lead":"dev",taskId:id==="lead"?null:id==="other"?"task-2":"task-1"});}
 const {bb}=createFakePluginHost({pluginId:"resource-test",sdk:{threads:{
   get:async({threadId})=>makeThreadResponse({id:threadId,projectId:"p",providerId:"pi",status:"idle"}),
   events:{list:async({threadId,afterSeq})=>(events.get(threadId)??[]).filter(r=>r.seq>Number(afterSeq??0))},
 }}});
 const owner=async(id:string)=>owners.get(id)??null;
 const create=()=>new ResourceControl(bb,owner,()=>{},()=>now);
 let control=create();let seq=0;
 const event=(id:string,type:string,data:unknown)=>{const row={id:`e${++seq}`,threadId:id,scope:"thread",seq,createdAt:now,type,data} as ThreadEventRow;events.set(id,[...(events.get(id)??[]),row]);};
 const ctx=(id="dev",request="1",initiator="agent")=>({thread:makeThreadResponse({id,projectId:"p",providerId:"pi",status:"idle",updatedAt:now}),attempt:"start-turn",queuedMessages:[{id:request}],input:{text:request,blocks:[]},requestedExecution:{providerId:"pi",model:"ollama/model",reasoningLevel:null,serviceTier:null,permissionMode:null},initiator} as unknown as MessageDispatchHookContext);
 return {bb,owners,event,ctx,owner,scope:base,get control(){return control;},restart(){control=create();},tick(){now+=1000;},fail:(patch:Partial<PluginTurnFailedEvent>={})=>({threadId:"dev",requestId:"req-1",turnId:null,inputAccepted:false,errorInfo:{category:"budget-exceeded",httpStatusCode:429,providerCode:"quota"},rateLimits:null,attemptNumber:1,originPluginId:"team",...patch} as PluginTurnFailedEvent)};
}
describe("durable Team resource admission",()=>{
 it("counts one admission across queue re-evaluation, event replay and reload",async()=>{
  const f=fixture();expect(await f.control.admit(f.ctx())).toEqual({action:"proceed"});
  await f.control.queued("dev","queued-original");f.tick();
  expect(await f.control.admit(f.ctx("dev","queued-original"))).toEqual({action:"proceed"});
  f.event("dev","client/turn/requested",{requestId:"req-1"});f.event("dev","turn/started",{});
  f.event("dev","thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:120}}});
  f.event("dev","turn/completed",{status:"completed"});
  await f.control.settle("dev","completed");f.restart();await f.control.settle("dev","completed");
  const s=await f.control.inspect(f.scope);expect(s.starts).toBe(1);expect(s.reportedTokens).toBe(120);expect(s.attempts[0]).toMatchObject({requestId:"req-1",outcome:"completed",provider:"pi",model:"ollama/model"});
 });
 it("includes helpers and replacement threads and stops a new card bypass",async()=>{
  const f=fixture();await f.control.decide(f.scope,"Two calls agreed",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  await f.control.admit(f.ctx("helper","two"));await f.control.settle("helper","completed");f.tick();
  expect((await f.control.admit(f.ctx("fresh","three","system"))).action).toBe("wait");
  expect((await f.control.admit(f.ctx("other","new-card"))).action).toBe("wait");
  expect((await f.control.inspect(f.scope)).starts).toBe(2);
 });
 it("all initiators share the same limit; joins do not create a new start",async()=>{
  const f=fixture();await f.control.decide(f.scope,"One start",{...DEFAULT_RESOURCE_POLICY,teamStarts:1});
  await f.control.admit(f.ctx());await f.control.settle("dev","completed");
  for(const initiator of ["system","agent","user"]){expect((await f.control.admit(f.ctx("other",initiator,initiator))).action).toBe("wait");}
  expect(await f.control.admit({...f.ctx(),attempt:"join-turn"})).toEqual({action:"proceed"});
 });
 it("stops a failed turn's automatic retry until a concrete decision, retaining counters",async()=>{
  const f=fixture();await f.control.admit(f.ctx());await f.control.failed(f.fail({errorInfo:{category:"overloaded",httpStatusCode:503,providerCode:null}}),[]);
  expect((await f.control.admit(f.ctx("dev","system-retry","system"))).action).toBe("wait");
  await expect(f.control.decide(f.scope," ",undefined,"task-1")).rejects.toThrow("concrete");
  await f.control.decide(f.scope,"Use narrower input after checking the error",undefined,"task-1");f.tick();
  expect((await f.control.admit(f.ctx("dev","manual-retry"))).action).toBe("proceed");expect((await f.control.inspect(f.scope)).starts).toBe(2);
 });
 it("unknown usage is null, cumulative samples are not context usage or duplicated",async()=>{
  const f=fixture();await f.control.admit(f.ctx());expect((await f.control.inspect(f.scope)).reportedTokens).toBeNull();
  for(const n of [100,160,160,20])f.event("dev","thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:n}}});
  f.event("dev","thread/contextWindowUsage/updated",{usedTokens:99999});
  let s=await f.control.inspect(f.scope);expect(s.reportedTokens).toBe(180);expect(s.usageCoverage).toBe("partial");
  f.restart();s=await f.control.inspect(f.scope);expect(s.reportedTokens).toBe(180);
 });
 it("checks reported tokens and elapsed time before more work, including lead",async()=>{
  const f=fixture();await f.control.decide(f.scope,"Token ceiling",{...DEFAULT_RESOURCE_POLICY,tokens:10});await f.control.admit(f.ctx());
  f.event("dev","thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:10}}});
  expect((await f.control.admit(f.ctx("lead","review"))).action).toBe("wait");
  await f.control.decide(f.scope,"Increase ceiling explicitly",{...DEFAULT_RESOURCE_POLICY,minutes:1});
  for(let i=0;i<61;i++)f.tick();expect((await f.control.admit(f.ctx("lead","after-time"))).action).toBe("wait");
 });
 it("shares provider quota across models, has no paid/default fallback, and deduplicates failure",async()=>{
  const f=fixture();await f.control.admit(f.ctx());
  const candidates=[{provider:"pi",model:"same-pool"},{provider:"opencode2",model:"approved-free",reasoningLevel:"low"}];
  const result=await f.control.failed(f.fail(),candidates);expect(result?.selection).toEqual(candidates[1]);
  expect(await f.control.failed(f.fail(),candidates)).toBeNull();
  expect((await f.control.admit(f.ctx("dev","system-retry","system"))).action).toBe("reject");
  await f.control.authorizeFallback(f.scope,"req-1");await f.control.fallbackStage(f.scope,"req-1","complete",undefined,"fresh");
  f.tick();expect((await f.control.admit({...f.ctx("fresh","continue"),requestedExecution:{...f.ctx().requestedExecution,providerId:"opencode2",model:"approved-free"}})).action).toBe("proceed");
  const s=await f.control.inspect(f.scope);expect(s.starts).toBe(2);expect(s.fallbacks[0]?.newThreadId).toBe("fresh");
 });
 it("does not classify arbitrary 429 or auth as quota and stops an empty/shared pool",async()=>{
  for(const category of ["unknown","unauthorized"] as const){const f=fixture();await f.control.admit(f.ctx());expect(await f.control.failed(f.fail({errorInfo:{category,httpStatusCode:429,providerCode:null}}),[{provider:"free",model:"free"}])).toBeNull();}
  const f=fixture();await f.control.admit(f.ctx());const result=await f.control.failed(f.fail(),[{provider:"pi",model:"other-pi-model"}]);expect(result?.stage).toBe("blocked");expect(result?.selection).toBeNull();
 });
});

it("known shared quota windows apply across providers and scopes, reset without model probes",async()=>{
 const f=fixture();await f.control.admit({...f.ctx("other","other-provider"),requestedExecution:{...f.ctx().requestedExecution,providerId:"opencode2"}});
 const rate={providerId:"opencode2",status:"warning",kind:"subscription-window",windows:[{providerKey:"private-account-window",status:"warning",resetsAtMs:2000}]};
 f.event("other","provider/rateLimits/updated",{rateLimits:rate});await f.control.inspect(f.scope);
 await f.control.admit(f.ctx());
 const quotaRate={...rate,providerId:"pi",status:"blocked",windows:[{...rate.windows[0],status:"blocked"}]};
 const failure=f.fail({rateLimits:quotaRate as never});
 const planned=await f.control.failed(failure,[{provider:"opencode2",model:"same-account"},{provider:"codex",model:"independent"}]);
 expect(planned?.selection?.provider).toBe("codex");
 // Another team shares the host/provider quota, even with another task card.
 f.owners.set("fresh",{...f.scope,team:"second",ownerThreadId:"fresh"});
 expect((await f.control.admit({...f.ctx("fresh","quota-other-team"),requestedExecution:{...f.ctx().requestedExecution,providerId:"opencode2"}})).action).toBe("wait");
 f.tick();f.tick();
 expect((await f.control.admit(f.ctx("fresh","after-reset"))).action).toBe("proceed");
 expect(JSON.stringify(await f.control.inspect(f.scope))).not.toContain("private-account-window");
});
it("failure replay after a deliberate repair does not re-block the task",async()=>{
 const f=fixture();await f.control.admit(f.ctx());const failed=f.fail({errorInfo:{category:"overloaded",httpStatusCode:503,providerCode:null}});
 await f.control.failed(failed,[]);await f.control.decide(f.scope,"Reduce the input",undefined,"task-1");f.restart();await f.control.failed(failed,[]);
 f.tick();expect((await f.control.admit(f.ctx("dev","fixed"))).action).toBe("proceed");
});
it("observes explicit BB overrides and preserves the cumulative baseline from before accounting",async()=>{
 const f=fixture();
 f.event("dev","turn/started",{});f.event("dev","thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:12}}});f.event("dev","turn/completed",{status:"completed"});
 await f.control.watch("dev");const s=await f.control.inspect(f.scope);expect(s.starts).toBe(1);expect(s.attempts[0]?.initiator).toBe("override/observed");expect(s.reportedTokens).toBe(12);
});
it("keeps an already reserved last slot through read/re-evaluation without admitting another",async()=>{
 const f=fixture();await f.control.decide(f.scope,"One slot",{...DEFAULT_RESOURCE_POLICY,teamStarts:1});await f.control.admit(f.ctx());
 await f.control.inspect(f.scope);f.restart();expect((await f.control.admit(f.ctx())).action).toBe("proceed");expect((await f.control.admit(f.ctx("other","another"))).action).toBe("wait");
});

it("review returns use the same finite task budget and cannot be replayed to inflate it",async()=>{
 const f=fixture();await f.control.decide(f.scope,"Two work attempts",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 const decision={decision:"changes-requested",reason:"Fix the missing check",atMs:1};
 await f.control.returned(f.scope,"task-1","dev",decision);await f.control.returned(f.scope,"task-1","dev",decision);f.restart();
 expect((await f.control.inspect(f.scope)).taskCounts.find(t=>t.taskId==="task-1")).toMatchObject({starts:1,returns:1});
 expect((await f.control.admit(f.ctx("fresh","rework"))).action).toBe("wait");
});

it("an automated close/drop cannot launder an exhausted task into a new card",async()=>{
 const f=fixture();await f.control.decide(f.scope,"One task attempt",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1});await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 await f.control.finished(f.scope,"task-1");f.tick();expect((await f.control.admit(f.ctx("other","new-card"))).action).toBe("wait");
 await f.control.decide(f.scope,"I inspected the exhausted work and explicitly authorize different work");expect((await f.control.admit(f.ctx("other","new-work"))).action).toBe("proceed");
 expect((await f.control.inspect(f.scope)).starts).toBe(2);
});

it("a core retry queued before turn.failed is not mistaken for the old reservation",async()=>{
 const f=fixture();await f.control.admit(f.ctx());f.event("dev","client/turn/requested",{requestId:"req-1"});await f.control.queued("dev","retry-row",true);
 const ctx=f.ctx("dev","retry-row","system");ctx.thread.status="pending";ctx.queuedMessages=[{id:"retry-row",payload:{kind:"retry",attempt:2,reason:"network",retryOfTurnRequestId:"req-1"}}] as never;
 expect((await f.control.admit(ctx)).action).toBe("wait");expect((await f.control.inspect(f.scope)).starts).toBe(1);
 ctx.thread.status="error";expect((await f.control.admit(ctx)).action).toBe("wait");expect((await f.control.inspect(f.scope)).starts).toBe(1);
});

it("unavailable request history explicitly stops automatic quota recovery",async()=>{
 const {bb}=createFakePluginHost({pluginId:"history-test",sdk:{threads:{events:{list:async()=>{throw new Error("Unavailable");}}}}});
 const f=fixture();await expect(verifyQuotaBoundary(bb,f.fail(),{atMs:1000} as WorkCheckpoint)).rejects.toMatchObject({code:"checkpoint_history_unavailable"});
});
