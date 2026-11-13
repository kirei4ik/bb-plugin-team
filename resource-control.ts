import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { TaskId, TeamTask } from "./snapshot";
import type { ExecutionFallbackSelection } from "./execution-policy";

export const resourcePolicySchema = z.object({
  taskAttempts: z.number().int().min(1).max(1000),
  teamStarts: z.number().int().min(1).max(10000),
  tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  minutes: z.number().int().positive().max(525600).nullable(),
}).strict();
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;
export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {taskAttempts:8,teamStarts:100,tokens:null,minutes:null};
export interface ResourceOwner {projectId:string;team:string;role:string;taskId:TaskId|null;ownerThreadId:string;hostId:string|null}
export interface ResourceAttempt {
  id:string;key:string;threadId:string;taskId:TaskId|null;role:string;provider:string;model:string|null;
  initiator:string;requestId:string|null;atMs:number;endedAtMs:number|null;
  outcome:"reserved"|"running"|"completed"|"failed"|"interrupted"|"cancelled"|"unknown";
  reason:string|null; tokens:number|null; queuedIds:string[];
}
interface TrackedThread {owner:ResourceOwner;cursor:number;lastUsage:number|null;reported:number;usageKnown:boolean;usagePartial:boolean;activeId:string|null;requestId:string|null;eventsAvailable:boolean}
interface Quota {provider:string;hostId:string|null;pool:string|null;until:number|null;requestId:string}
export interface ResourceFallback {requestId:string;threadId:string;role:string;taskId:TaskId|null;stage:"blocked"|"selected"|"switching"|"complete"|"error";selection:ExecutionFallbackSelection|null;newThreadId:string|null;reason:string;atMs:number;manualReleased?:boolean}
interface ResourceState {
  version:1;sinceMs:number;policy:ResourcePolicy;attempts:ResourceAttempt[];threads:Record<string,TrackedThread>;
  holds:Record<string,string>;finished:string[];quotas:Quota[];pools:Record<string,string[]>;fallbacks:Record<string,ResourceFallback>;
  seenFailures:string[];notices:string[];returns:Array<{taskId:TaskId;role:string;ref:string;atMs:number}>;
  decisions:Array<{atMs:number;reason:string;taskId:TaskId|null;policy:ResourcePolicy}>;
  blocked:string|null;blockedAtMs:number|null;
}
export interface ResourceSummary {
  sinceMs:number;policy:ResourcePolicy;starts:number;remainingStarts:number;reportedTokens:number|null;
  usageCoverage:"unavailable"|"partial";blocked:string|null;holds:Record<string,string>;
  attempts:ResourceAttempt[];fallbacks:ResourceFallback[];quotaBlocks:Array<{provider:string;hostId:string|null;resetAtMs:number|null}>;
  taskCounts:Array<{taskId:TaskId|null;role:string;starts:number;returns:number}>;
  results?: {accepted:number;review:number;reports:number;recent:Array<{id:TaskId;title:string;result:string|null;checks:Array<{what:string;result:string|null;notApplicable:string|null}>;acceptanceReason:string|null}>};
}
const finite = (n:unknown):n is number => typeof n==="number" && Number.isFinite(n) && n>=0;
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const taskKey=(task:TaskId|null,role:string)=>task===null?`role:${role}`:`task:${task}`;
const terminal=(attempt:ResourceAttempt)=>attempt.outcome!=="reserved"&&attempt.outcome!=="running";
const safeText=(text:string)=>text.split("\n")[0]!.slice(0,700);
const TYPES=["client/turn/requested","turn/started","turn/completed","thread/tokenUsage/updated","provider/modelFallback","provider/rateLimits/updated"] as const;

export function confirmedQuota(f:PluginTurnFailedEvent):boolean {
 return f.errorInfo?.category==="budget-exceeded"||(f.errorInfo?.category==="rate-limit"&&f.rateLimits?.status==="blocked"&&f.rateLimits.kind!=="unknown");
}

