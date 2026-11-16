import {useState} from "react";
import {useRpc} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server/server";
import type {SessionRecovery} from "../shared/session-recovery";
import type {Language} from "../shared/snapshot";

export function SessionRecoveryCard({projectId,team,role,language,onChanged}:{projectId:string;team:string;role:string;language:Language;onChanged:()=>Promise<void>}){
  const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
  const [view,setView]=useState<SessionRecovery|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[confirmed,setConfirmed]=useState(false),[candidate,setCandidate]=useState("");
  const read=async()=>{setBusy(true);setError(null);setConfirmed(false);try{setView(await rpc.call("sessionRecovery",{projectId,team,role}));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const act=async(action:SessionRecovery["actions"][number])=>{
    if(!view||busy||!confirmed)return;
    setBusy(true);setError(null);
    try{setView(await rpc.call("sessionRecovery",{projectId,team,role,action,expectedRevision:view.revision,confirmed:true,...(action==="confirm"?{candidateThreadId:candidate}:{})}));await onChanged();}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);setConfirmed(false);}
  };
  const names=ru?{continue:"Продолжить существующую замену",abort:"Отменить замену до переключения",confirm:"Подтвердить выбранную сессию",release:"Повторно проверить исходную очередь"}:{continue:"Continue existing replacement",abort:"Abort before switching",confirm:"Confirm selected session",release:"Recheck the original queue"};
  return <section aria-label={ru?"Восстановление замены":"Replacement recovery"} className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
    <button type="button" disabled={busy} onClick={()=>void read()}>{ru?"Проверить восстановление сессии":"Inspect session recovery"}</button>
    {error&&<p role="alert">{error}</p>}
    {view&&<>
      <p>{view.stage??(ru?"Незавершённой замены нет":"No unfinished replacement")} · {view.delivery??"—"} {view.reasonCode?`· ${view.reasonCode}`:""}</p>
      {view.oldThreadId&&<p>{view.oldThreadId} → {view.newThreadId??"?"}</p>}
      {!view.actions.length&&view.reasonCode&&<p>{ru?"Автоматическое восстановление небезопасно. Проверьте существующие сессии и очередь. Новое задание не отправляется.":"Automatic recovery is unsafe. Inspect existing sessions and the queue. No new input is sent."}</p>}
      {view.candidates.length>0&&<label>{ru?"Подготовленная сессия":"Prepared session"}<select value={candidate} onChange={e=>{setCandidate(e.target.value);setConfirmed(false);}}><option value="">—</option>{view.candidates.map(id=><option key={id} value={id}>{id}</option>)}</select></label>}
      {view.actions.length>0&&<><p>{ru?"Продолжение может запустить разрешённую модель и расходовать ресурсы. Очередь не дублируется; ограничения проверяются повторно.":"Continuation may start the approved model and consume resources. The queue is not duplicated; limits are checked again."}</p>
        <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{ru?"Я проверил состояние и подтверждаю действие":"I inspected the state and confirm the action"}</label>
        {view.actions.map(action=><button key={action} type="button" disabled={busy||!confirmed||action==="confirm"&&!candidate} onClick={()=>void act(action)}>{names[action]}</button>)}
      </>}
    </>}
  </section>;
}
