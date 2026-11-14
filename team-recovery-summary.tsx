import {useState} from "react";
import {useRpc} from "@get-bb/plugin-sdk/app";
import type {rpcContract} from "./server";
import type {Language,TeamSnapshot} from "./snapshot";
import {teamRecoverySummary} from "./recovery-view";

export function TeamRecoverySummary({snapshot,language,onChanged,onSelectRole}:{snapshot:TeamSnapshot;language:Language;onChanged:()=>Promise<void>;onSelectRole?:(role:string)=>void}){
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru",view=teamRecoverySummary(snapshot),budget=snapshot.resources;
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const grant=async()=>{
  if(!view.coordination||!budget||busy)return;setBusy(true);setError(null);
  try{await rpc.call("continueCoordination",{projectId:snapshot.projectId,team:snapshot.team,taskId:view.coordination.task.id,expectedStarts:budget.starts,expectedUsed:view.coordination.used});await onChanged();}
  catch{setError(ru?"Состояние изменилось или продолжение не подтверждено. Обновите команду; дополнительные разрешения автоматически не выдаются.":"State changed or continuation was not confirmed. Refresh; no automatic extra allowance.");}
  finally{setBusy(false);}
 };
 const blocked=!!budget?.blocked;
 const title=snapshot.configError||snapshot.trackerError?(ru?"Нужен доступ к настройкам или задачам":"Configuration or task access is needed"):snapshot.paused?(ru?"Автозапуск команды приостановлен":"Team autostart paused"):view.coordination?(ru?"Руководитель ждёт разрешения продолжить":"Lead needs permission to continue"):blocked?(ru?"Команда ждёт решения по ограничению":"Team needs a limit decision"):view.modelProblem?(ru?"Сотруднику нужна помощь с продолжением":"An employee needs help continuing"):view.active.length?(ru?"Команда работает":"Team is working"):view.current?.status==="review"?(ru?"Результат ждёт проверки":"Result awaits review"):view.current?(ru?"Работа ожидает продолжения":"Work awaits continuation"):(ru?"Команда готова к новой задаче":"Team is ready for a new task");
 return <section aria-label={ru?"Что происходит в команде":"Team work status"} className="flex flex-col gap-2 rounded border border-border p-3 text-sm">
  <strong>{title}</strong>
  {view.active.length>0&&<p>{ru?"Сейчас работают":"Working now"}: {view.active.map(r=>r.title).join(", ")}. {ru?"Их операции не прерываются.":"Their operations are not interrupted."}</p>}
  {view.current&&<p>{ru?"Текущая работа":"Current work"}: {view.current.title}</p>}
  {view.coordination?<>
   <p>{ru?"Достигнут установленный лимит координации. Это ограничение Team, а не остаток квоты модели.":"The coordination allowance is exhausted. This is a Team limit, separate from model quota."}</p>
   <p>{view.current?.status==="review"?(ru?"Следующий шаг: руководителю проверить результат, принять его или вернуть конкретные замечания.":"Next: the lead reviews the result, accepts it or returns specific feedback."):(ru?"Следующий шаг: руководителю разобраться с текущей работой и определить её продолжение.":"Next: the lead inspects current work and determines how to continue.")}</p>
   <button className="self-start rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50" disabled={busy} onClick={()=>void grant()}>{ru?"Разрешить ещё 4 хода руководителю":"Allow 4 more lead turns"}</button>
   <p className="text-xs text-muted-foreground">{ru?"Только для текущей задачи координации. Остальные ограничения сохраняются; нажатие может запустить модель. Завершение задачи за эти ходы не гарантируется.":"Only for this coordination task. Other limits remain; this may start a model. Completion within those turns is not guaranteed."}</p>
  </>:blocked?<p>{ru?"Нужен выбор дальнейшего подхода. Подробности ограничения — ниже; смена модели не снимает лимит Team.":"Decide how to proceed. Limit details are below; changing models does not reset Team limits."}</p>:null}
  {view.modelProblem&&<><p>{ru?"У сотрудника остановилось выполнение. В его карточке можно проверить передачу и выбрать другого провайдера или модель.":"An employee stopped. Open their card to check handoff and choose another provider or model."}</p><button onClick={()=>onSelectRole?.(view.modelProblem!.name)}>{ru?`Разобрать остановку: ${view.modelProblem.title}`:`Inspect stop: ${view.modelProblem.title}`}</button></>}
  {budget?.ollamaUsage?.status==="ready"&&<p className="text-xs">Ollama Cloud: {budget.ollamaUsage.windows.map(w=>`${({session:ru?"сессия":"session",weekly:ru?"неделя":"week",monthly:ru?"месяц":"month",plan:ru?"план":"plan"})[w.name]} — ${Math.round(w.remainingPercent*10)/10}% ${ru?"осталось":"remaining"}`).join(" · ")}</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
