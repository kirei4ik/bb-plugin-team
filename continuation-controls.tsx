import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Language } from "./snapshot";
import type { ExecutionFallbackSelection } from "./execution-policy";
import { exhaustedOllama, type OllamaUsage } from "./ollama-usage";

export function OllamaQuotaCard({projectId,team,language}:{projectId:string;team:string;language:Language}) {
  const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
  const [usage,setUsage]=useState<OllamaUsage|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  const load=async(refresh=false)=>{setBusy(true);setError(false);try{setUsage(await rpc.call("ollamaUsage",{projectId,team,refresh}));}catch{setError(true);}finally{setBusy(false);}};
  useEffect(()=>{let alive=true;void rpc.call("ollamaUsage",{projectId,team}).then(v=>{if(alive)setUsage(v);},()=>{if(alive)setError(true);});return()=>{alive=false;};},[rpc,projectId,team]);
  return <section aria-label="Ollama Cloud" className="rounded border border-border p-2 text-xs">
    <strong>Ollama Cloud · {ru?"хост проекта":"project host"}</strong>
    {usage?.status!=="ready"&&<p>{ru?"Свежие данные лимитов недоступны. Это не означает, что квота свободна.":"Fresh quota data unavailable; this does not mean capacity is available."}</p>}
    {usage?.reason&&<p>{({auth_missing:ru?"Подключите аккаунт Ollama Cloud в Pi.":"Connect your Ollama Cloud account in Pi.",auth_unsupported:ru?"Способ авторизации не поддержан. Проверьте /ollama-cloud-usage в Pi.":"Unsupported authentication source; check /ollama-cloud-usage in Pi.",http_error:ru?"Сервис отклонил проверку; проверьте /ollama-cloud-usage в Pi.":"Service rejected the check; inspect /ollama-cloud-usage in Pi.",transport_error:ru?"Связь с сервисом недоступна. Повторите проверку позже.":"Service is unreachable; refresh later.",invalid_response:ru?"Формат лимитов неизвестен; автоматическое решение по нему не принимается.":"Unknown quota format; no automatic capacity decision.",host_unavailable:ru?"Хост проверки недоступен; восстановите подключение.":"Quota host unavailable; reconnect the host."})[usage.reason]}</p>}
    {usage?.windows.map(w=><p key={w.name}>{({plan:ru?"План":"Plan",session:ru?"Сессия":"Session",weekly:ru?"Неделя":"Week",monthly:ru?"Месяц":"Month"})[w.name]}: {ru?"осталось":"remaining"} {Math.round(w.remainingPercent*10)/10}%{w.resetsAtMs?` · ${ru?"сброс":"reset"} ${new Date(w.resetsAtMs).toLocaleString()}`:""}</p>)}
    {usage?.observedAtMs&&<p>{ru?"Последние успешные данные":"Last successful data"}: {new Date(usage.observedAtMs).toLocaleString()}</p>}
    {usage&&<p>{ru?"Проверено":"Checked"}: {new Date(usage.checkedAtMs).toLocaleString()}</p>}
    {usage&&exhaustedOllama(usage)&&<p role="alert">{ru?"Новые запуски Ollama удерживаются. После сброса обновите данные и нажмите «Продолжить очередь» в карточке сотрудника либо выберите независимую утверждённую модель.":"New Ollama starts are held. Refresh after reset, then continue queued work in the employee card, or choose an independent approved model."}</p>}
    <p>{ru?"Общий лимит аккаунта для всех моделей Ollama. Проверка не вызывает модель и не списывает токены генерации.":"All Ollama models share the account quota. Checking makes no model call."}</p>
    {error&&<p role="alert">{ru?"Не удалось прочитать лимиты":"Could not read quota"}</p>}
    <button disabled={busy} onClick={()=>void load(true)}>{ru?"Обновить лимиты Ollama":"Refresh Ollama quota"}</button>
  </section>;
}

