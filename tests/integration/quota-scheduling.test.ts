import {describe,it,expect,vi} from "vitest";
import {createFakePluginHost,makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import plugin from "../../src/server/server";
import {deferredKey,readDeferred} from "../../src/server/deferred-continuation";
import type {OllamaUsage} from "../../src/shared/ollama-usage";

async function setup(){
 let remaining=9,unavailable=false,queue:Array<{id:string;sendAt:number|null;state:string;updatedAt:number}>=[],status="error",now=1_800_000_000_000,hostCalls=0;
 const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
 const thread=()=>makeThreadResponse({id:"thr_lead",projectId:"proj_q",providerId:"pi",environmentId:"env_q",status:status as never});
 const retry=vi.fn(async({sendAt}:{sendAt?:number})=>{queue=[{id:"q_retry",sendAt:sendAt!,state:"scheduled",updatedAt:1}];return {ok:true,delivery:"queued",queuedMessageId:"q_retry",sendAt,turnRequestId:"failed_1",attempt:2};});
 const {bb,harness}=createFakePluginHost({pluginId:"team",experimental_hostEntry:true,settings:{defaultTracker:"builtin",teamSection:false,roster:false},experimental_callHostRpc:async()=>{hostCalls++;return {status:unavailable?"unavailable":"ready",checkedAtMs:now,windows:unavailable?[]:[{name:"weekly",remainingPercent:remaining,resetsAtMs:now+3600_000}],reason:unavailable?"host_unavailable":null} satisfies OllamaUsage;},sdk:{
  projects:{list:async()=>[{id:"proj_q",name:"q",kind:"standard",createdAt:0,updatedAt:0,gitRemoteUrl:null,sources:[{id:"source",projectId:"proj_q",hostId:"host_q",path:"/q",type:"local_path",isDefault:true,createdAt:0,updatedAt:0}]}]},
  files:{read:async({path})=>{if(path.endsWith("main.yaml"))return {content:"roles:\n - name: lead\n   provider: pi\n   model: ollama-cloud/model\n   prompt: Lead\n",sha256:"x"};throw new Error("ENOENT");}},
  environments:{get:async()=>({id:"env_q",hostId:"host_q",path:"/q"}) as never},
  threads:{get:async()=>thread(),getPluginMetadata:async()=>({teamName:"main",teamRole:"lead"}),experimental_listPluginMetadata:async()=>({threads:[{threadId:"thr_lead",metadata:{teamName:"main",teamRole:"lead"}}]}),list:async()=>[{...thread(),pluginMetadata:{teamName:"main",teamRole:"lead"}}] as never,events:{list:async()=>[]},retry:retry as never,queuedMessages:{list:async()=>queue as never,update:async(args)=>{Object.assign(queue[0]!,{sendAt:args.sendAt,updatedAt:queue[0]!.updatedAt+1});return queue[0] as never;},delete:async()=>{queue=[];return {ok:true};}}},
 }});
 try{await plugin(bb);}catch(e){clock.mockRestore();await harness.lifecycle.dispose();throw e;}
 const scope={projectId:"proj_q",team:"main"};
 return {bb,harness,retry,scope,advance:(ms:number)=>{now+=ms;},remaining:(v:number)=>{remaining=v;},unavailable:()=>{unavailable=true;},hostCalls:()=>hostCalls,
  rpc:(method:string,input:Record<string,unknown>={})=>harness.behavior.callRpc(method,{...scope,...input}),
  dispatch:(queueIds=true)=>harness.inspection.registrations.hooks["message.dispatch"]!({thread:thread(),attempt:"start-turn",initiator:"system",originPluginId:"team",queuedMessages:queueIds?queue:[],input:{text:"original work",blocks:[]},requestedExecution:{providerId:"pi",model:"ollama-cloud/model",reasoningLevel:"low",serviceTier:null,permissionMode:"full"}} as never),
  dispose:async()=>{clock.mockRestore();await harness.lifecycle.dispose();}};
}
describe("quota stop and native scheduled dispatch",()=>{
 it("latches the early stop without spending an attempt; positive balance alone cannot resume",async()=>{
  const f=await setup();try{
   expect((await f.dispatch()).action).toBe("wait");expect(await f.bb.storage.kv.get("quota-wait:proj_q:main:lead")).toBeTruthy();
   f.remaining(80);f.advance(181_000);expect((await f.dispatch()).action).toBe("wait");
   expect((await f.rpc("resources") as {starts:number}).starts).toBe(0);
   await f.rpc("roleControl",{role:"lead",action:"resume",expectedThreadId:"thr_lead"});expect((await f.dispatch()).action).toBe("proceed");
  }finally{await f.dispose();}
 });
 it("uses core retry sendAt; verifies fresh quota and releases exactly the original row at the deadline",async()=>{
  const f=await setup();try{
   await f.dispatch();const sendAt=Date.now()+120_000;
   await f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt});
   expect(f.retry).toHaveBeenCalledTimes(1);expect((await f.dispatch()).action).toBe("wait");
   const before=f.hostCalls();f.remaining(80);f.advance(121_000);expect((await f.dispatch()).action).toBe("proceed");expect(f.hostCalls()).toBeGreaterThan(before);
   expect(await readDeferred(f.bb,deferredKey("proj_q","main","lead"))).toMatchObject({stage:"released"});
  }finally{await f.dispose();}
 });
 it("holds once if quota is still low, with no retry loop; explicit check can release after recovery",async()=>{
  const f=await setup();try{
   await f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000});f.advance(121_000);
   expect((await f.dispatch()).action).toBe("wait");expect(await readDeferred(f.bb,deferredKey("proj_q","main","lead"))).toMatchObject({stage:"needs-decision"});
   f.remaining(90);expect((await f.dispatch()).action).toBe("wait");expect(f.retry).toHaveBeenCalledTimes(1);
   await f.rpc("deferredContinuation",{role:"lead",action:"check",expectedThreadId:"thr_lead"});expect((await f.dispatch()).action).toBe("proceed");
  }finally{await f.dispose();}
 });
 it("does not proceed on unknown quota, changed binding or explicit pause",async()=>{
  const f=await setup();try{
   await f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000});f.advance(121_000);f.unavailable();
   expect((await f.dispatch()).action).toBe("wait");expect((await f.rpc("resources") as {starts:number}).starts).toBe(0);
   await f.rpc("deferredContinuation",{role:"lead",action:"cancel",expectedThreadId:"thr_lead"});expect(await f.bb.storage.kv.get("role-paused:proj_q:main:lead")).toBe(true);
   await expect(f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000})).rejects.toThrow();
  }finally{await f.dispose();}
 });
 it("session/task changes cannot turn the deferred request into different work",async()=>{
  const f=await setup();try{
   await f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000});f.advance(121_000);f.remaining(80);
   await f.bb.storage.kv.set("session-task:proj_q:main:thr_lead","different-task");expect((await f.dispatch()).action).toBe("wait");
   expect(await readDeferred(f.bb,deferredKey("proj_q","main","lead"))).toMatchObject({stage:"needs-decision"});
   await expect(f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_old",sendAt:Date.now()+120_000})).rejects.toThrow();expect(f.retry).toHaveBeenCalledTimes(1);
  }finally{await f.dispose();}
 });
 it("a team budget exhausted while waiting cannot be replenished by time or a fresh provider balance",async()=>{
  const f=await setup();try{
   f.remaining(80);await f.dispatch();await f.harness.behavior.emitThreadEvent("thread.idle",{thread:makeThreadResponse({id:"thr_lead",projectId:"proj_q",providerId:"pi",status:"idle"}),lastAssistantText:null} as never);
   await f.rpc("deferredContinuation",{role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000});
   await f.rpc("resources",{reason:"Stop after the agreed single start",policy:{taskAttempts:8,teamStarts:1,tokens:null,minutes:null}});f.advance(121_000);
   expect((await f.dispatch()).action).toBe("wait");expect(await readDeferred(f.bb,deferredKey("proj_q","main","lead"))).toMatchObject({stage:"needs-decision"});
   expect((await f.rpc("resources") as {starts:number}).starts).toBe(1);
  }finally{await f.dispose();}
 });

 it("requires explicit consent to replace an employee pause; a later pause still holds the due turn",async()=>{
  const f=await setup();try{
   await f.bb.storage.kv.set("role-paused:proj_q:main:lead",true);
   const request={role:"lead",action:"schedule",expectedThreadId:"thr_lead",sendAt:Date.now()+120_000};
   await expect(f.rpc("deferredContinuation",request)).rejects.toThrow();expect(f.retry).not.toHaveBeenCalled();
   await f.rpc("deferredContinuation",{...request,resumePaused:true});expect(await f.bb.storage.kv.get("role-paused:proj_q:main:lead")).toBeUndefined();
   f.remaining(80);f.advance(121_000);await f.bb.storage.kv.set("role-paused:proj_q:main:lead",true);
   expect((await f.dispatch()).action).toBe("wait");expect((await f.rpc("resources") as {starts:number}).starts).toBe(0);
  }finally{await f.dispose();}
 });

});
