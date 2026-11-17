import {useState} from "react";
import {useRpc} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server/server";
import type {TeamSnapshot,Language} from "../shared/snapshot";

/** Saving this deterministic control neither sends a message nor starts a model. */
export function EpicBudgetControl({snapshot,language,onChanged}:{snapshot:TeamSnapshot;language:Language;onChanged:()=>Promise<void>}){
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru",state=snapshot.resources;
 const [draft,setDraft]=useState<{epicId:string;limit:string;reason:string;expectedActiveEpicId:string|null;expectedRevision:number;expectedUsed:number}|null>(null);
 const [scope,setScope]=useState<{id:string;title:string;description:string|null;criteria:string|null;scopeRevision:string}|null>(null);
 const [approved,setApproved]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
 if(!state)return null;
 const epic=state.epic;
 const choose=(epicId:string)=>{
  setScope(null);setApproved(false);
  const prior=state.epicBudgets?.[epicId];
  setDraft({epicId,limit:String(prior?.limit??20),reason:"",expectedActiveEpicId:epic?.id??null,expectedRevision:prior?.revision??0,expectedUsed:prior?.used??0});
 };
 const loadScope=async()=>{
  if(!draft||busy)return;
  setBusy(true);setError(null);setApproved(false);setScope(null);
  try{setScope(await rpc.call("epicScope",{projectId:snapshot.projectId,team:snapshot.team,epicId:draft.epicId.trim()}));}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const save=async()=>{
  if(!draft||busy||!scope||!approved)return;
  setBusy(true);setError(null);
  try{
   await rpc.call("epicBudget",{projectId:snapshot.projectId,team:snapshot.team,...draft,epicId:scope.id,limit:Number(draft.limit),expectedScopeRevision:scope.scopeRevision});
   setDraft(null);setSaved(true);await onChanged();
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <section aria-label={ru?"Бюджет эпика":"Epic budget"} className="flex flex-col gap-2 rounded border border-border p-3 text-sm">
  <strong>{ru?"Бюджет эпика":"Epic budget"}</strong>
  {epic?<>
   <p>{epic.title??epic.id} ({epic.id}): {epic.used}/{epic.limit} · {ru?"остаток":"remaining"} {epic.remaining}</p>
   {epic.criteria&&<p>{ru?"Критерии":"Criteria"}: {epic.criteria}</p>}
   <p>{ru?"Учёт эпика с":"Epic accounting since"} {new Date(epic.sinceMs).toLocaleString()}</p>
   {epic.blocked&&<p role="alert">{epic.blocked}</p>}
   {!!epic.unattributedTasks?.length&&<div>{ru?"Задачи вне эпика удерживаются":"Tasks outside the epic are held"}: {epic.unattributedTasks.map(t=>`${t.title} (${t.id})`).join(", ")}</div>}
  </>:<p>{ru?"Активный эпик не выбран. Действуют прежние лимиты пакетов.":"No active epic. Existing package limits apply."}</p>}
  <p>{ru?"Капитан, исполнители и помощники расходуют общий лимит ходов. Новая дочерняя задача или сессия его не сбрасывает. Это не денежный лимит и не число запросов внутри хода.":"Lead, executors and helpers share a turn allowance. New child tasks or sessions retain usage. This is not a monetary cap or the number of requests within a turn."}</p>
  {!draft&&<button type="button" onClick={()=>{choose(epic?.id??"");setSaved(false);setError(null);}}>{ru?"Настроить бюджет эпика":"Configure epic budget"}</button>}
  {draft&&<>
   <label>{ru?"ID существующего эпика Beads":"Existing Beads epic ID"}<input disabled={busy} value={draft.epicId} onChange={e=>choose(e.target.value)} maxLength={200}/></label>
   <button disabled={busy||!draft.epicId.trim()} onClick={()=>void loadScope()}>{ru?"Прочитать требования эпика":"Read epic requirements"}</button>
   {scope&&<div className="rounded border border-border p-2">
    <strong>{scope.title}</strong>
    <p className="whitespace-pre-wrap">{ru?"Требования":"Requirements"}: {scope.description??"—"}</p>
    <p className="whitespace-pre-wrap">{ru?"Критерии":"Criteria"}: {scope.criteria??"—"}</p>
    <label><input type="checkbox" checked={approved} disabled={busy} onChange={e=>setApproved(e.target.checked)}/>{ru?"Утверждаю показанные требования и критерии":"Approve these requirements and criteria"}</label>
   </div>}
   <label>{ru?"Общий лимит ходов":"Total turn allowance"}<input type="number" min={1} max={10000} value={draft.limit} onChange={e=>setDraft({...draft,limit:e.target.value})}/></label>
   <label>{ru?"Основание решения":"Decision grounds"}<textarea maxLength={4000} value={draft.reason} onChange={e=>setDraft({...draft,reason:e.target.value})}/></label>
   <p>{ru?"Сохранение не запускает модель. Текущие операции должны завершиться. Расход сохраняется; квоты и ошибки проверяются отдельно. Для продолжения используйте обычное ручное действие после проверки состояния.":"Saving starts no model. Current operations must finish. Usage is retained; quotas and failures remain separate. To continue, inspect the state and use the usual manual action."}</p>
   <button disabled={busy||!scope||!approved||!draft.reason.trim()} onClick={()=>void save()}>{ru?"Сохранить бюджет эпика":"Save epic budget"}</button>
   <button disabled={busy} onClick={()=>setDraft(null)}>{ru?"Отмена":"Cancel"}</button>
  </>}
  {saved&&<p role="status">{ru?"Бюджет эпика сохранён; модель не запускалась.":"Epic budget saved; no model was started."}</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