/** Technical accounting only. No task content, model calls, polling or retry scheduler. */
export class ResourceControl {
  private db:ReturnType<BbPluginApi["storage"]["database"]>;
  private tail:Promise<unknown>=Promise.resolve();
  private enabledAt:number;
  constructor(private bb:BbPluginApi,private resolve:(threadId:string)=>Promise<ResourceOwner|null>,private changed:(projectId:string)=>void,private now=Date.now) {
    this.enabledAt=this.now();
    this.db=bb.storage.database();
    bb.storage.migrate(this.db,["CREATE TABLE IF NOT EXISTS team_resource_state (scope TEXT PRIMARY KEY, data TEXT NOT NULL)","CREATE TABLE IF NOT EXISTS team_resource_quota (id TEXT PRIMARY KEY, data TEXT NOT NULL)","CREATE TABLE IF NOT EXISTS team_resource_provider_pools (provider TEXT PRIMARY KEY, pools TEXT NOT NULL)"]);
  }
  private scope(owner:Pick<ResourceOwner,"projectId"|"team">){return JSON.stringify([owner.projectId,owner.team]);}
  private load(owner:Pick<ResourceOwner,"projectId"|"team">):ResourceState {
    const row=this.db.prepare("SELECT data FROM team_resource_state WHERE scope=?").get(this.scope(owner)) as {data:string}|undefined;
    return row?JSON.parse(row.data):{version:1,sinceMs:this.enabledAt,policy:{...DEFAULT_RESOURCE_POLICY},attempts:[],threads:{},holds:{},finished:[],quotas:[],pools:{},fallbacks:{},seenFailures:[],notices:[],returns:[],decisions:[],blocked:null,blockedAtMs:null};
  }
  private save(owner:Pick<ResourceOwner,"projectId"|"team">,state:ResourceState){
    this.db.prepare("INSERT INTO team_resource_state(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data").run(this.scope(owner),JSON.stringify(state));
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const work=this.tail.catch(()=>{}).then(fn);this.tail=work;return work;}
  private track(state:ResourceState,id:string,owner:ResourceOwner):TrackedThread {
    const previous=state.threads[id];
    if(previous){previous.owner=owner;return previous;}
    return state.threads[id]={owner,cursor:0,lastUsage:null,reported:0,usageKnown:false,usagePartial:false,activeId:null,requestId:null,eventsAvailable:true};
  }
  private attempt(state:ResourceState,thread:TrackedThread){return state.attempts.find(a=>a.id===thread.activeId);}
  private append(state:ResourceState,owner:ResourceOwner,id:string,key:string,provider:string,model:string|null,initiator:string):ResourceAttempt {
    const attempt:ResourceAttempt={id:randomUUID(),key,threadId:id,taskId:owner.taskId,role:owner.role,provider,model,initiator,requestId:null,atMs:this.now(),endedAtMs:null,outcome:"reserved",reason:null,tokens:null,queuedIds:[]};
    state.attempts.push(attempt);state.threads[id]!.activeId=attempt.id;return attempt;
  }
  private finish(state:ResourceState,thread:TrackedThread,outcome:ResourceAttempt["outcome"],reason:string|null,atMs:number){
    const active=this.attempt(state,thread);if(!active||terminal(active))return;
    active.outcome=outcome;active.endedAtMs=atMs;active.reason=reason;
    if(outcome==="failed"||outcome==="interrupted")state.holds[taskKey(active.taskId,active.role)]=reason??outcome;
  }
  private pools(state:ResourceState,owner:ResourceOwner,rate:unknown):string[]{
    if(!rate||typeof rate!=="object")return [];
    const raw=rate as {providerId?:unknown;status?:unknown;windows?:Array<{providerKey?:unknown;status?:unknown}>};
    if(typeof raw.providerId!=="string"||!Array.isArray(raw.windows))return [];
    const keys=raw.windows.flatMap(w=>typeof w.providerKey==="string"?[digest(w.providerKey)]:[]);
    this.db.prepare("INSERT INTO team_resource_provider_pools(provider,pools) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET pools=excluded.pools").run(JSON.stringify([owner.hostId,raw.providerId]),JSON.stringify(keys));
    if(raw.status==="allowed"&&raw.windows.every(w=>w.status!=="blocked")){
      const rows=this.db.prepare("SELECT id,data FROM team_resource_quota").all() as Array<{id:string;data:string}>;
      for(const row of rows){const q=JSON.parse(row.data) as Quota;if(q.hostId===owner.hostId&&q.provider===raw.providerId&&(q.pool===null||keys.includes(q.pool))){q.until=this.now();this.db.prepare("UPDATE team_resource_quota SET data=? WHERE id=?").run(JSON.stringify(q),row.id);}}
    }
    return keys;
  }
  private quotas():Quota[]{return (this.db.prepare("SELECT data FROM team_resource_quota").all() as Array<{data:string}>).map(r=>JSON.parse(r.data) as Quota);}
  private isBlocked(state:ResourceState,provider:string,hostId:string|null):boolean{
    const entry=this.db.prepare("SELECT pools FROM team_resource_provider_pools WHERE provider=?").get(JSON.stringify([hostId,provider])) as {pools:string}|undefined;
    const known:string[]=entry?JSON.parse(entry.pools):[];
    return this.quotas().some(q=>(q.provider===provider&&q.hostId===hostId||q.pool!==null&&known.includes(q.pool))&&(q.until===null||q.until>this.now()));
  }
  private async syncThread(state:ResourceState,id:string){
    const thread=state.threads[id];if(!thread)return;
    try {
      for(let page=0;page<20;page++){
        const rows=await this.bb.sdk.threads.events.list({threadId:id,afterSeq:String(thread.cursor),order:"asc",limit:"100",types:TYPES});
        thread.eventsAvailable=true;
        for(const row of rows){
          if(row.seq<=thread.cursor)continue;
          // Store accounting and cursor in one durable state write, so replay is harmless.
          if(row.createdAt>=state.sinceMs){
            const data=row.data as unknown as Record<string,unknown>;
            if(row.type==="client/turn/requested"){
              thread.requestId=String(data.requestId);
              const active=this.attempt(state,thread);
              if(active&&!terminal(active)&&active.requestId===null)active.requestId=thread.requestId;
            } else if(row.type==="turn/started"){
              let active=this.attempt(state,thread);
              if(!active||terminal(active)){
                // Explicit Send-now bypasses hooks in BB. Observe it, never claim it was vetoed.
                const dto=await this.bb.sdk.threads.get({threadId:id});
                active=this.append(state,thread.owner,id,`observed:${row.id}`,dto.providerId,null,"override/observed");
                active.requestId=thread.requestId;active.atMs=row.createdAt;
              }
              active.outcome="running";
            } else if(row.type==="turn/completed"){
              const status=data.status;
              if(status==="completed"||status==="failed"||status==="interrupted")this.finish(state,thread,status,status==="completed"?null:"Turn failed/interrupted; a concrete next approach is required",row.createdAt);
            } else if(row.type==="thread/tokenUsage/updated"){
              const usage=data.tokenUsage as {total?:{totalTokens?:unknown}}|undefined;
              const total=usage?.total?.totalTokens;
              if(finite(total)){
                const delta=thread.lastUsage===null?total:total>=thread.lastUsage?total-thread.lastUsage:total;
                if(thread.lastUsage!==null&&total<thread.lastUsage)thread.usagePartial=true;
                thread.lastUsage=total;thread.reported+=delta;thread.usageKnown=true;
                const active=this.attempt(state,thread);if(active)active.tokens=(active.tokens??0)+delta;
              }else thread.usagePartial=true;
            } else if(row.type==="provider/rateLimits/updated"){
              this.pools(state,thread.owner,data.rateLimits);
            } else if(row.type==="provider/modelFallback"){
              const active=this.attempt(state,thread);
              if(active){if(typeof data.fallbackModel==="string")active.model=data.fallbackModel;active.reason="Provider reported an internal model fallback; inspect actual model before continuing";state.holds[taskKey(active.taskId,active.role)]=active.reason;}
            }
          } else if(row.type==="thread/tokenUsage/updated"){
            // Do not charge pre-policy history, but retain its cumulative baseline.
            const total=(row.data as {tokenUsage?:{total?:{totalTokens?:unknown}}}).tokenUsage?.total?.totalTokens;
            if(finite(total))thread.lastUsage=total;
          }
          thread.cursor=row.seq;
        }
        if(rows.length<100)return;
      }
      thread.eventsAvailable=false; // Bounded catch-up; more events will advance the cursor.
    }catch{thread.eventsAvailable=false;}
  }
  private async syncAll(state:ResourceState){for(const id of Object.keys(state.threads))await this.syncThread(state,id);}
  private limit(state:ResourceState,excluding?:string):string|null {
    const attempts=state.attempts.filter(a=>a.id!==excluding);
    if(state.attempts.length>=10000)return "Accounting history reached its safety limit; manual resource decision required";
    if(attempts.length>=state.policy.teamStarts)return `Team start limit reached (${state.policy.teamStarts})`;
    if(state.attempts.length&&state.policy.minutes!==null&&this.now()-state.attempts[0]!.atMs>=state.policy.minutes*60000)return `Team time limit reached (${state.policy.minutes} minutes)`;
    const usage=Object.values(state.threads).reduce((n,t)=>n+t.reported,0);
    if(state.policy.tokens!==null&&usage>=state.policy.tokens)return `Reported cumulative token limit reached (${state.policy.tokens}); unsupported usage remains unknown`;
    const counts=new Map<string,number>();
    for(const a of attempts){if(a.taskId===null)continue;const key=taskKey(a.taskId,a.role);counts.set(key,(counts.get(key)??0)+1);}
    for(const returned of state.returns??[]){const key=taskKey(returned.taskId,returned.role);counts.set(key,(counts.get(key)??0)+1);}
    for(const [key,count]of counts)if(count>=state.policy.taskAttempts&&!state.finished.includes(key))return `Task attempt limit reached (${key}: ${count}/${state.policy.taskAttempts}); a new card or session cannot reset it`;
    return null;
  }
  private block(state:ResourceState,reason:string){if(state.blocked!==reason){state.blocked=reason;state.blockedAtMs=this.now();}}
  private summary(state:ResourceState):ResourceSummary {
    const threads=Object.values(state.threads);
    const grouped=new Map<string,{taskId:TaskId|null;role:string;starts:number;returns:number}>();
    for(const a of state.attempts){const key=taskKey(a.taskId,a.role),row=grouped.get(key)??{taskId:a.taskId,role:a.role,starts:0,returns:0};row.starts++;grouped.set(key,row);}
    for(const returned of state.returns??[]){const key=taskKey(returned.taskId,returned.role),row=grouped.get(key)??{taskId:returned.taskId,role:returned.role,starts:0,returns:0};row.returns++;grouped.set(key,row);}
    return {quotaBlocks:this.quotas().filter(q=>q.until===null||q.until>this.now()).map(q=>({provider:q.provider,hostId:q.hostId,resetAtMs:q.until})),taskCounts:[...grouped.values()],sinceMs:state.sinceMs,policy:state.policy,starts:state.attempts.length,remainingStarts:Math.max(0,state.policy.teamStarts-state.attempts.length),reportedTokens:threads.some(t=>t.usageKnown)?threads.reduce((n,t)=>n+t.reported,0):null,usageCoverage:threads.some(t=>t.usageKnown)?"partial":"unavailable",blocked:state.blocked,holds:state.holds,attempts:state.attempts.slice(-100),fallbacks:Object.values(state.fallbacks).slice(-50)};
  }
  async admit(ctx:MessageDispatchHookContext):Promise<MessageDispatchHookDecision>{
    if(ctx.attempt!=="start-turn")return {action:"proceed"};
    const owner=await this.resolve(ctx.thread.id);if(!owner)return {action:"proceed"};
    return this.serial(async()=>{
      const state=this.load(owner);const thread=this.track(state,ctx.thread.id,owner);await this.syncAll(state);
      const active=this.attempt(state,thread);
      const queued=ctx.queuedMessages.map(m=>m.id);
      if(ctx.thread.status==="error"&&active&&!terminal(active)){
        this.finish(state,thread,"failed","Failed session needs a concrete decision before retry",this.now());this.save(owner,state);
        return {action:"wait",reason:"Team is waiting for failure details and a concrete next approach"};
      }
      const key=digest([ctx.thread.id,queued.length?queued:null,ctx.thread.updatedAt,thread.requestId,ctx.input.text,ctx.initiator,ctx.requestedExecution]);
      // Re-evaluation of the same admission is not another attempt. An outstanding
      // reservation is retained across another plugin's wait/restart.
      const reentry=active?.outcome==="reserved"&&(active.key===key||queued.some(id=>active.queuedIds.includes(id)));
      const holdingFallback=Object.values(state.fallbacks).find(f=>f.threadId===ctx.thread.id&&!f.manualReleased);
      if(holdingFallback)return {action:"reject",message:`Team: old quota session is retired or held: ${holdingFallback.reason}`};
      const pending=Object.values(state.fallbacks).find(f=>f.taskId!==null&&f.taskId===owner.taskId&&f.stage!=="complete"&&!f.manualReleased&&f.newThreadId!==ctx.thread.id);
      if(pending)return {action:"wait",reason:`Team is preserving task ${owner.taskId} during quota recovery: ${pending.reason}`};
      const limit=this.limit(state,reentry?active!.id:undefined);
      const quota=this.isBlocked(state,ctx.requestedExecution.providerId,owner.hostId);
      const reason=limit??state.blocked??state.holds[taskKey(owner.taskId,owner.role)]??(quota?"Provider quota is blocked for this host/account scope; wait for reset or choose an approved independent provider":null);
      if(reason){const changed=limit&&state.blocked!==limit;if(limit)this.block(state,limit);this.save(owner,state);if(changed)this.changed(owner.projectId);return {action:"wait",reason:`Team resources: ${reason}. Review the resource panel; active work is not interrupted.`};}
      if(reentry){this.save(owner,state);return {action:"proceed"};}
      if(active&&!terminal(active)){
        if(ctx.thread.status==="idle"||ctx.thread.status==="error"){this.finish(state,thread,"unknown","Previous admission has no complete event; reserved cost is retained",this.now());state.holds[taskKey(owner.taskId,owner.role)]="Previous attempt outcome is unknown; inspect it before a concrete manual decision";this.save(owner,state);return {action:"wait",reason:state.holds[taskKey(owner.taskId,owner.role)]!};}
        else return {action:"wait",reason:"Team is waiting for the previous attempt's outcome"};
      }
      const previous=state.attempts.find(a=>a.key===key);
      if(previous)return {action:"wait",reason:"This admission already completed; inspect its result before explicitly requesting another attempt"};
      const attempt=this.append(state,owner,ctx.thread.id,key,ctx.requestedExecution.providerId,ctx.requestedExecution.model,ctx.initiator);
      attempt.queuedIds=queued;this.save(owner,state);this.changed(owner.projectId);return {action:"proceed"};
    });
  }
  async watch(threadId:string){const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner);this.track(s,threadId,owner);await this.syncThread(s,threadId);this.save(owner,s);});}
  async queued(threadId:string,id:string,isRetry=false){if(isRetry)return;const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner),t=s.threads[threadId];const a=t&&this.attempt(s,t);if(a?.outcome==="reserved"&&!a.queuedIds.includes(id)){a.queuedIds.push(id);this.save(owner,s);}});}
  async settle(threadId:string,outcome:"completed"|"failed"|"interrupted"){
    const owner=await this.resolve(threadId);if(!owner)return;
    await this.serial(async()=>{const s=this.load(owner);this.track(s,threadId,owner);await this.syncThread(s,threadId);const t=s.threads[threadId]!;this.finish(s,t,outcome,outcome==="completed"?null:"Failure requires a concrete next approach",this.now());this.save(owner,s);});
  }
  async inspect(owner:Pick<ResourceOwner,"projectId"|"team">){return this.serial(async()=>{const s=this.load(owner);await this.syncAll(s);this.save(owner,s);const summary=this.summary(s);summary.blocked??=this.limit(s);return summary;});}
  async decide(owner:Pick<ResourceOwner,"projectId"|"team">,reason:string,policy?:ResourcePolicy,taskId?:TaskId,role?:string){
    if(!reason.trim())throw new Error("A concrete manual resource decision is required");
    return this.serial(async()=>{const s=this.load(owner);if(policy)s.policy=resourcePolicySchema.parse(policy);
      if(taskId!==undefined||role){delete s.holds[taskKey(taskId??null,role??"")];for(const f of Object.values(s.fallbacks))if(f.taskId===taskId&&(f.stage==="blocked"||f.stage==="error")){f.stage="error";f.manualReleased=true;}}
      const limit=this.limit(s);s.blocked=limit;s.blockedAtMs=limit?this.now():null;
      s.decisions.push({atMs:this.now(),reason:taskId!==undefined?"Concrete task approach decision is recorded in the selected tracker":safeText(reason),taskId:taskId??null,policy:{...s.policy}});this.save(owner,s);return this.summary(s);
    });
  }
  async returned(owner:Pick<ResourceOwner,"projectId"|"team">,taskId:TaskId,role:string,decision:unknown){await this.serial(async()=>{const s=this.load(owner);s.returns??=[];const ref=digest(decision);if(!s.returns.some(r=>r.ref===ref))s.returns.push({taskId,role,ref,atMs:this.now()});this.save(owner,s);});}
  async finished(owner:Pick<ResourceOwner,"projectId"|"team">,taskId:TaskId,manualClosure=false){await this.serial(async()=>{
    const s=this.load(owner),key=taskKey(taskId,"");
    // An automated drop/close must not turn an exhausted work item into a
    // fresh budget. Manual grounded acceptance is an explicit resource decision.
    const before=this.limit(s);if(before&&!manualClosure)this.block(s,before);
    if(!s.finished.includes(key))s.finished.push(key);delete s.holds[key];
    if(manualClosure||!s.blocked)s.blocked=this.limit(s);this.save(owner,s);
  });}
  private quota(f:PluginTurnFailedEvent):boolean {return confirmedQuota(f);}
  async failed(f:PluginTurnFailedEvent,candidates:ExecutionFallbackSelection[]):Promise<ResourceFallback|null>{
    const owner=await this.resolve(f.threadId);if(!owner)return null;
    return this.serial(async()=>{
      const s=this.load(owner);this.track(s,f.threadId,owner);await this.syncThread(s,f.threadId);
      s.seenFailures??=[];if(s.seenFailures.includes(f.requestId))return null;s.seenFailures.push(f.requestId); // Event replay must not cause another switch.
      const thread=s.threads[f.threadId]!;
      let a=s.attempts.find(a=>a.requestId===f.requestId)??this.attempt(s,thread);
      if(!a){const dto=await this.bb.sdk.threads.get({threadId:f.threadId});a=this.append(s,owner,f.threadId,`failed:${f.requestId}`,dto.providerId,null,"observed failure");}
      a.requestId=f.requestId;a.outcome="failed";a.endedAtMs=this.now();a.reason=safeText(f.errorInfo?.category??"unknown");
      s.holds[taskKey(owner.taskId,owner.role)]=a.reason;
      if(!this.quota(f)){this.save(owner,s);this.changed(owner.projectId);return null;}
      this.pools(s,owner,f.rateLimits);
      const windows=f.rateLimits?.windows.filter(w=>w.status==="blocked")??[];
      const exhausted=windows.length?windows:[{providerKey:null,resetsAtMs:null}];
      for(const w of exhausted){
        const quota:Quota={provider:a.provider,hostId:owner.hostId,pool:w.providerKey?digest(w.providerKey):null,until:finite(w.resetsAtMs)&&w.resetsAtMs>this.now()?w.resetsAtMs:null,requestId:f.requestId};
        s.quotas.push(quota);this.db.prepare("INSERT OR IGNORE INTO team_resource_quota(id,data) VALUES(?,?)").run(digest([f.threadId,f.requestId,quota.pool]),JSON.stringify(quota));
      }
      // Unknown account scopes are conservatively pooled by host+BB provider.
      // Known providerKey hashes also exclude shared pools across providers.
      const selection=candidates.find(c=>!this.isBlocked(s,c.provider,owner.hostId));
      const reason=this.limit(s)??s.blocked??(owner.taskId===null?"No task is bound to this session":!selection?"No independent approved backup provider remains (shared quota, empty pool or unavailable catalog)":null);
      const result:ResourceFallback={requestId:f.requestId,threadId:f.threadId,role:owner.role,taskId:owner.taskId,stage:reason?"blocked":"selected",selection:selection??null,newThreadId:null,reason:reason??`Quota exhausted on ${a.provider}; use explicitly approved ${selection!.provider}/${selection!.model}`,atMs:this.now()};
      s.fallbacks[f.requestId]=result;this.save(owner,s);this.changed(owner.projectId);return result;
    });
  }
  async fallbackStage(owner:Pick<ResourceOwner,"projectId"|"team">,requestId:string,stage:ResourceFallback["stage"],reason?:string,newThreadId?:string){
    await this.serial(async()=>{const s=this.load(owner),f=s.fallbacks[requestId];if(!f)return;f.stage=stage;if(reason)f.reason=safeText(reason);if(newThreadId)f.newThreadId=newThreadId;
      if(stage==="complete")delete s.holds[taskKey(f.taskId,f.role)];
      if(stage==="error"||stage==="blocked")s.holds[taskKey(f.taskId,f.role)]=f.reason;
      this.save(owner,s);this.changed(owner.projectId);
    });
  }
  async notice(owner:Pick<ResourceOwner,"projectId"|"team">,reason:string):Promise<boolean>{return this.serial(async()=>{const s=this.load(owner);s.notices??=[];const key=digest(reason);if(s.notices.includes(key))return false;s.notices.push(key);this.save(owner,s);return true;});}
  async bindSwitch(owner:Pick<ResourceOwner,"projectId"|"team">,oldThreadId:string,newThreadId:string){
    await this.serial(async()=>{const s=this.load(owner);for(const f of Object.values(s.fallbacks))if(f.threadId===oldThreadId&&f.stage!=="complete"){f.stage="switching";f.newThreadId=newThreadId;delete s.holds[taskKey(f.taskId,f.role)];}this.save(owner,s);});
  }
  async cancelled(threadId:string,id:string){const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner),t=s.threads[threadId];const a=t&&this.attempt(s,t);if(a?.outcome==="reserved"&&a.queuedIds.includes(id)){a.queuedIds=a.queuedIds.filter(q=>q!==id);if(!a.queuedIds.length)this.finish(s,t,"cancelled","Queued start cancelled; its reservation remains in conservative accounting",this.now());this.save(owner,s);}});}
  async recovered(owner:Pick<ResourceOwner,"projectId"|"team">,oldThreadId:string,newThreadId:string){
    await this.serial(async()=>{const s=this.load(owner);for(const f of Object.values(s.fallbacks))if(f.threadId===oldThreadId){f.stage="complete";f.newThreadId=newThreadId;delete s.holds[taskKey(f.taskId,f.role)];}this.save(owner,s);});
  }
  async authorizeFallback(owner:Pick<ResourceOwner,"projectId"|"team">,requestId:string){
    await this.serial(async()=>{const s=this.load(owner),f=s.fallbacks[requestId];if(!f||f.stage!=="selected")throw new Error("Fallback is not selected or needs manual recovery");
      const reason=this.limit(s)??s.blocked;if(reason)throw new Error(reason);
      f.stage="switching";delete s.holds[taskKey(f.taskId,f.role)];this.save(owner,s);
    });
  }
}

/** Result projection is read from the chosen tracker, never stored in the ledger. */
export function withResourceResults(summary:ResourceSummary,tasks:TeamTask[]):ResourceSummary {
 const closed=tasks.filter(t=>t.status==="done");
 return {...summary,results:{accepted:closed.length,review:tasks.filter(t=>t.status==="review").length,reports:tasks.filter(t=>t.review?.submission).length,recent:closed.slice(-20).map(t=>({id:t.id,title:t.title,result:t.review?.submission?.result??t.result??null,checks:(t.review?.submission?.checks??[]).map(c=>({what:c.what,result:c.result??null,notApplicable:c.notApplicable??null})),acceptanceReason:t.review?.decisions.at(-1)?.reason??null}))}};
}
