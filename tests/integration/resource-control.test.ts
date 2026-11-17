import {describe,it,expect,beforeEach} from "vitest";
import {createHash} from "node:crypto";
import {createFakePluginHost,makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import type {MessageDispatchHookContext,PluginTurnFailedEvent,ThreadEventRow} from "@get-bb/plugin-sdk";
import {verifyQuotaBoundary,type WorkCheckpoint} from "../../src/server/checkpoint";
import {ResourceControl,DEFAULT_RESOURCE_POLICY,withResourceResults,type ResourceOwner} from "../../src/server/resource-control";
function fixture(validateEpic?:(owner:ResourceOwner,epicId:string)=>Promise<{title:string;criteria?:string;scopeRevision:string}>){
 let now=1000;const events=new Map<string,ThreadEventRow[]>();const owners=new Map<string,ResourceOwner>();
 const base={projectId:"p",team:"main",role:"dev",taskId:"task-1",ownerThreadId:"dev",hostId:"host"};
 for(const id of ["dev","helper","fresh","other","lead"]){owners.set(id,{...base,ownerThreadId:id==="helper"?"dev":id,role:id==="lead"?"lead":"dev",taskId:id==="lead"?null:id==="other"?"task-2":"task-1"});}
 const {bb}=createFakePluginHost({pluginId:"resource-test",sdk:{threads:{
   get:async({threadId})=>makeThreadResponse({id:threadId,projectId:"p",providerId:"pi",status:"idle"}),
   events:{list:async({threadId,afterSeq})=>(events.get(threadId)??[]).filter(r=>r.seq>Number(afterSeq??0))},
 }}});
 const owner=async(id:string)=>owners.get(id)??null;
 const create=()=>new ResourceControl(bb,owner,()=>{},()=>now,validateEpic);
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
 it("shares one package allowance across helpers and sessions, isolating new packages",async()=>{
  const f=fixture();await f.control.decide(f.scope,"Two calls agreed",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  await f.control.admit(f.ctx("helper","two"));await f.control.settle("helper","completed");f.tick();
  expect((await f.control.admit(f.ctx("fresh","three","system"))).action).toBe("wait");
  expect((await f.control.admit(f.ctx("other","new-card"))).action).toBe("proceed");
  expect((await f.control.inspect(f.scope)).starts).toBe(3);
 });
 it("all initiators share the same limit; joins do not create a new start",async()=>{
  const f=fixture();await f.control.decide(f.scope,"One start",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1});
  await f.control.admit(f.ctx());await f.control.settle("dev","completed");
  for(const initiator of ["system","agent","user"]){expect((await f.control.admit(f.ctx("fresh",initiator,initiator))).action).toBe("wait");}
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

it("known reset time requires fresh structured confirmation across providers and restart",async()=>{
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
 f.restart();
 expect((await f.control.admit(f.ctx("fresh","after-reset"))).action).toBe("wait");
 f.event("dev","provider/rateLimits/updated",{rateLimits:{...quotaRate,status:"allowed",windows:[{...quotaRate.windows[0],status:"allowed"}]}});
 await f.control.inspect(f.scope);
 expect((await f.control.admit(f.ctx("fresh","after-confirmation"))).action).toBe("proceed");
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
 const f=fixture();await f.control.decide(f.scope,"One slot",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1});await f.control.admit(f.ctx());
 await f.control.inspect(f.scope);f.restart();expect((await f.control.admit(f.ctx())).action).toBe("proceed");expect((await f.control.admit(f.ctx("fresh","another"))).action).toBe("wait");
});

it("review returns use the same finite task budget and cannot be replayed to inflate it",async()=>{
 const f=fixture();await f.control.decide(f.scope,"Two work attempts",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 const decision={decision:"changes-requested",reason:"Fix the missing check",atMs:1};
 await f.control.returned(f.scope,"task-1","dev",decision);await f.control.returned(f.scope,"task-1","dev",decision);f.restart();
 expect((await f.control.inspect(f.scope)).taskCounts.find(t=>t.taskId==="task-1")).toMatchObject({starts:1,returns:1});
 expect((await f.control.admit(f.ctx("fresh","rework"))).action).toBe("wait");
});

it("closing a package retains its spend while a distinct package has its own allowance",async()=>{
 const f=fixture();await f.control.decide(f.scope,"One task attempt",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1});await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 await f.control.finished(f.scope,"task-1");expect((await f.control.inspect(f.scope)).taskBlocks?.["task:task-1"]).toBeUndefined();f.tick();expect((await f.control.admit(f.ctx("fresh","same-package"))).action).toBe("wait");
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

it("separates approved lead coordination budget from execution without resetting counts",async()=>{
 const f=fixture();f.owners.set("lead",{...f.scope,role:"manager",taskId:"coordination",isLead:true});
 await f.control.decide(f.scope,"Separate finite lead allowance",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1,coordinationAttempts:3});
 for(let i=0;i<3;i++){expect((await f.control.admit(f.ctx("lead",`coord-${i}`))).action).toBe("proceed");await f.control.settle("lead","completed");f.tick();}
 expect((await f.control.admit(f.ctx("lead","over"))).action).toBe("wait");
 const s=await f.control.inspect(f.scope);expect(s.starts).toBe(3);expect(s.blocked).toBeNull();expect(s.taskBlocks?.["task:coordination"]).toContain("3/3");
});
it("deduplicates resource notices across changed count text",async()=>{
 const f=fixture();expect(await f.control.notice(f.scope,"dev:Task attempt limit reached (task:x: 8/8)")).toBe(true);
 expect(await f.control.notice(f.scope,"dev:Task attempt limit reached (task:x: 12/8)")).toBe(false);
});
it("distinguishes Ollama and OpenRouter upstream accounts inside Pi while blocking all Ollama models",async()=>{
 const f=fixture();const ctx=f.ctx();ctx.requestedExecution.model="ollama-cloud/one";
 await f.control.admit(ctx);
 const result=await f.control.failed(f.fail(),[{provider:"pi",model:"ollama-cloud/two"},{provider:"pi",model:"openrouter/approved-free"}]);
 expect(result?.selection?.model).toBe("openrouter/approved-free");
});
it("grants only four extra lead turns for one task, preserving policy, history and other holds",async()=>{
 const f=fixture();const owner={...f.scope,role:"lead",taskId:"coord",isLead:true};f.owners.set("lead",owner);
 await f.control.decide(f.scope,"Finite coordination",{...DEFAULT_RESOURCE_POLICY,coordinationAttempts:1});
 await f.control.admit(f.ctx("lead","one"));await f.control.settle("lead","completed");f.tick();let records=0;
 const next=await f.control.extendCoordination(owner,1,1,async()=>{records++;});
 expect(next.starts).toBe(1);expect(next.policy.coordinationAttempts).toBe(1);expect(next.taskLimits?.["task:coord"]).toBe(5);
 await expect(f.control.extendCoordination(owner,1,1,async()=>{records++;})).rejects.toThrow(/changed/);expect(records).toBe(1);
 f.restart();for(let i=0;i<4;i++){expect((await f.control.admit(f.ctx("lead",`more-${i}`))).action).toBe("proceed");await f.control.settle("lead","completed");f.tick();}
 expect((await f.control.admit(f.ctx("lead","sixth"))).action).toBe("wait");
});
it("cannot grant around shared token limits or a failed tracker write",async()=>{
 const f=fixture();const owner={...f.scope,role:"lead",taskId:"coord",isLead:true};f.owners.set("lead",owner);
 await f.control.decide(f.scope,"Finite coordination",{...DEFAULT_RESOURCE_POLICY,coordinationAttempts:1,tokens:1});
 await f.control.admit(f.ctx("lead","one"));f.event("lead","thread/tokenUsage/updated",{tokenUsage:{total:{totalTokens:1}}});await f.control.settle("lead","completed");
 await expect(f.control.extendCoordination(owner,1,1,async()=>{})).rejects.toThrow(/changed/);
 await f.control.decide(f.scope,"Keep overall room",{...DEFAULT_RESOURCE_POLICY,coordinationAttempts:1});
 await expect(f.control.extendCoordination(owner,1,1,async()=>{throw new Error("tracker offline");})).rejects.toThrow("tracker offline");
 expect((await f.control.inspect(f.scope)).taskLimits).toEqual({"task:coord":1});
});

it("fresh Ollama evidence clears only that upstream account, keeping OpenRouter and counters",async()=>{
 const f=fixture();
 const ollama={...f.ctx(),requestedExecution:{...f.ctx().requestedExecution,model:"ollama-cloud/a"}};
 await f.control.admit(ollama);await f.control.failed(f.fail(),[]);
 const router={...f.ctx("other","router"),requestedExecution:{...f.ctx().requestedExecution,model:"openrouter/free"}};
 await f.control.admit(router);await f.control.failed(f.fail({threadId:"other",requestId:"req-router"}),[]);
 expect(await f.control.quotaExcluded(f.scope,{provider:"pi",model:"ollama-cloud/b"})).toBe(true);
 expect(await f.control.quotaExcluded(f.scope,{provider:"pi",model:"openrouter/free"})).toBe(true);
 await f.control.confirmOllamaCapacity("different-host");expect(await f.control.quotaExcluded(f.scope,{provider:"pi",model:"ollama-cloud/b"})).toBe(true);
 await f.control.confirmOllamaCapacity("host");expect(await f.control.quotaExcluded(f.scope,{provider:"pi",model:"ollama-cloud/b"})).toBe(false);
 expect(await f.control.quotaExcluded(f.scope,{provider:"pi",model:"openrouter/free"})).toBe(true);
 expect((await f.control.inspect(f.scope)).starts).toBe(2);
});

it("quota reset requires a decision on the current session, not a replacement", async()=>{
 const f=fixture();await f.control.admit(f.ctx());
 const rate={providerId:"pi",status:"blocked",kind:"subscription-window",windows:[{providerKey:"w",status:"blocked",resetsAtMs:2000}]};
 await f.control.failed(f.fail({rateLimits:rate as never}),[]);
 f.tick();f.tick();
 const held=await f.control.admit(f.ctx("dev","human-resume","human"));
 expect(held.action).toBe("reject");expect((held as {message:string}).message).toContain("Allow next start");
 expect((held as {message:string}).message).not.toContain("retired");
 const before=await f.control.inspect(f.scope);
 expect(before.quotaBlocks).toHaveLength(1);
 await f.control.decide(f.scope,"User continues the same approved model after quota reset, within existing budget",undefined,"task-1");
 const released=await f.control.inspect(f.scope);expect(released.starts).toBe(before.starts);expect(released.policy).toEqual(before.policy);
 expect((await f.control.admit(f.ctx("dev","before-capacity","human"))).action).toBe("wait");
 f.event("dev","provider/rateLimits/updated",{rateLimits:{...rate,status:"allowed",windows:[{...rate.windows[0],status:"allowed"}]}});
 await f.control.inspect(f.scope);
 expect(await f.control.admit(f.ctx("dev","human-resume","human"))).toEqual({action:"proceed"});
});

it("changing a package limit retains spending, failure holds and rejects stale saves",async()=>{
 const f=fixture();await f.control.admit(f.ctx());await f.control.settle("dev","failed");
 const owner=f.owners.get("dev")!;let records=0;
 const summary=await f.control.setPackageLimit(owner,1,8,1,async()=>{records++;});
 expect(summary.starts).toBe(1);expect(summary.taskLimits?.["task:task-1"]).toBe(1);expect(summary.holds["task:task-1"]).toBeTruthy();
 await expect(f.control.setPackageLimit(owner,9,8,1,async()=>{records++;})).rejects.toThrow(/changed/);expect(records).toBe(1);
 await f.control.setPackageLimit(owner,9,1,1,async()=>{records++;});f.restart();
 expect((await f.control.admit(f.ctx("fresh","retry"))).action).toBe("wait");
 expect((await f.control.admit(f.ctx("other","independent"))).action).toBe("proceed");
});
it("migrates legacy team caps without erasing history, task ceilings or error holds",async()=>{
 const f=fixture();await f.control.admit(f.ctx());await f.control.settle("dev","failed");
 const db=f.bb.storage.database(),row=db.prepare("SELECT scope,data FROM team_resource_state").get() as {scope:string;data:string};
 const state=JSON.parse(row.data);delete state.startBudgetScope;delete state.taskCeilings;state.policy.teamStarts=1;state.blocked="Team start limit reached (1)";
 db.prepare("UPDATE team_resource_state SET data=? WHERE scope=?").run(JSON.stringify(state),row.scope);f.restart();
 const summary=await f.control.inspect(f.scope);expect(summary.blocked).toBeNull();expect(summary.policy.teamStarts).toBeNull();expect(summary.remainingStarts).toBeNull();
 expect(summary.starts).toBe(1);expect(summary.holds["task:task-1"]).toBeTruthy();expect(summary.taskLimits?.["task:task-1"]).toBe(8);
 expect((await f.control.admit(f.ctx("other","new-package"))).action).toBe("proceed");
 expect((await f.control.admit(f.ctx("fresh","same-package"))).action).toBe("wait");
});
it("initialization without a package is finite per owner session, not cumulative per project",async()=>{
 const f=fixture();await f.control.decide(f.scope,"One initialization",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1});
 for(const id of ["dev","helper","fresh"])f.owners.set(id,{...f.owners.get(id)!,taskId:null});
 await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 expect((await f.control.admit(f.ctx("helper","same-root"))).action).toBe("wait");
 expect((await f.control.admit(f.ctx("fresh","new-session"))).action).toBe("proceed");
});
it("new-package defaults do not silently alter existing package ceilings",async()=>{
 const f=fixture();await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 await f.control.decide(f.scope,"New packages get two starts",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});
 await f.control.admit(f.ctx("other","new"));const s=await f.control.inspect(f.scope);
 expect(s.taskLimits?.["task:task-1"]).toBe(8);expect(s.taskLimits?.["task:task-2"]).toBe(2);
});

it("pins an unstarted package allowance when assigned, before future default changes",async()=>{
 const f=fixture();await f.control.pinPackages(f.scope,[{id:"task-1",role:"dev",status:"todo"} as never],"lead");
 await f.control.decide(f.scope,"Two for future packages",{...DEFAULT_RESOURCE_POLICY,taskAttempts:2});
 const s=await f.control.inspect(f.scope);expect(s.taskLimits?.["task:task-1"]).toBe(8);expect(s.starts).toBe(0);
});

it("lets direct human messages reach a capped lead without granting automatic work",async()=>{
 const f=fixture();f.owners.set("lead",{...f.scope,role:"lead",taskId:"coord",ownerThreadId:"lead",isLead:true});
 await f.control.decide(f.scope,"One start",{...DEFAULT_RESOURCE_POLICY,coordinationAttempts:1});
 await f.control.admit(f.ctx("lead","one"));await f.control.settle("lead","completed");f.tick();
 const user={...f.ctx("lead","approve","user"),senderThreadId:null,originPluginId:null};
 expect((await f.control.admit(user)).action).toBe("proceed");expect(await f.control.userControlTurn("lead")).toBeTruthy();
 expect((await f.control.admit(user)).action).toBe("proceed");expect((await f.control.inspect(f.scope)).starts).toBe(2);
 await f.control.settle("lead","completed");expect(await f.control.userControlTurn("lead")).toBeNull();
 expect((await f.control.admit(f.ctx("lead","automatic","system"))).action).toBe("wait");
 const s=await f.control.inspect(f.scope);expect(s.taskLimits?.["task:coord"]).toBe(1);expect(s.taskBlocks?.["task:coord"]).toContain("2/1");
});
it("human discussion never waives worker caps, shared limits, failure holds or plugin-origin checks",async()=>{
 const f=fixture();await f.control.decide(f.scope,"One start",{...DEFAULT_RESOURCE_POLICY,taskAttempts:1,coordinationAttempts:1});
 await f.control.admit(f.ctx());await f.control.settle("dev","completed");
 expect((await f.control.admit({...f.ctx("fresh","human","user"),senderThreadId:null,originPluginId:null})).action).toBe("wait");
 f.owners.set("lead",{...f.scope,role:"lead",taskId:"coord",ownerThreadId:"lead",isLead:true});await f.control.admit(f.ctx("lead","one"));await f.control.settle("lead","completed");
 expect((await f.control.admit({...f.ctx("lead","spoof","user"),senderThreadId:null,originPluginId:"team"})).action).toBe("wait");
 await f.control.decide(f.scope,"Time cap",{...DEFAULT_RESOURCE_POLICY,minutes:1});for(let i=0;i<61;i++)f.tick();
 expect((await f.control.admit({...f.ctx("lead","time","user"),senderThreadId:null,originPluginId:null})).action).toBe("wait");
 const g=fixture();g.owners.set("lead",{...g.scope,role:"lead",taskId:"coord",ownerThreadId:"lead",isLead:true});await g.control.admit(g.ctx("lead","one"));await g.control.settle("lead","failed");
 expect((await g.control.admit({...g.ctx("lead","failure","user"),senderThreadId:null,originPluginId:null})).action).toBe("wait");
});
it("recognizes a real queued user message in a mixed group but not a core retry",async()=>{
 const f=fixture();f.owners.set("lead",{...f.scope,role:"lead",taskId:"coord",ownerThreadId:"lead",isLead:true});
 await f.control.decide(f.scope,"One start",{...DEFAULT_RESOURCE_POLICY,coordinationAttempts:1});await f.control.admit(f.ctx("lead","one"));await f.control.settle("lead","completed");
 const queued={...f.ctx("lead","user-queue","mixed"),senderThreadId:"mixed",originPluginId:"mixed",queuedMessages:[{id:"user-queue",initiator:"user",senderThreadId:null,originPluginId:null,payload:{kind:"input"}}]} as unknown as MessageDispatchHookContext;
 expect((await f.control.admit(queued)).action).toBe("proceed");await f.control.settle("lead","completed");
 queued.queuedMessages[0]!.payload={kind:"retry"} as never;expect((await f.control.admit({...queued,input:{text:"retry",blocks:[]}})).action).toBe("wait");
});

it("quiescence backstop rejects resource mutations while a turn is reserved",async()=>{
 const f=fixture();await f.control.admit(f.ctx());
 const owner=f.owners.get("dev")!;let records=0;
 await expect(f.control.setPackageLimit(owner,3,8,1,async()=>{records++;},true)).rejects.toThrow("outstanding");
 await expect(f.control.decide(f.scope,"Manual override",undefined,undefined,undefined,"tracker",true)).rejects.toThrow("outstanding");
 const lead={...f.scope,role:"lead",taskId:"coord",isLead:true};f.owners.set("lead",lead);
 await expect(f.control.extendCoordination(lead,1,1,async()=>{records++;},true)).rejects.toThrow("outstanding");
 expect(records).toBe(0);
 await f.control.settle("dev","completed");
 const summary=await f.control.setPackageLimit(owner,3,8,1,async()=>{records++;});
 expect(summary.taskLimits?.["task:task-1"]).toBe(3);expect(records).toBe(1);
});


describe("shared epic admission budget",()=>{
 let criteria="Two accepted children";
 const scopeDigest=(c:string)=>createHash("sha256").update(JSON.stringify({epicId:"epic-1",criteria:c})).digest("hex");
 const currentScopeRevision=()=>scopeDigest(criteria);
 const valid=async(owner:ResourceOwner,id:string)=>{
  if(!owner.taskId||(owner.taskId!==id&&!String(owner.taskId).startsWith("task-")))throw new Error("Task outside epic");
  return {title:"Release",criteria,scopeRevision:currentScopeRevision()};
 };
 const set=async(f:ReturnType<typeof fixture>,limit=3,epicId="epic-1",expectedScopeRevision=currentScopeRevision())=>{
  const before=await f.control.inspect(f.scope),prior=before.epicBudgets?.[epicId];
  return f.control.setEpicBudget(f.scope,{epicId,limit,expectedActiveEpicId:before.epic?.id??null,expectedRevision:prior?.revision??0,expectedUsed:prior?.used??0,expectedScopeRevision,reason:"User agreed a finite total"},async()=>({scopeRevision:currentScopeRevision()}),async()=>{});
 };
 beforeEach(()=>{criteria="Two accepted children";});
 it("shares a finite total across lead, children, helpers, new tasks and session reload",async()=>{
  const f=fixture(valid);f.owners.set("lead",{...f.scope,role:"lead",taskId:"epic-1",ownerThreadId:"lead",isLead:true});
  await set(f);
  for(const id of ["lead","dev","helper"]){expect((await f.control.admit(f.ctx(id,id))).action).toBe("proceed");f.event(id,"turn/started",{});f.event(id,"turn/completed",{status:"completed"});await f.control.settle(id,"completed");f.tick();}
  f.owners.set("fresh",{...f.scope,taskId:"task-new",ownerThreadId:"fresh"});f.restart();
  const leadUser={...f.ctx("lead","approved?","user"),senderThreadId:null,originPluginId:null};
  const changedModel=f.ctx("fresh","new-model");changedModel.requestedExecution.model="different/model";
  for(const ctx of [f.ctx("other","another-child"),changedModel,leadUser]){
   expect(await f.control.admit(ctx)).toMatchObject({action:"wait",reason:expect.stringContaining("Epic budget exhausted")});
  }
  const state=await f.control.inspect(f.scope);
  expect(state.epic).toMatchObject({id:"epic-1",used:3,remaining:0,title:"Release"});
  expect(state.attempts.map(a=>a.epicId)).toEqual(["epic-1","epic-1","epic-1"]);
  await set(f,4);expect((await f.control.admit(f.ctx("fresh","explicit-extension"))).action).toBe("proceed");
 });
 it("retains reservations across reentry and replay without double charging; cancellation keeps cost",async()=>{
  const f=fixture(valid);await set(f,1);
  expect((await f.control.admit(f.ctx())).action).toBe("proceed");
  expect((await f.control.admit(f.ctx())).action).toBe("proceed");
  await f.control.cancelled("dev","1");f.restart();
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(1);
  expect((await f.control.admit(f.ctx("helper","2"))).action).toBe("wait");
 });
 it("serializes concurrent admits and rejects a stale writer from another control instance",async()=>{
  const f=fixture(valid);await set(f,1);
  const other=new ResourceControl(f.bb,f.owner,()=>{},()=>1000,valid);
  const results=await Promise.all([f.control.admit(f.ctx()),other.admit(f.ctx("other","second"))]);
  expect(results.filter(r=>r.action==="proceed")).toHaveLength(1);
  expect(results.filter(r=>r.action==="wait")).toHaveLength(1);
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(1);
 });
 it("holds unknown scope or unavailable Beads before spending, independently of package/user exemptions",async()=>{
  let unavailable=false;
  const f=fixture(async(o,id)=>{if(unavailable)throw new Error("Beads unavailable");return valid(o,id);});
  await set(f);f.owners.set("other",{...f.scope,taskId:null});
  await expect(f.control.assertDispatch(f.owners.get("other")!)).rejects.toThrow("Epic scope held");
  expect(await f.control.admit(f.ctx("other"))).toMatchObject({action:"wait",reason:expect.stringContaining("Epic scope held")});
  unavailable=true;
  expect((await f.control.admit(f.ctx())).action).toBe("wait");
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(0);
 });
 it("requires checked human decisions and preserves spend after switching epics",async()=>{
  const f=fixture(valid);await set(f,1);await f.control.admit(f.ctx());
  await expect(set(f,2)).rejects.toThrow("outstanding");
  await f.control.settle("dev","completed");
  await set(f,2,"epic-2");await set(f,1,"epic-1");
  expect((await f.control.inspect(f.scope)).epic).toMatchObject({used:1,remaining:0,revision:2});
  const input={epicId:"epic-1",limit:3,expectedActiveEpicId:"epic-1",expectedRevision:1,expectedUsed:1,expectedScopeRevision:currentScopeRevision(),reason:"stale"};
  await expect(f.control.setEpicBudget(f.scope,input,async()=>({scopeRevision:currentScopeRevision()}),async()=>{})).rejects.toThrow("changed");
  const before=await f.control.inspect(f.scope);input.expectedRevision=before.epic!.revision;
  await expect(f.control.setEpicBudget(f.scope,input,async()=>({scopeRevision:currentScopeRevision()}),async()=>{throw new Error("tracker write failed");})).rejects.toThrow("tracker write failed");
  expect((await f.control.inspect(f.scope)).epic?.limit).toBe(1);
 });
 it("review returns retain epic spend and the next rework admission consumes another unit",async()=>{
  const f=fixture(valid);await set(f,2);await f.control.admit(f.ctx());await f.control.settle("dev","completed");
  await f.control.returned(f.scope,"task-1","dev",{reason:"Fix acceptance check",id:"review-1"});
  await f.control.returned(f.scope,"task-1","dev",{reason:"Fix acceptance check",id:"review-1"});
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(1);
  expect((await f.control.admit(f.ctx("helper","rework"))).action).toBe("proceed");
  await f.control.settle("helper","completed");
  expect((await f.control.admit(f.ctx("other","another-child"))).action).toBe("wait");
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(2);
 });
 it("budget increases leave quota and failure holds intact",async()=>{
  const f=fixture(valid);await set(f,1);await f.control.admit(f.ctx());await f.control.failed(f.fail(),[]);
  await set(f,3);
  expect((await f.control.inspect(f.scope)).quotaBlocks).not.toHaveLength(0);
  expect((await f.control.admit(f.ctx("helper","retry"))).action).toBe("wait");
 });
 it("does not attribute newly discovered pre-activation history to an epic",async()=>{
  const f=fixture(valid);
  f.event("other","turn/started",{});f.event("other","turn/completed",{status:"completed"});f.tick();
  await set(f,1);await f.control.watch("other");
  expect((await f.control.inspect(f.scope)).epic).toMatchObject({used:0,blocked:null});
  expect((await f.control.admit(f.ctx("dev","new-turn"))).action).toBe("proceed");
 });
 it("keeps old unbound packages independent and holds unreserved observed epic turns",async()=>{
  const f=fixture(valid);await f.control.admit(f.ctx());await f.control.settle("dev","completed");await set(f,2);
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(0);
  f.event("dev","turn/started",{});f.event("dev","turn/completed",{status:"completed"});
  await f.control.watch("dev");
  expect((await f.control.inspect(f.scope)).epic).toMatchObject({used:1,blocked:expect.stringContaining("unreserved")});
  expect((await f.control.admit(f.ctx("other","new-child"))).action).toBe("wait");
 });
 it("holds work after an external criterion change until a human re-approves, preserving spend",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  const approved=currentScopeRevision();
  criteria="Changed acceptance criteria";
  expect(await f.control.admit(f.ctx("helper","two"))).toMatchObject({action:"wait",reason:expect.stringContaining("scope changed")});
  const s=await f.control.inspect(f.scope);
  expect(s.epic).toMatchObject({used:1,approvedScopeRevision:approved,observedScopeRevision:currentScopeRevision()});
  expect(s.epic?.scopeMismatch).toContain("scope changed");
  await set(f,2);
  expect((await f.control.admit(f.ctx("helper","two"))).action).toBe("proceed");
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(2);
 });
 it("does not accept reentry of an outstanding reservation after the scope changed",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));
  criteria="Changed acceptance criteria";
  expect(await f.control.admit(f.ctx("dev","one"))).toMatchObject({action:"wait",reason:expect.stringContaining("scope changed")});
  expect((await f.control.inspect(f.scope)).epic?.used).toBe(1);
 });
 it("rejects a stale scope approval that races an external change",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  const stale=currentScopeRevision();
  criteria="Changed acceptance criteria";
  await expect(set(f,3,"epic-1",stale)).rejects.toThrow("scope changed before approval");
  expect((await f.control.inspect(f.scope)).epic?.approvedScopeRevision).toBe(stale);
  await set(f,3,"epic-1",currentScopeRevision());
  expect((await f.control.inspect(f.scope)).epic?.approvedScopeRevision).toBe(currentScopeRevision());
 });
 it("persists the pinned scope revision across restart and still blocks a changed scope",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  const approved=currentScopeRevision();
  criteria="Changed acceptance criteria";
  f.restart();
  expect(await f.control.admit(f.ctx("helper","two"))).toMatchObject({action:"wait",reason:expect.stringContaining("scope changed")});
  const s=await f.control.inspect(f.scope);
  expect(s.epic).toMatchObject({approvedScopeRevision:approved,observedScopeRevision:currentScopeRevision(),used:1});
 });
 it("fails closed on a legacy budget without an approved revision until a human re-approves",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));await f.control.settle("dev","completed");f.tick();
  const db=f.bb.storage.database();const row=db.prepare("SELECT scope,data FROM team_resource_state").get() as {scope:string;data:string};
  const state=JSON.parse(row.data);
  delete state.epicBudgets["epic-1"].approvedScopeRevision;
  delete state.epicBudgets["epic-1"].observedScopeRevision;
  db.prepare("UPDATE team_resource_state SET data=? WHERE scope=?").run(JSON.stringify(state),row.scope);
  f.restart();
  expect(await f.control.admit(f.ctx("helper","two"))).toMatchObject({action:"wait",reason:expect.stringContaining("not yet approved")});
  await set(f,3);
  expect((await f.control.admit(f.ctx("helper","two"))).action).toBe("proceed");
 });
 it("holds a joint quota failure and scope change until both are resolved",async()=>{
  const f=fixture(valid);await set(f,2);
  await f.control.admit(f.ctx("dev","one"));
  const rate={providerId:"pi",status:"blocked",kind:"subscription-window",windows:[{providerKey:"w",status:"blocked",resetsAtMs:2000}]};
  await f.control.failed(f.fail({rateLimits:rate as never}),[]);
  criteria="Changed acceptance criteria";
  // A different child task skips the per-task recovery hold but still faces both the
  // shared quota block and the changed epic scope lock.
  expect(await f.control.admit(f.ctx("other","two"))).toMatchObject({action:"wait",reason:expect.stringContaining("scope changed")});
  const s=await f.control.inspect(f.scope);
  expect(s.quotaBlocks).not.toHaveLength(0);
  expect(s.epic?.scopeMismatch).toContain("scope changed");
  await set(f,3); // re-approve scope only; shared quota still blocks
  expect(await f.control.admit(f.ctx("other","two"))).toMatchObject({action:"wait",reason:expect.stringContaining("Provider quota")});
  f.event("dev","provider/rateLimits/updated",{rateLimits:{...rate,status:"allowed",windows:[{...rate.windows[0],status:"allowed"}]}});
  await f.control.inspect(f.scope);
  expect((await f.control.admit(f.ctx("other","two"))).action).toBe("proceed");
 });
 it("omits criteria from the summary when the validator returns none",async()=>{
  const noCriteria=async(owner:ResourceOwner,id:string)=>{const v=await valid(owner,id);return {title:v.title,scopeRevision:v.scopeRevision};};
  const f=fixture(noCriteria);await set(f,2);
  const s=await f.control.inspect(f.scope);
  expect(s.epic?.title).toBe("Release");
  expect(s.epic?.criteria).toBeUndefined();
  expect("criteria" in (s.epic??{})).toBe(false);
 });
});

