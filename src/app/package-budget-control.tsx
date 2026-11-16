import {useState} from "react";
import {useRpc} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server/server";
import type {TeamSnapshot,Language,TaskId} from "../shared/snapshot";

/** The draft captures the displayed budget and spend for a checked save. */
export function PackageBudgetControl({snapshot,language,onChanged}:{snapshot:TeamSnapshot;language:Language;onChanged:()=>Promise<void>}){
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru",resources=snapshot.resources;
 const [draft,setDraft]=useState<{taskId:TaskId;limit:string;expectedLimit:number;expectedUsed:number;reason:string}|null>(null);
 const [saved,setSaved]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 if(!resources)return null;
 const packages=snapshot.roles.flatMap(role=>role.tasks.filter(t=>["todo","in-progress","review"].includes(t.status)).map(task=>({task,role})));
 const save=async()=>{
  if(!draft||busy)return;
  const limit=Number(draft.limit);
  if(!Number.isInteger(limit)||limit<1||limit>1000||!draft.reason.trim()){setError(ru?"Укажите лимит от 1 до 1000 и основание изменения":"Enter a limit from 1 to 1000 and grounds for the change");return;}
  setBusy(true);setError(null);
  try{const result=await rpc.call("packageBudget",{projectId:snapshot.projectId,team:snapshot.team,...draft,limit,reason:draft.reason.trim()});setDraft(null);setSaved((ru?"Лимит сохранён. ":"Limit saved. ")+(result.budgetNotice==="sent"?(ru?"Руководителю отправлено уведомление; доставка проверяется обычными ограничениями очереди.":"The lead was notified; normal queue guards still apply."):result.budgetNotice==="unavailable"?(ru?"Уведомление руководителя не доставлено. Напишите ему в чате; сохранённый лимит действует.":"The lead notification was not delivered. Message the lead; the saved limit applies."):result.budgetNotice==="busy"?(ru?"Руководитель занят; его текущая операция не прервана.":"The lead is busy; the current operation continues."):result.budgetNotice==="queued"?(ru?"Сообщения руководителя уже в очереди; повторно не отправляйте их.":"The lead already has queued messages; do not resend them."):""));await onChanged();}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <section aria-label={ru?"Запуски по пакетам работ":"Work package starts"} className="flex flex-col gap-2 rounded border border-border p-3 text-sm">
  <strong>{ru?"Запуски по пакетам работ":"Work package starts"}</strong>
  <p>{ru?"У каждого пакета свой лимит. Общего лимита запусков на проект нет. Один запуск — обработка агентом нового сообщения до ответа или остановки; внутри может быть несколько действий и запросов к модели. Запуски помощников и возвраты на доработку входят в расход пакета.":"Each package has its own allowance, with no project-wide start cap. One start processes a new message until a response or stop; it may include multiple actions and model requests. Helper starts and rework returns count toward the package."}</p>
  {packages.length===0&&<p>{ru?"Открытых пакетов пока нет":"No open work packages"}</p>}
  {packages.map(({task,role})=>{
   const counts=resources.taskCounts.filter(c=>c.taskId===task.id),used=counts.reduce((n,c)=>n+c.starts+c.returns,0);
   const limit=resources.taskLimits?.[`task:${task.id}`]??(role.lead?resources.policy.coordinationAttempts??resources.policy.taskAttempts:resources.policy.taskAttempts);
   return <div key={task.id} className="rounded border border-border p-2">
    <p>#{task.id} · {task.title} · {ru?"использовано":"used"} {used}/{limit}{used>=limit?` · ${ru?"новые запуски ждут решения":"new starts await a decision"}`:""}</p>
    <button type="button" disabled={busy} onClick={()=>{setDraft({taskId:task.id,limit:String(limit),expectedLimit:limit,expectedUsed:used,reason:""});setError(null);}}>{ru?"Изменить лимит пакета":"Change package limit"}: #{task.id}</button>
    {draft?.taskId===task.id&&<div className="flex flex-col gap-2">
     <label>{ru?"Лимит пакета":"Package limit"}<input type="number" min={1} max={1000} value={draft.limit} onChange={e=>setDraft({...draft,limit:e.target.value})}/></label>
     <label>{ru?"Основание изменения лимита":"Grounds for budget change"}<textarea maxLength={4000} value={draft.reason} onChange={e=>setDraft({...draft,reason:e.target.value})}/></label>
     <p>{ru?"Расход сохраняется. Повышение лимита уведомит руководителя и может выпустить сохранённое сообщение из очереди и запустить модель. Квоты, ошибки и незавершённая передача проверяются отдельно.":"Usage is retained. Raising the limit notifies the lead and may release a queued message and start a model. Quotas, failures and unfinished handoffs are checked separately."}</p>
     <button type="button" disabled={busy} onClick={()=>void save()}>{ru?"Сохранить лимит пакета":"Save package limit"}</button>
     <button type="button" disabled={busy} onClick={()=>{setDraft(null);setError(null);}}>{ru?"Отмена":"Cancel"}</button>
    </div>}
   </div>;
  })}
  {saved&&<p role="status">{saved}</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
