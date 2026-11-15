import {TeamRecoverySummary} from "./team-recovery-summary";
import {OllamaQuotaCard} from "./continuation-controls";
import {isOllamaCloud} from "./ollama-usage";
import {useEffect,useState} from "react";
import {useRpc,useBbNavigate} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "./server";
import type {ResourceSummary,ResourcePolicy} from "./resource-control";
import type {TeamSnapshot,Language,TaskId} from "./snapshot";

function stopLabel(reason:string,ru:boolean):string {
 const task=reason.match(/Task attempt limit reached \(task:([^:]+): (\d+)\/(\d+)\)/);
 if(task)return ru?`Задача ${task[1]} достигла лимита: ${task[2]} из ${task[3]}. Нужно ваше решение.`:`Task ${task[1]} reached its limit: ${task[2]} of ${task[3]}. Your decision is needed.`;
 if(reason.startsWith("Team start limit"))return ru?"Исчерпан общий лимит запусков команды. Нужно ваше решение.":"Team start limit reached. Your decision is needed.";
 return ru?"Новые ходы удерживаются. Откройте причину и выберите дальнейший подход.":"New turns are held. Inspect the cause and decide how to continue.";
}
/** Event-backed status; opening it calls neither a model nor an observer thread. */
export function ResourcePanel({snapshot,language,onChanged,onSelectRole}:{snapshot:TeamSnapshot;language:Language;onChanged:()=>Promise<void>;onSelectRole?:(role:string)=>void}){
 const rpc=useRpc<typeof rpcContract>(),navigate=useBbNavigate(),ru=language==="ru";
 const state=snapshot.resources;
 const [limits,setLimits]=useState({taskAttempts:"8",coordinationAttempts:"40",teamStarts:"100",tokens:"",minutes:""});
 const [reason,setReason]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const policyKey=JSON.stringify(state?.policy);
 useEffect(()=>{if(state)setLimits({taskAttempts:String(state.policy.taskAttempts),coordinationAttempts:String(state.policy.coordinationAttempts??state.policy.taskAttempts),teamStarts:String(state.policy.teamStarts),tokens:state.policy.tokens===null?"":String(state.policy.tokens),minutes:state.policy.minutes===null?"":String(state.policy.minutes)});},[policyKey]);
 if(!state)return null;
 const call=async(policy?:ResourcePolicy,taskId?:TaskId,role?:string)=>{
  if(!reason.trim()){setError(ru?"Укажите конкретное решение/изменение подхода":"State the concrete decision or changed approach");return;}
  setBusy(true);setError(null);
  try{await rpc.call("resources",{projectId:snapshot.projectId,team:snapshot.team,reason:reason.trim(),...(policy?{policy}:{}),...(taskId!==undefined?{taskId}:{}),...(role?{role}:{})});setReason("");await onChanged();}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const save=()=>{
  const value=(key:keyof typeof limits)=>limits[key]===""?null:Number(limits[key]);
  const coordinationAttempts=value("coordinationAttempts"),taskAttempts=value("taskAttempts"),teamStarts=value("teamStarts"),tokens=value("tokens"),minutes=value("minutes");
  if(coordinationAttempts===null||taskAttempts===null||teamStarts===null||[coordinationAttempts,taskAttempts,teamStarts,tokens,minutes].some(n=>n!==null&&(!Number.isSafeInteger(n)||n<=0))){setError(ru?"Лимиты — положительные целые числа":"Limits must be positive integers");return;}
  void call({coordinationAttempts,taskAttempts,teamStarts,tokens,minutes});
 };
 const outcome:Record<string,string>=ru?{reserved:"зарезервировано",running:"выполняется",completed:"завершено",failed:"ошибка",interrupted:"прервано",unknown:"исход неизвестен",cancelled:"отменено"}:{};
 const tasks=snapshot.roles.flatMap(r=>r.tasks);
 const accepted=state.results?.accepted??tasks.filter(t=>t.status==="done").length,review=state.results?.review??tasks.filter(t=>t.status==="review").length;
 return <section aria-label={ru?"Контроль ресурсов команды":"Team resource control"} className="flex flex-col gap-2">
  <TeamRecoverySummary snapshot={snapshot} language={language} onChanged={onChanged} onSelectRole={onSelectRole}/>
  <details className="rounded-md border border-border p-2 text-xs">
  <summary>{ru?"Лимиты, квоты и история":"Limits, quotas and history"}</summary>
  <div className="mt-2 flex flex-col gap-2">
  <p>{ru?"Запуски команды":"Team starts"}: {state.starts}/{state.policy.teamStarts} · {ru?"осталось":"remaining"} {state.remainingStarts}</p>
   {snapshot.roles.some(r=>isOllamaCloud(r.threads[0]?.provider??r.provider??"",r.threads[0]?.model??r.model))&&<OllamaQuotaCard projectId={snapshot.projectId} team={snapshot.team} language={language}/>}
   {state.blocked&&<><p role="alert">{stopLabel(state.blocked,ru)}</p><details><summary>{ru?"Техническая причина":"Technical cause"}</summary>{state.blocked}</details></>}
   <details><summary>{ru?"Что учитывается":"Accounting details"}</summary><p>{ru?"Учёт с":"Accounting since"} {new Date(state.sinceMs).toLocaleString()} · {ru?"Допуски запусков, включая зарезервированные; это не число внутренних запросов провайдера.":"Start admissions include reservations; these are not the provider's internal API calls."}</p>
   <p>{ru?"Накопленные сообщённые токены":"Reported cumulative tokens"}: {state.reportedTokens===null?(ru?"недоступны":"unavailable"):`${state.reportedTokens} (${ru?"неполный учёт":"partial coverage"})`}. {ru?"Контекст треда сюда не входит. Денежный расход неизвестен; жёсткий денежный предел не гарантируется.":"Context-window size is excluded. Monetary cost is unknown; no hard spending guarantee."}</p>
   <p>{ru?`В текущем снимке: принято ${accepted}, на ревью ${review}. Отчёты и проверки — в задачах ниже.`:`Current snapshot: ${accepted} accepted, ${review} in review. Task reports and checks are below.`}</p>
   <p>{ru?"Результаты и основания читаются из трекера; перечисленные проверки — заявления исполнителя, а не автоматическое подтверждение качества.":"Results and grounds come from the tracker; listed checks are the executor’s claims, not automatic quality verification."}</p>
   </details>
   <details><summary>{ru?"Учёт по задачам":"Per-task accounting"}</summary>{state.taskCounts.map(t=><p key={`${t.taskId}:${t.role}`}>#{t.taskId??"—"} · {t.role} · {ru?"допусков":"admissions"} {t.starts} · {ru?"возвратов":"returns"} {t.returns}{t.taskId!==null?` · ${t.starts+t.returns}/${state.taskLimits?.[`task:${t.taskId}`]??(snapshot.roles.find(r=>r.name===t.role)?.lead?(state.policy.coordinationAttempts??state.policy.taskAttempts):state.policy.taskAttempts)}`:""}</p>)}
   </details>
   <details><summary>{ru?"Завершённые задачи и основания приёмки":"Completed tasks and acceptance grounds"}</summary>{state.results?.recent.map(task=><div key={task.id} className="rounded border border-border p-2">#{task.id} {task.title}: {task.result??(ru?"результат не указан":"no result recorded")}<br/>{ru?"Основание приёмки":"Acceptance grounds"}: {task.acceptanceReason??"—"}<ul>{task.checks.map((check,i)=><li key={i}>{check.what}: {check.result??`N/A: ${check.notApplicable}`}</li>)}</ul></div>)}
   </details>

   <p>{ru?"Активная работа не прерывается. Замена модели, треда или карточки не сбрасывает счётчики. Send-now в BB — явное ручное исключение, которое плагин не может запретить.":"Active work is not interrupted. Model/thread/card replacement does not reset counters. BB Send-now is an explicit manual override that plugins cannot veto."}</p>
   <div className="flex flex-wrap gap-2">{(["taskAttempts","coordinationAttempts","teamStarts","tokens","minutes"] as const).map(key=><label key={key} className="flex flex-col gap-1">{({coordinationAttempts:ru?"Ходов координации руководителя":"Lead coordination turns",taskAttempts:ru?"Попыток на задачу (старты + возвраты)":"Task attempts (starts + returns)",teamStarts:ru?"Запусков на команду":"Team starts",tokens:ru?"Сообщённых токенов (пусто — без предела)":"Reported tokens (blank = no cap)",minutes:ru?"Минут с начала (пусто — без предела)":"Minutes since start (blank = no cap)"})[key]}<input type="number" min={1} value={limits[key]} onChange={e=>setLimits(p=>({...p,[key]:e.target.value}))} className="w-32 rounded border border-border bg-background p-1"/></label>)}</div>
   <label className="flex flex-col gap-1">{ru?"Решение пользователя / конкретное изменение подхода":"Manual decision / concrete changed approach"}<textarea rows={2} maxLength={4000} value={reason} onChange={e=>setReason(e.target.value)} className="rounded border border-border bg-background p-1"/></label>
   {error&&<p role="alert">{error}</p>}
   <button type="button" disabled={busy} onClick={save} className="self-start rounded border border-border px-2 py-1">{ru?"Сохранить лимиты с основанием":"Save limits with grounds"}</button>
   {Object.entries(state.holds).map(([key,why])=>{
    const attempt=[...state.taskCounts].reverse().find(a=>(a.taskId===null?`role:${a.role}`:`task:${a.taskId}`)===key);
    return <div key={key} className="rounded border border-border p-2">{key}: {why}<br/>
     {attempt&&<button type="button" disabled={busy} onClick={()=>void call(undefined,attempt.taskId??undefined,attempt.role)}>{ru?"Разрешить следующий запуск с этим решением":"Allow next start with this decision"}</button>}
    </div>;
   })}
   {state.quotaBlocks.map((q,i)=><p key={i}>{ru?"Исключённый пул квоты":"Excluded quota pool"}: {q.provider} · {q.hostId??"?"} · {q.resetAtMs?new Date(q.resetAtMs).toLocaleString():(ru?"reset неизвестен; нужна проверка":"reset unknown; inspection required")}</p>)}
   {state.fallbacks.map(f=><p key={f.requestId}>{ru?"Замена после квоты":"Quota handoff"} · #{f.taskId??"—"} · {f.stage} · {f.selection?`${f.selection.provider}/${f.selection.model}`:"—"} · {f.reason}{f.newThreadId&&` → ${f.newThreadId}`}</p>)}
   <details><summary>{ru?"Последние 100 допусков запусков":"Last 100 start admissions"}</summary><ul className="flex flex-col gap-1">{state.attempts.map(a=><li key={a.id}>#{a.taskId??"—"} · {a.role} · <button onClick={()=>navigate.toThread(a.threadId)} className="underline">{a.threadId}</button> · {a.provider} / {a.model??(ru?"модель неизвестна":"model unknown")} · {outcome[a.outcome]??a.outcome} · {new Date(a.atMs).toLocaleString()} → {a.endedAtMs?new Date(a.endedAtMs).toLocaleString():"—"} · {a.tokens??"?"} tokens{a.reason&&` · ${a.reason}`}</li>)}</ul></details>
  </div>
 </details>
 </section>;
}