it("native Codex recovery refuses unrelated host exclusions without partial release",async()=>{
 const f=fixture();
 const codex=(id:string)=>({...f.ctx(id,id),requestedExecution:{...f.ctx().requestedExecution,providerId:"codex"}});
 for(const id of ["dev","other"])expect(await f.control.admit(codex(id))).toMatchObject({action:"proceed"});
 for(const id of ["dev","other"])await f.control.failed(f.fail({threadId:id,requestId:`failed-${id}`}),[]);
 const before=await f.control.inspect(f.scope);
 await expect(f.control.recoverCodexCapacity(f.scope,async()=>{throw new Error("capacity unknown");})).rejects.toThrow("capacity unknown");
 await expect(f.control.recoverCodexCapacity(f.scope,async()=>{})).rejects.toThrow("Another unresolved Codex");
 f.restart();const after=await f.control.inspect(f.scope);
 expect(after.starts).toBe(before.starts);expect(after.holds).toEqual(before.holds);expect(after.quotaBlocks).toEqual(before.quotaBlocks);
 expect(after.fallbacks).toEqual(before.fallbacks);
});

it("native recovery refuses outstanding admissions before checking capacity",async()=>{
 const f=fixture();await f.control.admit(f.ctx());let verified=false;
 await expect(f.control.recoverCodexCapacity(f.scope,async()=>{verified=true;})).rejects.toThrow("outstanding");expect(verified).toBe(false);
});


it("epic progress separates closed tasks from recorded acceptance and excludes foreign work",async()=>{
 const f=fixture();const base={role:"dev",note:null,createdAtMs:0,updatedAtMs:0};
 const decision={decision:"accept" as const,reason:"Checked the evidence",decidedBy:"manual" as const,basis:"manual" as const,atMs:1};
 const summary=withResourceResults({...await f.control.inspect(f.scope),epic:{id:"epic",used:3,limit:10,remaining:7,revision:1,sinceMs:0,blocked:null}},[
  {...base,id:"epic",title:"Goal",status:"done",review:{version:1,decisions:[decision]}},
  {...base,id:"a",title:"Accepted child",parentId:"epic",status:"done",review:{version:1,decisions:[decision]}},
  {...base,id:"b",title:"Legacy closed",parentId:"epic",status:"done"},
  {...base,id:"c",title:"Foreign accepted",parentId:"other",status:"done",review:{version:1,decisions:[decision]}},
 ]);
 expect(summary.epic).toMatchObject({trackerStatus:"done",acceptanceReason:"Checked the evidence",progress:{total:2,done:2,accepted:1,review:0,working:0,queued:0}});
});
