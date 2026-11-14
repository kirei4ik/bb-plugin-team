import {useEffect,useRef,useState} from "react";
import {useRpc,useBbNavigate} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "./server";
import type {ExecutionFallbackSelection} from "./execution-policy";
import {ExecutionModelPicker,type ExecutionModel} from "./execution-picker";
import {RECOVERY_COPY,type RecoveryView} from "./recovery-view";
import type {Language} from "./snapshot";

export function RoleModelRecovery({projectId,team,role,threadId,language,onChanged}:{projectId:string;team:string;role:string;threadId:string|null;language:Language;onChanged:()=>Promise<void>}){
 const rpc=useRpc<typeof rpcContract>(),navigate=useBbNavigate(),ru=language==="ru";
 const [profile,setProfile]=useState<{revision:string}|null>(null);
 const [open,setOpen]=useState(false),[base,setBase]=useState<RecoveryView|null>(null),[checked,setChecked]=useState<RecoveryView|null>(null);
 const [recover,setRecover]=useState(false);
 const [model,setModel]=useState<ExecutionModel|undefined>(),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const [receipt,setReceipt]=useState<{threadId:string;started:boolean;configuredOnly?:boolean}|null>(null);const inFlight=useRef(false);
 const futureOnly=!!base?.blockers.some(b=>b==="task_finished"||b==="no_task");
 const selected=():ExecutionFallbackSelection|undefined=>model?.providerId&&model.model?{provider:model.providerId,model:model.model,...(model.reasoningLevel?{reasoningLevel:model.reasoningLevel}:{}),...(model.serviceTier?{serviceTier:model.serviceTier}:{})}:undefined;
 useEffect(()=>{if(!open||receipt)return;let alive=true;setBase(null);setChecked(null);setApproved(false);setError(null);
  void Promise.all([rpc.call("roleRecovery",{projectId,team,role}),rpc.call("rolePolicy",{projectId,team,role})]).then(([v,p])=>{if(alive){setBase(v);setProfile({revision:p.revision});if(v.actual)setModel({providerId:v.actual.provider,model:v.actual.model,...(v.actual.reasoningLevel?{reasoningLevel:v.actual.reasoningLevel}:{}),...(v.actual.serviceTier?{serviceTier:v.actual.serviceTier}:{})});}},()=>{if(alive)setError(RECOVERY_COPY[language].state_unavailable);});return()=>{alive=false;};
 },[rpc,projectId,team,role,threadId,open,receipt]);
 const check=async()=>{const selection=selected();if(!selection||inFlight.current)return;inFlight.current=true;setBusy(true);setError(null);setChecked(null);
  try{setChecked(await rpc.call("roleRecovery",{projectId,team,role,selection}));}catch{setError(RECOVERY_COPY[language].state_unavailable);}finally{inFlight.current=false;setBusy(false);}
 };
 const saveFuture=async()=>{const selection=selected();if(!selection||!profile||!approved||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{await rpc.call("rolePolicy",{projectId,team,role,expectedRevision:profile.revision,primary:selection,futureOnly:true,...(base?.threadId?{expectedThreadId:base.threadId}:{})});setReceipt({threadId:base?.threadId??threadId??"",started:false,configuredOnly:true});await onChanged();}
  catch{setError(ru?"Профиль изменился или сохранение не подтверждено. Откройте форму заново; текущий сотрудник не перезапускался.":"Profile changed or saving was not confirmed. Reopen the form; the current employee was not restarted.");}
  finally{inFlight.current=false;setBusy(false);}
 };
 const apply=async()=>{const selection=selected();if(!selection||!checked?.threadId||checked.blockers.some(b=>!recover||b!=="checkpoint_missing"&&b!=="checkpoint_stale")||!approved||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError(null);
  try{const result=await rpc.call("roleControl",{projectId,team,role,action:"switch",expectedThreadId:checked.threadId,selection,approveSelection:true,recoverFromWorkspace:recover,expectedRecoveryRevision:checked.revision});if(!result.threadId)throw new Error("missing new session");setReceipt({threadId:result.threadId,started:false});await onChanged();}
  catch{setChecked(null);setApproved(false);setError(ru?"Состояние изменилось или перенос не подтверждён. Повторный агент не запускается. Обновите проверку и откройте сотрудника, если переключение уже началось.":"State changed or handoff was not confirmed. No duplicate agent is started. Check again and inspect the employee if a switch began.");}
  finally{inFlight.current=false;setBusy(false);}
 };
 const start=async()=>{if(!receipt||inFlight.current)return;inFlight.current=true;setBusy(true);setError(null);
  try{await rpc.call("roleControl",{projectId,team,role,action:"resume",expectedThreadId:receipt.threadId});setReceipt({...receipt,started:true});await onChanged();}
  catch{setError(ru?"Продолжение не подтверждено. Проверьте сотрудника; повторная отправка автоматически не выполняется.":"Continuation was not confirmed. Inspect the employee; no automatic resend.");}
  finally{inFlight.current=false;setBusy(false);}
 };
 if(!open)return <button className="self-start rounded-md border border-border px-3 py-2" type="button" onClick={()=>setOpen(true)}>{ru?"Сменить провайдера или модель":"Change provider or model"}</button>;
 return <section aria-label={ru?"Смена провайдера и модели":"Change provider and model"} className="flex flex-col gap-3 rounded border border-border p-3 text-xs">
  <strong>{ru?"Продолжить работу на другой модели":"Continue work on another model"}</strong>
  {receipt?<>
   <p>{receipt.configuredOnly?(ru?"Модель сохранена для следующих задач. Текущая сессия не перезапускалась.":"Model saved for future tasks. The current session was not restarted."):receipt.started?(ru?"Продолжение запрошено. Следите за состоянием сотрудника.":"Continuation requested. Follow the employee status."):(ru?"Работа перенесена. Задача и рабочая папка сохранены; новая сессия пока на паузе.":"Work transferred. Task and workspace retained; the new session is paused.")}</p>
   {!receipt.configuredOnly&&!receipt.started&&<button className="self-start rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy} onClick={()=>void start()}>{ru?"Продолжить работу на выбранной модели":"Continue work on selected model"}</button>}
   <button onClick={()=>navigate.toThread(receipt.threadId)}>{ru?"Открыть сотрудника":"Open employee"}</button>
  </>:<>
   {!base&&<p>{ru?"Проверяем сохранённую работу…":"Reading saved work…"}</p>}
   {base&&<>
    <p>{ru?"Задача":"Task"}: {base.taskTitle??(ru?"не назначена":"not assigned")}</p>
    {base.actual&&<p>{ru?"Сейчас":"Current"}: {base.actual.provider} · {base.actual.model}</p>}
    <strong>{ru?"1. Выберите провайдера и модель":"1. Choose provider and model"}</strong>
    {base.environmentId&&<ExecutionModelPicker value={model} onChange={v=>{setModel(v);setChecked(null);setApproved(false);setError(null);}} routing={{status:"ready",routing:{kind:"environment",environmentId:base.environmentId},retry:()=>{}}} defaultLabel={ru?"Не выбрана":"Not selected"} selectLabel={ru?"Выбрать модель":"Select model"} useDefaultLabel={ru?"Сбросить выбор":"Clear selection"} language={language} disabled={busy}/>}
    <p>{futureOnly?(ru?"Сейчас нет незавершённой задачи для передачи. Выбранная модель станет основной для следующих задач; текущая сессия не перезапускается.":"No unfinished task needs handoff. This selection becomes the primary for future tasks; the current session is not restarted."):(ru?"Выбор действует для текущей задачи. Основной профиль и автоматические резервы не меняются.":"Selection applies to the current task. Primary profile and automatic backups stay unchanged.")}</p>
    {futureOnly?<>
     <label><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>{ru?"Разрешаю использовать эту модель для следующих задач сотрудника":"I authorize this model for the employee’s future tasks"}</label>
     <button className="self-start rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||!selected()||!approved||!profile} onClick={()=>void saveFuture()}>{ru?"Сохранить модель для следующих задач":"Save model for future tasks"}</button>
    </>:<>
    <button className="self-start rounded-md border border-border px-3 py-2 disabled:opacity-50" disabled={busy||!selected()} onClick={()=>void check()}>{ru?"2. Проверить возможность передачи":"2. Check handoff readiness"}</button>
    {(checked??base).blockers.some(b=>b==="checkpoint_missing"||b==="checkpoint_stale")&&<label><input type="checkbox" checked={recover} onChange={e=>{setRecover(e.target.checked);setApproved(false);}}/>{ru?"Восстановить работу из задачи и файлов вместо готового checkpoint":"Recover work from task and files instead of a ready checkpoint"}</label>}
    {recover&&<p>{ru?"Прогресс старой модели не подтверждён. Новая сначала проверит существующие файлы и задачу, сохранит состояние и только затем продолжит. Неизвестные внешние действия потребуют вашего решения.":"Previous progress is unconfirmed. The new model first inspects task and files, saves state, then continues. Unknown external effects require your decision."}</p>}
    {(checked??base).blockers.some(b=>!recover||b!=="checkpoint_missing"&&b!=="checkpoint_stale")&&<div role="status"><strong>{ru?"Передача пока недоступна":"Handoff is not ready"}</strong><ul>{(checked??base).blockers.filter(b=>!recover||b!=="checkpoint_missing"&&b!=="checkpoint_stale").map(b=><li key={b}>{RECOVERY_COPY[language][b]}</li>)}</ul>{base.threadId&&<button onClick={()=>navigate.toThread(base.threadId!)}>{ru?"Открыть сотрудника и очередь":"Open employee and queue"}</button>}</div>}
    {checked&&!checked.blockers.some(b=>!recover||b!=="checkpoint_missing"&&b!=="checkpoint_stale")&&<>
     <p>{recover?(ru?"Будет создана точка восстановления с явно неизвестным прогрессом. Текущая рабочая папка сохранится.":"A recovery baseline with explicitly unknown progress will be saved. The current workspace is retained."):(ru?"Сохранённое состояние проверено. Перенос сохранит задачу и окружение; перед переключением проверка повторится.":"Saved state verified. Task and environment will be retained; checks run again before switching.")}</p>
     <p>{checked.quota==="unknown"?(ru?"Каталог модели доступен. Её текущий остаток и стоимость не подтверждены этой формой.":"The model catalog is available. Remaining quota and cost are not verified by this form."):(ru?"На момент проверки квота доступна. Это не резерв мощности на всю задачу.":"Quota is available at check time; capacity is not reserved for the whole task.")}</p>
     <label><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>{ru?"Разрешаю использовать выбранного провайдера и модель для этой задачи на условиях моего аккаунта":"I authorize this provider and model for this task under my account terms"}</label>
     <button className="self-start rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy||!approved} onClick={()=>void apply()}>{ru?"3. Перенести работу на выбранную модель":"3. Transfer work to selected model"}</button>
    </>}
    </>}
   </>}
  </>}
  {error&&<p role="alert">{error}</p>}
  <button disabled={busy} onClick={()=>{setOpen(false);setReceipt(null);setChecked(null);setApproved(false);}}>{ru?"Закрыть":"Close"}</button>
 </section>;
}
