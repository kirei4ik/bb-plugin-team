import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {STORAGE_MIGRATIONS} from "./storage-migrations";
import {executionJournal} from "./execution-journal";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import type { TaskId, TeamTask } from "../shared/snapshot";
import type { OllamaUsage } from "../shared/ollama-usage";
import type { ExecutionFallbackSelection } from "../shared/execution-policy";

export const resourcePolicySchema = z.object({
  coordinationAttempts: z.number().int().min(1).max(1000).optional(),
  taskAttempts: z.number().int().min(1).max(1000),
  /** Deprecated input retained for old clients; no team-wide start gate. */
  teamStarts: z.number().int().min(1).max(10000).nullable(),
  tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  minutes: z.number().int().positive().max(525600).nullable(),
}).strict();
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;
export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {coordinationAttempts:40,taskAttempts:8,teamStarts:null,tokens:null,minutes:null};
export const epicBudgetChangeSchema = z.object({
  epicId: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(10000),
  expectedActiveEpicId: z.string().nullable(),
  expectedRevision: z.number().int().nonnegative(),
  expectedUsed: z.number().int().nonnegative(),
  /** SHA256 fingerprint of the authoritative epic scope the human is approving. */
  expectedScopeRevision: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4000),
}).strict();
export type EpicBudgetChange = z.infer<typeof epicBudgetChangeSchema>;
/** Authoritative epic scope projection returned by the tracker validator. */
export interface EpicScope {title:string;criteria?:string;scopeRevision:string}
interface EpicBudget {limit:number;revision:number;sinceMs:number;approvedScopeRevision?:string;observedScopeRevision?:string}
export interface EpicBudgetSummary extends EpicBudget {
  id:string;used:number;remaining:number;title?:string;criteria?:string;blocked:string|null;
  unattributedTasks?:Array<{id:TaskId;title:string}>;
  scopeMismatch?:string|null;
}
class ResourceConflict extends Error {}
export interface ResourceOwner {projectId:string;team:string;role:string;taskId:TaskId|null;ownerThreadId:string;hostId:string|null;isLead?:boolean}
export interface ResourceAttempt {
  epicId?:string;
  epicScopeRevision?:string;
  userControl?:boolean;
  id:string;key:string;threadId:string;taskId:TaskId|null;role:string;provider:string;model:string|null;
  initiator:string;requestId:string|null;atMs:number;endedAtMs:number|null;
  outcome:"reserved"|"running"|"completed"|"failed"|"interrupted"|"cancelled"|"unknown";
  reason:string|null; tokens:number|null; queuedIds:string[];
}
interface TrackedThread {owner:ResourceOwner;cursor:number;lastUsage:number|null;reported:number;usageKnown:boolean;usagePartial:boolean;activeId:string|null;requestId:string|null;eventsAvailable:boolean}
interface Quota {cleared?:boolean;accountScope?:string;provider:string;hostId:string|null;pool:string|null;until:number|null;requestId:string}
export interface ResourceFallback {requestId:string;threadId:string;role:string;taskId:TaskId|null;stage:"blocked"|"selected"|"switching"|"complete"|"error";selection:ExecutionFallbackSelection|null;newThreadId:string|null;reason:string;atMs:number;manualReleased?:boolean}
interface ResourceState {
  activeEpicId?:string;epicBudgets?:Record<string,EpicBudget>;epicUnattributed?:string;
  version:1;startBudgetScope?:"package";sinceMs:number;policy:ResourcePolicy;attempts:ResourceAttempt[];threads:Record<string,TrackedThread>;
  holds:Record<string,string>;finished:string[];quotas:Quota[];pools:Record<string,string[]>;fallbacks:Record<string,ResourceFallback>;
  seenFailures:string[];notices:string[];returns:Array<{taskId:TaskId;role:string;ref:string;atMs:number}>;
  decisions:Array<{atMs:number;reason:string;taskId:TaskId|null;policy:ResourcePolicy}>;
  blocked:string|null;blockedAtMs:number|null;taskCeilings?:Record<string,number>;
}
export interface ResourceSummary {
  epic?:EpicBudgetSummary;epicBudgets?:Record<string,EpicBudget & {used:number}>;
  budgetNotice?:"sent"|"queued"|"busy"|"unavailable";
  startBudgetScope?:"package";
  taskBlocks?:Record<string,string>;
  blockedAtMs?:number|null;
  outcomeCounts?:Record<ResourceAttempt["outcome"],number>;
  ollamaUsage?:OllamaUsage;
  openrouterUsage?:Record<string,import("../shared/openrouter-usage").OpenRouterUsage>;
  quotaPolicy?:import("../shared/ollama-usage").QuotaPolicy;
  taskLimits?:Record<string,number>;
  sinceMs:number;policy:ResourcePolicy;starts:number;remainingStarts:number|null;reportedTokens:number|null;
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

const piAccountScope=(provider:string,model?:string|null)=>provider==="pi"&&(model?.startsWith("ollama-cloud/")||model?.startsWith("openrouter/"))?model.split("/")[0]:undefined;
export function independentQuotaSelection(provider:string,model:string|null|undefined,candidate:ExecutionFallbackSelection):boolean {
 if(candidate.provider!==provider)return true;
 const from=piAccountScope(provider,model),to=piAccountScope(candidate.provider,candidate.model);
 return !!from&&!!to&&from!==to;
}
export function confirmedQuota(f:PluginTurnFailedEvent):boolean {
 return f.errorInfo?.category==="budget-exceeded"||(f.errorInfo?.category==="rate-limit"&&f.rateLimits?.status==="blocked"&&f.rateLimits.kind!=="unknown");
}

/** Technical accounting only. No task content, model calls, polling or retry scheduler. */
export class ResourceControl {
  private db:ReturnType<BbPluginApi["storage"]["database"]>;
  private tail:Promise<unknown>=Promise.resolve();
  private snapshots = new WeakMap<ResourceState,string|null>();
  private enabledAt:number;
  constructor(private bb:BbPluginApi,private resolve:(threadId:string)=>Promise<ResourceOwner|null>,private changed:(projectId:string)=>void,private now=Date.now, private validateEpic?:(owner:ResourceOwner,epicId:string)=>Promise<EpicScope>) {
    this.enabledAt=this.now();
    this.db=bb.storage.database();
    bb.storage.migrate(this.db, STORAGE_MIGRATIONS);
    executionJournal(bb);
  }
  private scope(owner:Pick<ResourceOwner,"projectId"|"team">){return JSON.stringify([owner.projectId,owner.team]);}
  private load(owner:Pick<ResourceOwner,"projectId"|"team">):ResourceState {
    const row=this.db.prepare("SELECT data FROM team_resource_state WHERE scope=?").get(this.scope(owner)) as {data:string}|undefined;
    const state:ResourceState=row?JSON.parse(row.data):{version:1,startBudgetScope:"package",sinceMs:this.enabledAt,policy:{...DEFAULT_RESOURCE_POLICY},attempts:[],threads:{},holds:{},finished:[],quotas:[],pools:{},fallbacks:{},seenFailures:[],notices:[],returns:[],decisions:[],blocked:null,blockedAtMs:null};
    this.snapshots.set(state,row?.data??null);
    if(state.startBudgetScope!=="package"){
      // Preserve every existing package's effective allowance and all spending.
      state.taskCeilings??={};
      for(const a of state.attempts)if(a.taskId!==null){const key=taskKey(a.taskId,a.role);state.taskCeilings[key]??=this.defaultTaskLimit(state,a.taskId);}
      if(state.blocked?.startsWith("Team start limit reached")||state.blocked?.startsWith("Task attempt limit reached")){state.blocked=null;state.blockedAtMs=null;}
      state.startBudgetScope="package";
      state.decisions.push({atMs:this.now(),reason:"Start budgets moved to work packages; legacy team start cap retired, usage retained",taskId:null,policy:{...state.policy,teamStarts:null}});
    }
    state.policy.teamStarts=null;
    return state;
  }
  private save(owner:Pick<ResourceOwner,"projectId"|"team">,state:ResourceState){
    const old = this.load(owner);
    const attempts = new Map(old.attempts.map(a => [a.id, a.outcome]));
    this.db.transaction(() => {
      const current=this.db.prepare("SELECT data FROM team_resource_state WHERE scope=?").get(this.scope(owner)) as {data:string}|undefined;
      if ((current?.data??null)!==this.snapshots.get(state)) throw new ResourceConflict("Resource state changed; refresh before another admission or budget decision");
      this.db.prepare("INSERT INTO team_resource_state(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data").run(this.scope(owner),JSON.stringify(state));
      const journal = executionJournal(this.bb);
      for (const a of state.attempts) if (attempts.get(a.id) !== a.outcome) journal.record({...owner, taskId:a.taskId, role:a.role, threadId:a.threadId, operationId:a.id, eventType:"attempt", nextState:a.outcome, reasonCode:`attempt_${a.outcome}`, provider:a.provider, model:a.model, timestamp:a.endedAtMs ?? a.atMs});
      for (const f of Object.values(state.fallbacks)) if (old.fallbacks[f.requestId]?.stage !== f.stage) journal.record({...owner, taskId:f.taskId, role:f.role, threadId:f.threadId, operationId:f.requestId, eventType:"fallback", nextState:f.stage, reasonCode:`fallback_${f.stage}`, provider:f.selection?.provider ?? null, model:f.selection?.model ?? null});
      for (let i=old.decisions.length; i<state.decisions.length; i++) {const d=state.decisions[i]!; journal.record({...owner, taskId:d.taskId, role:"", threadId:null, operationId:`decision:${i}:${d.atMs}`, eventType:"decision", nextState:"recorded", reasonCode:"resource_decision", provider:null, model:null, timestamp:d.atMs});}
    })();
    this.snapshots.set(state,JSON.stringify(state));
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const work=this.tail.catch(()=>{}).then(fn);this.tail=work;return work;}
  private track(state:ResourceState,id:string,owner:ResourceOwner):TrackedThread {
    const previous=state.threads[id];
    if(previous){previous.owner=owner;return previous;}
    return state.threads[id]={owner,cursor:0,lastUsage:null,reported:0,usageKnown:false,usagePartial:false,activeId:null,requestId:null,eventsAvailable:true};
  }
  private attempt(state:ResourceState,thread:TrackedThread){return state.attempts.find(a=>a.id===thread.activeId);}
  private append(state:ResourceState,owner:ResourceOwner,id:string,key:string,provider:string,model:string|null,initiator:string):ResourceAttempt {
    const epicId=state.activeEpicId,epicScopeRevision=epicId?state.epicBudgets?.[epicId]?.approvedScopeRevision:undefined;
    const attempt:ResourceAttempt={...(epicId?{epicId}:{}),...(epicScopeRevision?{epicScopeRevision}:{}),id:randomUUID(),key,threadId:id,taskId:owner.taskId,role:owner.role,provider,model,initiator,requestId:null,atMs:this.now(),endedAtMs:null,outcome:"reserved",reason:null,tokens:null,queuedIds:[]};
    if(owner.taskId!==null){state.taskCeilings??={};state.taskCeilings[taskKey(owner.taskId,owner.role)]??=owner.isLead?state.policy.coordinationAttempts??state.policy.taskAttempts:state.policy.taskAttempts;}
    state.attempts.push(attempt);state.threads[id]!.activeId=attempt.id;return attempt;
  }
  private finish(state:ResourceState,thread:TrackedThread,outcome:ResourceAttempt["outcome"],reason:string|null,atMs:number){
    const active=this.attempt(state,thread);if(!active||terminal(active))return;
    active.outcome=outcome;active.endedAtMs=atMs;active.reason=reason;
    if(outcome==="failed"||outcome==="interrupted")state.holds[taskKey(active.taskId,active.role)]=reason??outcome;
  }
  private pools(state:ResourceState,owner:ResourceOwner,rate:unknown,model?:string|null):string[]{
    if(!rate||typeof rate!=="object")return [];
    const raw=rate as {providerId?:unknown;status?:unknown;windows?:Array<{providerKey?:unknown;status?:unknown}>};
    if(typeof raw.providerId!=="string"||!Array.isArray(raw.windows))return [];
    const accountScope=piAccountScope(raw.providerId,model);
    const keys=raw.windows.flatMap(w=>typeof w.providerKey==="string"?[digest(w.providerKey)]:[]);
    this.db.prepare("INSERT INTO team_resource_provider_pools(provider,pools) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET pools=excluded.pools").run(JSON.stringify([owner.hostId,raw.providerId,...(accountScope?[accountScope]:[])]),JSON.stringify(keys));
    if(raw.status==="allowed"&&raw.windows.every(w=>w.status!=="blocked")){
      const rows=this.db.prepare("SELECT id,data FROM team_resource_quota").all() as Array<{id:string;data:string}>;
      for(const row of rows){const q=JSON.parse(row.data) as Quota;if(q.hostId===owner.hostId&&q.provider===raw.providerId&&q.accountScope===accountScope&&(q.pool===null||keys.includes(q.pool))){q.cleared=true;this.db.prepare("UPDATE team_resource_quota SET data=? WHERE id=?").run(JSON.stringify(q),row.id);}}
    }
    return keys;
  }
  private quotas():Quota[]{return (this.db.prepare("SELECT data FROM team_resource_quota").all() as Array<{data:string}>).map(r=>JSON.parse(r.data) as Quota);}
  private isBlocked(provider:string,hostId:string|null,model?:string|null):boolean{
    const accountScope=piAccountScope(provider,model);
    const entry=this.db.prepare("SELECT pools FROM team_resource_provider_pools WHERE provider=?").get(JSON.stringify([hostId,provider,...(accountScope?[accountScope]:[])])) as {pools:string}|undefined;
    const legacy=accountScope?this.db.prepare("SELECT pools FROM team_resource_provider_pools WHERE provider=?").get(JSON.stringify([hostId,provider])) as {pools:string}|undefined:undefined;
    const known:string[]=[...(entry?JSON.parse(entry.pools):[]),...(legacy?JSON.parse(legacy.pools):[])];
    return this.quotas().some(q=>(q.provider===provider&&q.hostId===hostId&&(!q.accountScope||!accountScope||q.accountScope===accountScope)||q.pool!==null&&known.includes(q.pool))&&!q.cleared);
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
                const firstEpicAt=Math.min(...Object.values(state.epicBudgets??{}).map(b=>b.sinceMs));
                const predatesEpics=row.createdAt<firstEpicAt;
                if(state.activeEpicId&&!predatesEpics)state.epicUnattributed="An unreserved turn was observed during epic accounting; inspect its task attribution and record an epic budget decision";
                const dto=await this.bb.sdk.threads.get({threadId:id});
                active=this.append(state,thread.owner,id,`observed:${row.id}`,dto.providerId,null,"override/observed");
                if(predatesEpics){delete active.epicId;delete active.epicScopeRevision;}
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
              this.pools(state,thread.owner,data.rateLimits,this.attempt(state,thread)?.model);
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
  private defaultTaskLimit(state:ResourceState,taskId:TaskId):number {
    const lead=state.attempts.some(a=>a.taskId===taskId&&state.threads[a.threadId]?.owner.isLead);
    return lead?state.policy.coordinationAttempts??state.policy.taskAttempts:state.policy.taskAttempts;
  }
  private taskUsed(state:ResourceState,taskId:TaskId,excluding?:string):number {
    return state.attempts.filter(a=>a.id!==excluding&&a.taskId===taskId).length+(state.returns??[]).filter(r=>r.taskId===taskId).length;
  }
  private packageLimit(state:ResourceState,owner:ResourceOwner,excluding?:string):string|null {
    if(owner.taskId===null){
      const count=state.attempts.filter(a=>a.id!==excluding&&a.taskId===null&&state.threads[a.threadId]?.owner.ownerThreadId===owner.ownerThreadId).length;
      const ceiling=owner.isLead?state.policy.coordinationAttempts??state.policy.taskAttempts:state.policy.taskAttempts;
      return count>=ceiling?"Assign a work package before more starts; this session's initialization allowance is exhausted":null;
    }
    const key=taskKey(owner.taskId,owner.role),count=this.taskUsed(state,owner.taskId,excluding);
    const ceiling=state.taskCeilings?.[key]??(owner.isLead?state.policy.coordinationAttempts??state.policy.taskAttempts:state.policy.taskAttempts);
    return count>=ceiling?`Task attempt limit reached (${key}: ${count}/${ceiling}); changing session or model cannot reset this package`:null;
  }
  private epicUsed(state:ResourceState,epicId:string,excluding?:string){
    return state.attempts.filter(a=>a.epicId===epicId&&a.id!==excluding).length;
  }
  private epicLimit(state:ResourceState,excluding?:string):string|null {
    const id=state.activeEpicId;if(!id)return null;
    const budget=Object.hasOwn(state.epicBudgets??{},id)?state.epicBudgets![id]:undefined;
    if(!budget)return "Active epic has no finite budget; inspect Team resources";
    if(state.epicUnattributed)return state.epicUnattributed;
    const used=this.epicUsed(state,id,excluding);
    return used>=budget.limit?`Epic budget exhausted (${id}: ${used}/${budget.limit}); use Team → Epic budget or bb team budget ${id} --epic for a human decision`:null;
  }
  private scopeMismatchReason(budget:EpicBudget|undefined):string|null{
    if(!budget)return "Active epic has no finite budget; inspect Team resources";
    if(!budget.approvedScopeRevision)return "Epic scope is not yet approved for this budget; a human must approve the current Beads revision before automatic work";
    if(budget.observedScopeRevision&&budget.observedScopeRevision!==budget.approvedScopeRevision)return `Epic scope changed since approval (approved ${budget.approvedScopeRevision.slice(0,8)}, observed ${budget.observedScopeRevision.slice(0,8)}); a human must approve the new revision`;
    return null;
  }
  private async epicScope(state:ResourceState,owner:ResourceOwner):Promise<string|null>{
    if(!state.activeEpicId)return null;
    const id=state.activeEpicId;
    try {
      if(!this.validateEpic)throw new Error("Epic membership validator unavailable");
      const observed=await this.validateEpic(owner,id);
      const budget=Object.hasOwn(state.epicBudgets??{},id)?state.epicBudgets![id]:undefined;
      if(budget)budget.observedScopeRevision=observed.scopeRevision;
      return this.scopeMismatchReason(budget);
    } catch(error){return `Epic scope held: ${safeText(error instanceof Error?error.message:String(error))}`;}
  }
  /** Preflight only: admission reserves again, after a fresh authoritative scope check. */
  async assertDispatch(owner:ResourceOwner){
    await this.serial(async()=>{const s=this.load(owner);await this.syncAll(s);
      const reason=await this.epicScope(s,owner)??this.epicLimit(s);
      this.save(owner,s);if(reason)throw new Error(reason);
    });
  }
  async setEpicBudget(owner:Pick<ResourceOwner,"projectId"|"team">,input:EpicBudgetChange,validate:()=>Promise<{scopeRevision:string}>,record:()=>Promise<void>){
    const change=epicBudgetChangeSchema.parse(input);
    return this.serial(async()=>{
      const s=this.load(owner);await this.syncAll(s);
      const prior=Object.hasOwn(s.epicBudgets??{},change.epicId)?s.epicBudgets![change.epicId]:undefined;
      const used=this.epicUsed(s,change.epicId);
      if((s.activeEpicId??null)!==change.expectedActiveEpicId||(prior?.revision??0)!==change.expectedRevision||used!==change.expectedUsed)
        throw new Error("Epic budget changed; refresh before saving");
      if(s.attempts.some(a=>!terminal(a)))throw new Error("Finish outstanding admissions before changing the epic budget");
      // A human approves the exact observed Beads scope revision. Verify before the
      // tracker write and again after it, so a raced external change cannot slip in.
      const before=await validate();
      if(before.scopeRevision!==change.expectedScopeRevision)throw new Error("Epic scope changed before approval; refresh before saving");
      await record();
      const after=await validate();
      if(after.scopeRevision!==change.expectedScopeRevision)throw new Error("Epic scope changed during approval; the tracker decision is recorded but the budget was not changed, re-read and re-approve");
      s.epicBudgets={...s.epicBudgets,[change.epicId]:{limit:change.limit,revision:(prior?.revision??0)+1,sinceMs:prior?.sinceMs??this.now(),approvedScopeRevision:change.expectedScopeRevision,observedScopeRevision:change.expectedScopeRevision}};
      s.activeEpicId=change.epicId;delete s.epicUnattributed;
      // Ordinary quota/failure holds and shared token/time guards survive.
      s.blocked=this.limit(s);s.blockedAtMs=s.blocked?this.now():null;
      s.decisions.push({atMs:this.now(),reason:`Epic budget ${change.epicId}: ${prior?.limit??0} → ${change.limit}; ${used} used; grounds in Beads`,taskId:change.epicId,policy:{...s.policy}});
      this.save(owner,s);this.changed(owner.projectId);return this.summary(s);
    });
  }
  private limit(state:ResourceState,owner?:ResourceOwner,excluding?:string):string|null {
    const epic=this.epicLimit(state,excluding);if(epic)return epic;
    if(state.attempts.length>=10000)return "Accounting history reached its safety limit; manual resource decision required";
    if(state.attempts.length&&state.policy.minutes!==null&&this.now()-state.attempts[0]!.atMs>=state.policy.minutes*60000)return `Team time limit reached (${state.policy.minutes} minutes)`;
    const usage=Object.values(state.threads).reduce((n,t)=>n+t.reported,0);
    if(state.policy.tokens!==null&&usage>=state.policy.tokens)return `Reported cumulative token limit reached (${state.policy.tokens}); unsupported usage remains unknown`;
    return owner?this.packageLimit(state,owner,excluding):null;
  }
  private block(state:ResourceState,reason:string){if(state.blocked!==reason){state.blocked=reason;state.blockedAtMs=this.now();}}
  private summary(state:ResourceState):ResourceSummary {
    const outcomeCounts:Record<ResourceAttempt["outcome"],number>={reserved:0,running:0,completed:0,failed:0,interrupted:0,cancelled:0,unknown:0};
    for(const attempt of state.attempts)outcomeCounts[attempt.outcome]++;
    const threads=Object.values(state.threads);
    const grouped=new Map<string,{taskId:TaskId|null;role:string;starts:number;returns:number}>();
    for(const a of state.attempts){const key=taskKey(a.taskId,a.role),row=grouped.get(key)??{taskId:a.taskId,role:a.role,starts:0,returns:0};row.starts++;grouped.set(key,row);}
    for(const returned of state.returns??[]){const key=taskKey(returned.taskId,returned.role),row=grouped.get(key)??{taskId:returned.taskId,role:returned.role,starts:0,returns:0};row.returns++;grouped.set(key,row);}
    const taskBlocks:Record<string,string>={};
    const visited=new Set<string>();
    for(const a of state.attempts){const key=taskKey(a.taskId,a.role);if(a.taskId===null||visited.has(key)||state.finished.includes(key))continue;visited.add(key);const owner=state.threads[a.threadId]?.owner;if(!owner)continue;const reason=this.packageLimit(state,{...owner,taskId:a.taskId});if(reason)taskBlocks[taskKey(a.taskId,a.role)]=reason;}
    const epicBudgets=Object.fromEntries(Object.entries(state.epicBudgets??{}).map(([id,b])=>[id,{...b,used:this.epicUsed(state,id)}]));
    const id=state.activeEpicId,b=id?epicBudgets[id]:undefined;
    const scopeMismatch=id&&b?this.scopeMismatchReason(b):null;
    const epic=id&&b?{...b,id,remaining:Math.max(0,b.limit-b.used),blocked:scopeMismatch??this.epicLimit(state),scopeMismatch}:undefined;
    return {...(epic?{epic}:{}),epicBudgets,startBudgetScope:"package",taskBlocks,outcomeCounts,blockedAtMs:state.blockedAtMs,taskLimits:{...state.taskCeilings},quotaBlocks:this.quotas().filter(q=>!q.cleared).map(q=>({provider:q.provider,hostId:q.hostId,resetAtMs:q.until})),taskCounts:[...grouped.values()],sinceMs:state.sinceMs,policy:state.policy,starts:state.attempts.length,remainingStarts:null,reportedTokens:threads.some(t=>t.usageKnown)?threads.reduce((n,t)=>n+t.reported,0):null,usageCoverage:threads.some(t=>t.usageKnown)?"partial":"unavailable",blocked:state.blocked,holds:state.holds,attempts:state.attempts.slice(-100),fallbacks:Object.values(state.fallbacks).slice(-50)};
  }
  async admit(ctx:MessageDispatchHookContext):Promise<MessageDispatchHookDecision>{
    if(ctx.attempt!=="start-turn")return {action:"proceed"};
    const owner=await this.resolve(ctx.thread.id);if(!owner)return {action:"proceed"};
    return this.serial<MessageDispatchHookDecision>(async()=>{
      const current=await this.resolve(ctx.thread.id);
      if(!current)return {action:"wait",reason:"Team binding changed; inspect the current task"};
      const owner=current;
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
      if(holdingFallback) {
        const retired = holdingFallback.stage === "complete" && holdingFallback.newThreadId !== null && holdingFallback.newThreadId !== ctx.thread.id;
        return {action:"reject",message:retired
          ? "Team: this session was replaced after a quota failure. Open the employee's current session in Team."
          : `Team: continuation is paused after a quota failure for task ${holdingFallback.taskId ?? holdingFallback.role}. Open Team → Limits, quotas and history, enter your decision and choose Allow next start with this decision. This does not require a new session or reset budgets. Reason: ${holdingFallback.reason}`};
      }
      const pending=Object.values(state.fallbacks).find(f=>f.taskId!==null&&f.taskId===owner.taskId&&f.stage!=="complete"&&!f.manualReleased&&f.newThreadId!==ctx.thread.id);
      if(pending)return {action:"wait",reason:`Team is preserving task ${owner.taskId} during quota recovery: ${pending.reason}`};
      // A real user must be able to discuss and approve a package budget with
      // the lead. This waives only its package gate, never quota/error/shared guards.
      const directUser=ctx.initiator==="user"&&ctx.senderThreadId===null&&ctx.originPluginId===null;
      const groupedUser=ctx.initiator==="mixed"&&ctx.queuedMessages.some(m=>m.initiator==="user"&&m.senderThreadId===null&&m.originPluginId===null&&m.payload?.kind!=="retry");
      const userControl=!!owner.isLead&&owner.ownerThreadId===ctx.thread.id&&(directUser||groupedUser);
      const scopeReason=await this.epicScope(state,owner);
      const limit=scopeReason??this.limit(state,userControl?undefined:owner,reentry?active!.id:undefined);
      const quota=this.isBlocked(ctx.requestedExecution.providerId,owner.hostId,ctx.requestedExecution.model);
      const reason=limit??(state.blocked?.startsWith("Epic budget exhausted")?this.epicLimit(state,reentry?active!.id:undefined):state.blocked)??state.holds[taskKey(owner.taskId,owner.role)]??(quota?"Provider quota is blocked for this host/account scope; wait for reset or choose an approved independent provider":null);
      if(reason){const changed=limit&&state.blocked!==limit;const shared=this.limit(state);if(shared)this.block(state,shared);this.save(owner,state);if(changed)this.changed(owner.projectId);return {action:"wait",reason:`Team resources: ${reason}. Review the resource panel; active work is not interrupted.`};}
      if(reentry){this.save(owner,state);return {action:"proceed"};}
      if(active&&!terminal(active)){
        if(ctx.thread.status==="idle"||ctx.thread.status==="error"){this.finish(state,thread,"unknown","Previous admission has no complete event; reserved cost is retained",this.now());state.holds[taskKey(owner.taskId,owner.role)]="Previous attempt outcome is unknown; inspect it before a concrete manual decision";this.save(owner,state);return {action:"wait",reason:state.holds[taskKey(owner.taskId,owner.role)]!};}
        else return {action:"wait",reason:"Team is waiting for the previous attempt's outcome"};
      }
      const previous=state.attempts.find(a=>a.key===key);
      if(previous)return {action:"wait",reason:"This admission already completed; inspect its result before explicitly requesting another attempt"};
      const attempt=this.append(state,owner,ctx.thread.id,key,ctx.requestedExecution.providerId,ctx.requestedExecution.model,ctx.initiator);
      attempt.userControl=userControl;attempt.queuedIds=queued;this.save(owner,state);this.changed(owner.projectId);return {action:"proceed"};
    }).catch(error=>{if(error instanceof ResourceConflict)return {action:"wait",reason:error.message} as MessageDispatchHookDecision;throw error;});
  }
  async watch(threadId:string){const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner);this.track(s,threadId,owner);await this.syncThread(s,threadId);this.save(owner,s);});}
  async queued(threadId:string,id:string,isRetry=false){if(isRetry)return;const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner),t=s.threads[threadId];const a=t&&this.attempt(s,t);if(a?.outcome==="reserved"&&!a.queuedIds.includes(id)){a.queuedIds.push(id);this.save(owner,s);}});}
  async settle(threadId:string,outcome:"completed"|"failed"|"interrupted"){
    const owner=await this.resolve(threadId);if(!owner)return;
    await this.serial(async()=>{const s=this.load(owner);this.track(s,threadId,owner);await this.syncThread(s,threadId);const t=s.threads[threadId]!;this.finish(s,t,outcome,outcome==="completed"?null:"Failure requires a concrete next approach",this.now());this.save(owner,s);});
  }
  // Positive fixed-endpoint balance can retire only this host's known Ollama
  // exclusions. Unknown Pi pools and independent upstream accounts stay held.
  async confirmOpenRouterCapacity(owner:ResourceOwner,provider:string,model:string){return this.serial(async()=>{
    const s=this.load(owner);
    const requests=new Set(s.attempts.filter(a=>a.threadId===owner.ownerThreadId&&a.provider===provider&&a.model===model&&a.outcome==="failed").map(a=>a.requestId));
    for(const row of this.db.prepare("SELECT id,data FROM team_resource_quota").all() as Array<{id:string;data:string}>){
      const q=JSON.parse(row.data) as Quota;
      // No provider-wide reset: other keys/accounts and other owners keep their
      // exclusions until independently verified. Budgets/counters are untouched.
      if(q.hostId===owner.hostId&&q.provider===provider&&requests.has(q.requestId))this.db.prepare("UPDATE team_resource_quota SET data=? WHERE id=?").run(JSON.stringify({...q,cleared:true}),row.id);
    }
  });}
  // A fresh native Codex check authorizes only this failed session/package.
  // Verification runs under the admission lock; no counters or other holds reset.
  async recoverCodexCapacity(owner:ResourceOwner,verify:()=>Promise<void>){return this.serial(async()=>{
    const s=this.load(owner);await this.syncAll(s);
    if(s.attempts.some(a=>!terminal(a)))throw new Error("Finish outstanding admissions before recovery");
    await verify();
    const requests=new Set(s.attempts.filter(a=>a.threadId===owner.ownerThreadId&&a.taskId===owner.taskId&&a.provider==="codex"&&a.outcome==="failed").map(a=>a.requestId));
    this.db.transaction(()=>{
    for(const row of this.db.prepare("SELECT id,data FROM team_resource_quota").all() as Array<{id:string;data:string}>){
      const q=JSON.parse(row.data) as Quota;
      if(q.hostId===owner.hostId&&q.provider==="codex"&&requests.has(q.requestId))this.db.prepare("UPDATE team_resource_quota SET data=? WHERE id=?").run(JSON.stringify({...q,cleared:true}),row.id);
    }
    if(this.isBlocked("codex",owner.hostId))throw new Error("Another unresolved Codex quota exclusion remains; inspect its session before resuming");
    const key=taskKey(owner.taskId,owner.role);
    if(["rate-limit","budget-exceeded"].includes(s.holds[key]??""))delete s.holds[key];
    for(const f of Object.values(s.fallbacks))if(requests.has(f.requestId)&&f.threadId===owner.ownerThreadId&&(f.stage==="blocked"||f.stage==="error")){f.stage="error";f.manualReleased=true;}
    s.decisions.push({atMs:this.now(),reason:"Manual resume after a fresh native Codex quota check for this session",taskId:owner.taskId,policy:{...s.policy}});
    this.save(owner,s);
    })();
    this.changed(owner.projectId);
  });}
  async confirmOllamaCapacity(hostId:string){return this.serial(async()=>{
    for(const row of this.db.prepare("SELECT id,data FROM team_resource_quota").all() as Array<{id:string;data:string}>){
      const q=JSON.parse(row.data) as Quota;
      if(q.provider==="pi"&&q.hostId===hostId&&q.accountScope==="ollama-cloud")this.db.prepare("UPDATE team_resource_quota SET data=? WHERE id=?").run(JSON.stringify({...q,cleared:true}),row.id);
    }
  });}
  async quotaExcluded(owner:Pick<ResourceOwner,"hostId">,selection:ExecutionFallbackSelection){
    return this.serial(async()=>this.isBlocked(selection.provider,owner.hostId,selection.model));
  }
  async inspect(owner:Pick<ResourceOwner,"projectId"|"team">){return this.serial(async()=>{const s=this.load(owner);await this.syncAll(s);
      let summary=this.summary(s);summary.blocked??=this.limit(s);
      const epicId=summary.epic?.id;
      if(epicId!==undefined){
        try {
          if(!this.validateEpic)throw new Error("Epic membership validator unavailable");
          const observed=await this.validateEpic({...owner,role:"",taskId:epicId,ownerThreadId:"",hostId:null,isLead:true},epicId);
          const budget=Object.hasOwn(s.epicBudgets??{},epicId)?s.epicBudgets![epicId]:undefined;
          if(budget)budget.observedScopeRevision=observed.scopeRevision;
          summary=this.summary(s);summary.blocked??=this.limit(s);
          const epic=summary.epic;
          if(epic){Object.assign(epic,{title:observed.title,...(observed.criteria!==undefined?{criteria:observed.criteria}:{})});if(epic.scopeMismatch)summary.blocked??=epic.scopeMismatch;}
        } catch(error){const epic=summary.epic;if(epic){epic.blocked=`Epic scope held: ${safeText(error instanceof Error?error.message:String(error))}`;summary.blocked??=epic.blocked;}}
      }
      this.save(owner,s);return summary;});}
  async decide(owner:Pick<ResourceOwner,"projectId"|"team">,reason:string,policy?:ResourcePolicy,taskId?:TaskId,role?:string,decisionSource:"tracker"|"capacity"="tracker",requireQuiescent=false){
    if(!reason.trim())throw new Error("A concrete manual resource decision is required");
    return this.serial(async()=>{const s=this.load(owner);
      if(requireQuiescent){await this.syncAll(s);if(s.attempts.some(a=>!terminal(a)))throw new Error("Finish outstanding admissions before this decision");}
      if(policy)s.policy={...resourcePolicySchema.parse(policy),teamStarts:null};
      if(taskId!==undefined||role){delete s.holds[taskKey(taskId??null,role??"")];for(const f of Object.values(s.fallbacks))if((taskId!==undefined?f.taskId===taskId:f.taskId===null&&f.role===role)&&(f.stage==="blocked"||f.stage==="error")){f.stage="error";f.manualReleased=true;}}
      const limit=this.limit(s);s.blocked=limit;s.blockedAtMs=limit?this.now():null;
      s.decisions.push({atMs:this.now(),reason:taskId!==undefined&&decisionSource==="tracker"?"Concrete task approach decision is recorded in the selected tracker":safeText(reason),taskId:taskId??null,policy:{...s.policy}});this.save(owner,s);return this.summary(s);
    });
  }
  async userControlTurn(threadId:string):Promise<string|null>{
    const owner=await this.resolve(threadId);if(!owner?.isLead)return null;
    return this.serial(async()=>{const s=this.load(owner);await this.syncThread(s,threadId);this.save(owner,s);
      const thread=s.threads[threadId],attempt=thread&&this.attempt(s,thread);
      return attempt?.userControl&&!terminal(attempt)?attempt.id:null;
    });
  }
  async pinPackages(owner:Pick<ResourceOwner,"projectId"|"team">,tasks:TeamTask[],leadRole:string|null){
    return this.serial(async()=>{const s=this.load(owner);s.taskCeilings??={};
      for(const task of tasks)if(["todo","in-progress","review"].includes(task.status))s.taskCeilings[taskKey(task.id,task.role)]??=task.role===leadRole?s.policy.coordinationAttempts??s.policy.taskAttempts:s.policy.taskAttempts;
      this.save(owner,s);
    });
  }
  async setPackageLimit(owner:ResourceOwner,limit:number,expectedLimit:number,expectedUsed:number,record:()=>Promise<void>,requireQuiescent=false){
    return this.serial(async()=>{
      const s=this.load(owner);await this.syncAll(s);
      if(requireQuiescent&&s.attempts.some(a=>!terminal(a)))throw new Error("Finish outstanding admissions before changing resources");
      if(owner.taskId===null||!Number.isInteger(limit)||limit<1||limit>1000)throw new Error("Invalid package budget");
      const key=taskKey(owner.taskId,owner.role),used=this.taskUsed(s,owner.taskId);
      const current=s.taskCeilings?.[key]??(owner.isLead?s.policy.coordinationAttempts??s.policy.taskAttempts:s.policy.taskAttempts);
      if(used!==expectedUsed||current!==expectedLimit)throw new Error("Package budget changed; refresh before saving");
      await record();
      s.taskCeilings??={};s.taskCeilings[key]=limit;
      s.blocked=this.limit(s);s.blockedAtMs=s.blocked?this.now():null;
      s.decisions.push({atMs:this.now(),reason:`Package budget changed from ${current} to ${limit}; ${used} already used; grounds recorded in tracker`,taskId:owner.taskId,policy:{...s.policy}});
      this.save(owner,s);return this.summary(s);
    });
  }
  async extendCoordination(owner:ResourceOwner,expectedStarts:number,expectedUsed:number,record:()=>Promise<void>,requireQuiescent=false){
    return this.serial(async()=>{
      const s=this.load(owner);await this.syncAll(s);
      if(requireQuiescent&&s.attempts.some(a=>!terminal(a)))throw new Error("Finish outstanding admissions before changing resources");
      if(!owner.isLead||owner.taskId===null)throw new Error("Only an unfinished coordination task can receive this allowance");
      const key=taskKey(owner.taskId,owner.role);
      const count=s.attempts.filter(a=>taskKey(a.taskId,a.role)===key).length+(s.returns??[]).filter(r=>taskKey(r.taskId,r.role)===key).length;
      const reason=this.limit(s,owner);
      if(s.attempts.length!==expectedStarts||count!==expectedUsed||!reason?.startsWith(`Task attempt limit reached (${key}:`))throw new Error("Resource state changed; refresh before allowing more work");
      const ceiling=count+4;if(ceiling>1000)throw new Error("Coordination safety limit reached");
      // Record the exact decision in the chosen task source before any release.
      await record();
      s.taskCeilings??={};s.taskCeilings[key]=ceiling;
      s.blocked=this.limit(s);s.blockedAtMs=s.blocked?this.now():null;
      s.decisions.push({atMs:this.now(),reason:"Four additional coordination turns explicitly allowed",taskId:owner.taskId,policy:{...s.policy}});
      this.save(owner,s);return this.summary(s);
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
  async failed(f:PluginTurnFailedEvent,candidates:ExecutionFallbackSelection[],observedModel?:string):Promise<ResourceFallback|null>{
    const owner=await this.resolve(f.threadId);if(!owner)return null;
    return this.serial(async()=>{
      const s=this.load(owner);this.track(s,f.threadId,owner);await this.syncThread(s,f.threadId);
      s.seenFailures??=[];if(s.seenFailures.includes(f.requestId))return null;s.seenFailures.push(f.requestId); // Event replay must not cause another switch.
      const thread=s.threads[f.threadId]!;
      let a=s.attempts.find(a=>a.requestId===f.requestId)??this.attempt(s,thread);
      if(!a){if(s.activeEpicId)s.epicUnattributed="An unreserved failed turn needs an explicit epic attribution decision";const dto=await this.bb.sdk.threads.get({threadId:f.threadId});a=this.append(s,owner,f.threadId,`failed:${f.requestId}`,dto.providerId,null,"observed failure");}
      a.model??=observedModel??null;
      a.requestId=f.requestId;a.outcome="failed";a.endedAtMs=this.now();a.reason=safeText(f.errorInfo?.category??"unknown");
      s.holds[taskKey(owner.taskId,owner.role)]=a.reason;
      if(!this.quota(f)){this.save(owner,s);this.changed(owner.projectId);return null;}
      this.pools(s,owner,f.rateLimits,a.model);
      const windows=f.rateLimits?.windows.filter(w=>w.status==="blocked")??[];
      const exhausted=windows.length?windows:[{providerKey:null,resetsAtMs:null}];
      for(const w of exhausted){
        const quota:Quota={accountScope:piAccountScope(a.provider,a.model),provider:a.provider,hostId:owner.hostId,pool:w.providerKey?digest(w.providerKey):null,until:finite(w.resetsAtMs)&&w.resetsAtMs>this.now()?w.resetsAtMs:null,requestId:f.requestId};
        s.quotas.push(quota);this.db.prepare("INSERT OR IGNORE INTO team_resource_quota(id,data) VALUES(?,?)").run(digest([f.threadId,f.requestId,quota.pool]),JSON.stringify(quota));
      }
      // Unknown account scopes are conservatively pooled by host+BB provider.
      // Known providerKey hashes also exclude shared pools across providers.
      const selection=candidates.find(c=>!this.isBlocked(c.provider,owner.hostId,c.model));
      const reason=this.limit(s,owner)??s.blocked??(owner.taskId===null?"No task is bound to this session":!selection?"No independent approved backup provider remains (shared quota, empty pool or unavailable catalog)":null);
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
  async notice(owner:Pick<ResourceOwner,"projectId"|"team">,reason:string):Promise<boolean>{return this.serial(async()=>{const s=this.load(owner);s.notices??=[];const key=digest(reason.replace(/:\s*\d+\/\d+/g,":limit"));if(s.notices.includes(key))return false;s.notices.push(key);this.save(owner,s);return true;});}
  async bindSwitch(owner:Pick<ResourceOwner,"projectId"|"team">,oldThreadId:string,newThreadId:string){
    await this.serial(async()=>{const s=this.load(owner);for(const f of Object.values(s.fallbacks))if(f.threadId===oldThreadId&&f.stage!=="complete"){f.stage="switching";f.newThreadId=newThreadId;delete s.holds[taskKey(f.taskId,f.role)];}this.save(owner,s);});
  }
  async cancelled(threadId:string,id:string){const owner=await this.resolve(threadId);if(!owner)return;await this.serial(async()=>{const s=this.load(owner),t=s.threads[threadId];const a=t&&this.attempt(s,t);if(a?.outcome==="reserved"&&a.queuedIds.includes(id)){a.queuedIds=a.queuedIds.filter(q=>q!==id);if(!a.queuedIds.length)this.finish(s,t,"cancelled","Queued start cancelled; its reservation remains in conservative accounting",this.now());this.save(owner,s);}});}
  async recovered(owner:Pick<ResourceOwner,"projectId"|"team">,oldThreadId:string,newThreadId:string){
    await this.serial(async()=>{const s=this.load(owner);for(const f of Object.values(s.fallbacks))if(f.threadId===oldThreadId){f.stage="complete";f.newThreadId=newThreadId;delete s.holds[taskKey(f.taskId,f.role)];}this.save(owner,s);});
  }
  async authorizeFallback(owner:Pick<ResourceOwner,"projectId"|"team">,requestId:string){
    await this.serial(async()=>{const s=this.load(owner),f=s.fallbacks[requestId];if(!f||f.stage!=="selected")throw new Error("Fallback is not selected or needs manual recovery");
      const bound=s.threads[f.threadId]?.owner;const reason=this.limit(s,bound)??s.blocked;if(reason)throw new Error(reason);
      f.stage="switching";delete s.holds[taskKey(f.taskId,f.role)];this.save(owner,s);
    });
  }
}

/** Result projection is read from the chosen tracker, never stored in the ledger. */
export function withResourceResults(summary:ResourceSummary,tasks:TeamTask[]):ResourceSummary {
 const closed=tasks.filter(t=>t.status==="done");
 if(summary.epic)summary={...summary,epic:{...summary.epic,unattributedTasks:tasks.filter(t=>["todo","in-progress","review"].includes(t.status)&&t.id!==summary.epic!.id&&t.parentId!==summary.epic!.id).map(t=>({id:t.id,title:t.title}))}};
 return {...summary,results:{accepted:closed.length,review:tasks.filter(t=>t.status==="review").length,reports:tasks.filter(t=>t.review?.submission).length,recent:closed.slice(-20).map(t=>({id:t.id,title:t.title,result:t.review?.submission?.result??t.result??null,checks:(t.review?.submission?.checks??[]).map(c=>({what:c.what,result:c.result??null,notApplicable:c.notApplicable??null})),acceptanceReason:t.review?.decisions.at(-1)?.reason??null}))}};
}
