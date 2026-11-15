import {useEffect,useState} from "react";
import {useRpc,useRealtime} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "./server";
import type {Language} from "./snapshot";
import type {DeferredContinuation} from "./deferred-continuation";

export function DeferredControls({projectId,team,role,threadId,language,onChanged,resetAtMs,paused}:{projectId:string;team:string;role:string;threadId:string;language:Language;onChanged:()=>Promise<void>;resetAtMs?:number|null;paused?:boolean}){
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
 const [resumePaused,setResumePaused]=useState(false);
 const [record,setRecord]=useState<DeferredContinuation|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[time,setTime]=useState("");
 useEffect(()=>{let alive=true;setRecord(null);setResumePaused(false);void rpc.call("deferredContinuation",{projectId,team,role,action:"status"}).then(v=>{if(alive)setRecord(v.record);},()=>{});return()=>{alive=false;};},[rpc,projectId,team,role,threadId]);
 useRealtime("team-changed",()=>{void rpc.call("deferredContinuation",{projectId,team,role,action:"status"}).then(v=>setRecord(v.record),()=>{});});
 const apply=async(action:"schedule"|"cancel"|"check",sendAt?:number)=>{
  setBusy(true);setError(null);
  try{const v=await rpc.call("deferredContinuation",{projectId,team,role,expectedThreadId:threadId,action,...(sendAt!==undefined?{sendAt}:{}),...(action==="schedule"&&paused?{resumePaused}:{})});setRecord(v.record);setResumePaused(false);await onChanged();}
  catch(e){setError((ru?"Продолжение не подтверждено. Проверьте очередь, ручную паузу и бюджет Team. ":"Continuation not confirmed. Check queued work, manual pause and Team budget. ")+(e instanceof Error?e.message:""));}finally{setBusy(false);}
 };
 return <section aria-label={ru?"Продолжить позже":"Continue later"} className="flex flex-col gap-2 rounded border border-border p-2">
  <strong>{ru?"Продолжить позже":"Continue later"}</strong>
  {record&&record.stage!=="released"?<>
   <p>{ru?"Назначено":"Scheduled"}: {new Date(record.sendAt).toLocaleString()} · {record.stage==="scheduled"?(ru?"ожидает в очереди BB":"waiting in BB queue"):(ru?"нужно решение":"needs a decision")}</p>
   {record.reason&&<p role="alert">{ru?"Автопродолжение остановлено: условия изменились или проверка не пройдена. Откройте очередь треда; повторный запуск не создаётся.":"Continuation stopped: conditions changed or a check failed. Inspect the thread queue; no duplicate retry is created."}<br/>{record.reason}</p>}
   <button disabled={busy||!record.queuedMessageId} onClick={()=>void apply("check")}>{ru?"Проверить условия и продолжить в назначенное время":"Recheck conditions and continue at scheduled time"}</button>
   <button disabled={busy} onClick={()=>void apply("cancel")}>{ru?"Отменить и оставить на паузе":"Cancel and leave paused"}</button>
  </>:<>
   <p>{ru?"Переносит ожидающее сообщение или повторяет упавший ход. В назначенное время BB снова проверит квоту и ограничения. Это может запустить модель. Пустой сотрудник без поручения не запускается.":"Defers queued work or retries a failed turn. BB rechecks quota and limits at the chosen time. This may start a model. Employees without work are not started."}</p>
   <p>{ru?"Свежий остаток автоматически проверяется для Pi / Ollama Cloud. Для других провайдеров учитываются известные запреты BB; неизвестную квоту подтвердить нельзя — может потребоваться ручное решение.":"Fresh balance checks support Pi / Ollama Cloud. Other providers use known BB exclusions; unknown capacity may still need a manual decision."}</p>
   {paused&&<label><input type="checkbox" checked={resumePaused} onChange={e=>setResumePaused(e.target.checked)}/>{ru?"Заменить ручную паузу сотрудника ожиданием выбранного времени. Командная пауза сохранится.":"Replace the employee pause with waiting until the chosen time. Team pause stays in effect."}</label>}
   <div className="flex flex-wrap gap-2">
    <button disabled={busy||paused&&!resumePaused} onClick={()=>void apply("schedule",Date.now()+30*60_000)}>{ru?"Через 30 минут":"In 30 minutes"}</button>
    <button disabled={busy||paused&&!resumePaused} onClick={()=>void apply("schedule",Date.now()+2*3600_000)}>{ru?"Через 2 часа":"In 2 hours"}</button>
    {resetAtMs&&resetAtMs>Date.now()&&<button disabled={busy||paused&&!resumePaused} onClick={()=>void apply("schedule",resetAtMs+60_000)}>{ru?"После сброса квоты":"After quota reset"}</button>}
   </div>
   <label>{ru?"Другое время (местное)":"Other time (local)"}<input type="datetime-local" value={time} onChange={e=>setTime(e.target.value)}/></label>
   <button disabled={busy||paused&&!resumePaused||!Number.isFinite(Date.parse(time))} onClick={()=>void apply("schedule",Date.parse(time))}>{ru?"Назначить продолжение":"Schedule continuation"}</button>
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
