import {describe,it,expect,vi} from "vitest";
import {createFakePluginHost,makeThreadResponse} from "@get-bb/plugin-sdk/testing";
import plugin from "../../src/server/server";
import {emptyOpenRouter,type OpenRouterUsage} from "../../src/shared/openrouter-usage";
const scope={projectId:"proj_or",team:"main"};
async function setup(){
 let now=1800000000000,remaining=0,available=true,config=`roles:\n - name: lead\n   provider: pi\n   model: openrouter/free\n   prompt: Lead\n - name: junior\n   provider: acp-qwen-code\n   model: openrouter/free\n   prompt: Junior\n`;
 const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
 let queue:Array<{id:string;sendAt:number|null;updatedAt:number;state:string}>=[];
 const response=(id:string)=>makeThreadResponse({id,projectId:"proj_or",providerId:id==="thr_lead"?"pi":"acp-qwen-code",environmentId:"env_exec",status:"error"});
 const calls:Array<{hostId:string;input:unknown}>=[];
 const usage=():OpenRouterUsage=>({...emptyOpenRouter(available?null:"http_error"),status:available?"ready":"unavailable",checkedAtMs:now,keyId:"a".repeat(64),source:"environment",freeDaily:available?{used:50-remaining,limit:50,remaining,resetsAtMs:now+3600000}:null,keyLimitUsd:20,keyRemainingUsd:20});
 const f=createFakePluginHost({pluginId:"team",experimental_hostEntry:true,settings:{defaultTracker:"builtin",teamSection:false,roster:false},experimental_callHostRpc:async call=>{
  if(call.method!=="openrouterUsage")throw new Error("unexpected host operation");calls.push({hostId:call.hostId,input:call.input});return usage();
 },sdk:{projects:{list:async()=>[{id:"proj_or",name:"or",kind:"standard",createdAt:0,updatedAt:0,gitRemoteUrl:null,sources:[{id:"source",projectId:"proj_or",hostId:"host_checkout",path:"/canonical",type:"local_path",isDefault:true,createdAt:0,updatedAt:0}]}]},
 files:{read:async({path})=>{if(path.endsWith('main.yaml'))return {content:config,sha256:"x"};throw new Error('ENOENT');},write:async({content})=>{config=content;return {outcome:"written",sha256:"x",sizeBytes:content.length};}},
 plugins:{getSettings:async()=>({values:{customAgents:JSON.stringify([{id:"qwen-code",command:"qwen",args:["--acp"]}])}}) as never},
 environments:{get:async()=>({id:"env_exec",hostId:"host_execution",path:"/work/dirty-task"}) as never},
 threads:{get:async({threadId})=>response(threadId),list:async()=>[response('thr_lead'),response('thr_junior')],getPluginMetadata:async({threadId})=>({teamName:"main",teamRole:threadId==='thr_lead'?'lead':'junior'}),experimental_listPluginMetadata:async()=>({threads:[{threadId:'thr_lead',metadata:{teamName:'main',teamRole:'lead'}},{threadId:'thr_junior',metadata:{teamName:'main',teamRole:'junior'}}]}),events:{list:async()=>[]},
 retry:async({sendAt})=>{queue=[{id:'q_original',sendAt:sendAt!,updatedAt:1,state:'scheduled'}];return {ok:true,delivery:'queued',queuedMessageId:'q_original',sendAt:sendAt!,turnRequestId:'failed',attempt:2,waitingOn:{kind:'time'}};},queuedMessages:{list:async()=>queue as never},
 }}});
 try{await plugin(f.bb);}catch(e){clock.mockRestore();await f.harness.lifecycle.dispose();throw e;}
 return {...f,calls,config:()=>config,remaining:(n:number)=>{remaining=n;},unavailable:()=>{available=false;},advance:()=>{now+=121000;},
 rpc:(method:string,input:Record<string,unknown>={})=>f.harness.behavior.callRpc(method,{...scope,...input}),
 dispatch:(id='thr_lead')=>f.harness.inspection.registrations.hooks['message.dispatch']!({thread:response(id),attempt:'start-turn',initiator:'system',originPluginId:'team',queuedMessages:queue,input:{text:'original request',blocks:[]},requestedExecution:{providerId:response(id).providerId,model:'openrouter/free',permissionMode:'full',reasoningLevel:null,serviceTier:null}} as never),
 dispose:async()=>{clock.mockRestore();await f.harness.lifecycle.dispose();}};
}
describe('OpenRouter quota belongs to the execution connection, not the agent',()=>{
 it('checks Pi and Qwen on their real execution host/path and holds both at shared zero',async()=>{
  const f=await setup();try{
   expect((await f.dispatch()).action).toBe('wait');expect((await f.dispatch('thr_junior')).action).toBe('wait');
   expect(f.calls).toEqual(expect.arrayContaining([expect.objectContaining({hostId:'host_execution',input:expect.objectContaining({provider:'pi',cwd:'/work/dirty-task'})}),expect.objectContaining({hostId:'host_execution',input:expect.objectContaining({provider:'acp-qwen-code',cwd:'/work/dirty-task'})})]));
   expect((await f.rpc('resources') as {starts:number}).starts).toBe(0);
   const a=await f.rpc('openrouterUsage',{role:'lead'}) as OpenRouterUsage,b=await f.rpc('openrouterUsage',{role:'junior'}) as OpenRouterUsage;expect(a.keyId).toBe(b.keyId);
  }finally{await f.dispose();}
 });
 it('native delayed retry rechecks quota freshly and releases only after positive free capacity',async()=>{
  const f=await setup();try{
   await f.dispatch();await f.rpc('deferredContinuation',{role:'lead',action:'schedule',expectedThreadId:'thr_lead',sendAt:Date.now()+120000});
   f.advance();f.remaining(40);expect((await f.dispatch()).action).toBe('proceed');expect(f.calls.length).toBe(2);
   expect((await f.rpc('resources') as {starts:number}).starts).toBe(1);
  }finally{await f.dispose();}
 });
 it('unknown after a failed refresh never releases the last known zero or loops retries',async()=>{
  const f=await setup();try{
   await f.dispatch();await f.rpc('deferredContinuation',{role:'lead',action:'schedule',expectedThreadId:'thr_lead',sendAt:Date.now()+120000});f.advance();f.unavailable();
   expect((await f.dispatch()).action).toBe('wait');const before=f.calls.length;expect((await f.dispatch()).action).toBe('wait');expect(f.calls.length).toBe(before);
   expect((await f.rpc('resources') as {starts:number}).starts).toBe(0);
  }finally{await f.dispose();}
 });
 it('source selection persists in the actual role config with revision checking, no raw credentials',async()=>{
  const f=await setup();try{
   const profile=await f.rpc('rolePolicy',{role:'junior'}) as {revision:string};
   const quotaSource={service:'openrouter',credentialEnv:'QWEN_EXECUTION_KEY'};
   await f.rpc('rolePolicy',{role:'junior',quotaSource,expectedRevision:profile.revision});expect(f.config()).toContain('QWEN_EXECUTION_KEY');
   await f.rpc('openrouterUsage',{role:'junior',refresh:true});expect(f.calls.at(-1)?.input).toMatchObject({binding:quotaSource});
   await expect(f.rpc('rolePolicy',{role:'junior',quotaSource:{...quotaSource,credentialEnv:'sk-or-secret'},expectedRevision:profile.revision})).rejects.toThrow();
  }finally{await f.dispose();}
 });
 it('refresh alone does not authorize a latched role; explicit resume after recovery does',async()=>{
  const f=await setup();try{
   await f.dispatch();f.remaining(40);await f.rpc('openrouterUsage',{role:'lead',refresh:true});expect((await f.dispatch()).action).toBe('wait');
   await f.rpc('roleControl',{role:'lead',action:'resume',expectedThreadId:'thr_lead'});expect((await f.dispatch()).action).toBe('proceed');
  }finally{await f.dispose();}
 });
 it('never treats another OpenRouter launcher as an independent automatic fallback',async()=>{
  const f=await setup();try{
   const p=await f.rpc('rolePolicy',{role:'lead'}) as {revision:string};
   await f.rpc('rolePolicy',{role:'lead',expectedRevision:p.revision,policy:{noAdditionalCost:true,fallbacks:[{provider:'acp-qwen-code',model:'openrouter/free'}]}});
   await f.harness.behavior.emitThreadEvent('turn.failed',{threadId:'thr_lead',requestId:'quota_1',turnId:null,inputAccepted:false,errorInfo:{category:'budget-exceeded',httpStatusCode:429,providerCode:'quota'},rateLimits:null,attemptNumber:1,originPluginId:'team'} as never);
   expect(f.harness.inspection.sdk.callsTo('threads.spawn')).toHaveLength(0);
   expect((await f.rpc('resources') as {fallbacks:Array<{selection:unknown}>}).fallbacks[0]?.selection).toBeNull();
  }finally{await f.dispose();}
 });

 it('a fresh shared-key zero immediately holds another launcher with an older positive cached receipt',async()=>{
  const f=await setup();try{
   f.remaining(40);await f.rpc('openrouterUsage',{role:'junior'});
   f.remaining(0);await f.rpc('openrouterUsage',{role:'lead',refresh:true});
   const before=f.calls.length;expect((await f.dispatch('thr_junior')).action).toBe('wait');expect(f.calls.length).toBe(before);
   expect((await f.rpc('resources') as {starts:number}).starts).toBe(0);
  }finally{await f.dispose();}
 });

});