export function RoleContinuationControls({projectId,team,role,threadId,language,onChanged}:{projectId:string;team:string;role:string;threadId:string|null;language:Language;onChanged:()=>Promise<void>}) {
  const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
  const [state,setState]=useState<{paused:boolean;threadId:string|null;fallbacks:ExecutionFallbackSelection[];actual?:ExecutionFallbackSelection|null}|null>(null);
  const [selection,setSelection]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;setState(null);void rpc.call("roleControl",{projectId,team,role,action:"status"}).then(v=>{if(alive)setState(v);},()=>{});return()=>{alive=false;};},[rpc,projectId,team,role,threadId]);
  const act=async(action:"pause"|"resume"|"switch")=>{
    if(!state?.threadId||busy)return;setBusy(true);setError(null);
    try{setState(await rpc.call("roleControl",{projectId,team,role,action,expectedThreadId:state.threadId,...(action==="switch"&&selection!==""?{selection:state.fallbacks[Number(selection)]}: {})}));await onChanged();}
    catch(e){setError((e instanceof Error?e.message:String(e)).split("\n")[0]!.slice(0,500));try{setState(await rpc.call("roleControl",{projectId,team,role,action:"status"}));}catch{/* Keep the last known state; never retry a switch. */}}finally{setBusy(false);}
  };
  if(!state?.threadId)return null;
  return <section aria-label={ru?"Продолжение работы":"Continue work"} className="flex flex-col gap-2 border-t border-border pt-2 text-xs">
    {state.actual&&<p>{ru?"Текущая модель сессии":"Current session model"}: {state.actual.provider} · {state.actual.model}</p>}
    <strong>{state.paused?(ru?"Сотрудник на паузе":"Employee paused"):(ru?"Новые ходы разрешены":"New turns enabled")}</strong>
    <button disabled={busy} onClick={()=>void act(state.paused?"resume":"pause")}>{state.paused?(ru?"Продолжить сотрудника":"Resume employee"):(ru?"Пауза сотрудника":"Pause employee")}</button>
    {!state.paused&&<button disabled={busy} onClick={()=>void act("resume")}>{ru?"Продолжить очередь":"Check queued work and continue"}</button>}
    <p>{ru?"Продолжение очереди может запустить модель и расходовать её лимит.":"Continuing queued work may start a model turn and consume usage."}</p>
    <p>{ru?"Пауза удерживает следующие ходы, включая сообщения человека. Текущая операция завершается; кнопка Send-now в BB может обойти ограничение.":"Pause holds future turns, including human messages. Current work finishes; BB Send-now can bypass the hold."}</p>
    {state.fallbacks.length>0?<>
      <label>{ru?"Продолжить на резервной модели":"Continue on backup model"}<select value={selection} onChange={e=>setSelection(e.target.value)}><option value="">{ru?"Выберите утверждённую модель":"Choose an approved model"}</option>{state.fallbacks.map((f,i)=><option key={`${f.provider}:${f.model}`} value={i}>{f.provider} · {f.model}</option>)}</select></label>
      <button disabled={busy||selection===""} onClick={()=>void act("switch")}>{ru?"Подготовить передачу на выбранную модель":"Prepare handoff to selected model"}</button>
      <p>{ru?"Нужны сохранённое состояние и завершённые операции. Задача и окружение сохраняются. Новая сессия остаётся на паузе до вашего продолжения. Если условия не выполнены, появится причина; повторный агент не запускается.":"Needs saved state and finished operations. Task and environment are retained; the new session stays paused until resumed. Unsafe conditions produce an error, without a duplicate agent."}</p>
    </>:<p>{ru?"Резервные модели не назначены. Задайте их в настройках моделей сотрудника или решите, ждать ли восстановления лимита.":"No approved backups. Configure employee models or decide to wait for quota reset."}</p>}
    {error&&<><p role="alert">{ru?(/active operation/.test(error)?"Дождитесь завершения текущей операции. Новые ходы уже на паузе.":/checkpoint|Checkpoint/.test(error)?"Нужно актуальное сохранённое состояние задачи. Если квота исчерпана, требуется ручная проверка или ожидание сброса.":/queue|queued/.test(error)?"В очереди есть сообщения. Проверьте их перед передачей; автоматического удаления нет.":/resource limit/.test(error)?"Сначала разрешите ресурсную блокировку в разделе ресурсов.":"Передача требует вашего решения. Сотрудник не перезапускается автоматически."):"Handoff needs your decision. The employee will not restart automatically."}</p><details><summary>{ru?"Техническая причина":"Technical cause"}</summary>{error}</details></>}
  </section>;
}
