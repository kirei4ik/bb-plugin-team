import {EXECUTION_STATUS_LABELS} from "../shared/execution-diagnostic";
import type {Language, SnapshotRole} from "../shared/snapshot";
import {useState} from "react";
import {useRpc} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "../server/server";
import type {ExecutionEvent} from "../shared/execution-event";

export function ExecutionDiagnosticCard({role, language, projectId, team, events=[]}: {role: SnapshotRole; language: Language; projectId:string;team:string;events?:ExecutionEvent[]}) {
  const ru = language === "ru";
  const rpc=useRpc<typeof rpcContract>();
  const [report,setReport]=useState<string|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  const exportReport=async()=>{setBusy(true);setError(false);try{const result=await rpc.call("executionHistory",{projectId,team,role:role.name});setReport(JSON.stringify({version:1,projectId,team,role:role.name,...result},null,2));}catch{setError(true);}finally{setBusy(false);}};
  if (!role.diagnostics?.length && !events.some(event=>event.role===role.name)) return null;
  return <section aria-label={ru ? "Диагностика исполнения" : "Execution diagnostics"} className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
    <strong>{ru ? "Диагностика исполнения" : "Execution diagnostics"}</strong>
    {(role.diagnostics??[]).map(item => <div key={item.taskId} className="rounded border border-border p-2">
      <div>#{item.taskId} · {EXECUTION_STATUS_LABELS[language][item.status]}</div>
      <div>{ru ? "Ответственная роль" : "Responsible role"}: {item.role}</div>
      <div>{ru ? "Источник" : "Source"}: {item.source} · {item.reasonCode}</div>
      <div>{ru ? "Последнее подтверждённое изменение" : "Last confirmed change"}: {item.atMs > 0 ? new Date(item.atMs).toLocaleString(language) : ru ? "время неизвестно" : "time unknown"}</div>
      <div>{ru ? "Сохранённый результат" : "Saved result"}: {item.savedResult === "accepted" ? ru ? "принят в трекере" : "accepted in tracker" : item.savedResult === "submitted" ? ru ? "отчёт передан на проверку; ещё не принят" : "report submitted; not accepted yet" : ru ? "отчёт не подтверждён" : "no confirmed report"}</div>
      {["resource", "decision", "handoff"].includes(item.status) && <p>{ru ? "Автоматическое продолжение удерживается. Проверьте состояние передачи, очередь и доступные действия ниже; неизвестный исход нельзя повторять вслепую." : "Automatic continuation is held. Inspect handoff state, the queue and available controls below; never blindly repeat an unknown outcome."}</p>}
    </div>)}
    <details><summary>{ru?"История исполнения":"Execution history"}</summary>
      {events.filter(event=>event.role===role.name).slice(0,20).map((event,index)=><div key={index}>{new Date(event.timestamp).toLocaleString(language)} · {event.eventType} · {event.previousState??"—"} → {event.nextState} · {event.reasonCode}</div>)}
      <p>{ru?"Техническая история хранится 30 дней, до 2000 событий на команду. Здесь показаны последние события; содержимое запросов и ошибки провайдера в экспорт не включаются.":"Technical history is kept for 30 days, up to 2000 events per team. Recent events are shown here; request content and raw provider errors are excluded from export."}</p>
      <button type="button" disabled={busy} onClick={()=>void exportReport()}>{ru?"Подготовить диагностический отчёт":"Prepare diagnostic report"}</button>
      {error&&<p role="alert">{ru?"Не удалось получить журнал; повторите чтение.":"Could not read history; try reading again."}</p>}
      {report&&<a download="team-diagnostics.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(report)}`}>{ru?"Скачать диагностический отчёт":"Download diagnostic report"}</a>}
    </details>
  </section>;
}
