import {OpenRouterQuotaCard} from "./openrouter-quota-card";
import {DeferredControls} from "./deferred-controls";
import { useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Language } from "./snapshot";
import type { ExecutionFallbackSelection } from "./execution-policy";
import {RoleModelRecovery} from "./role-model-recovery";
import { exhaustedOllama, quotaHeadroom, type OllamaUsage } from "./ollama-usage";

export function OllamaQuotaCard({projectId,team,language}:{projectId:string;team:string;language:Language}) {
  const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
  const [threshold,setThreshold]=useState(10);
  useEffect(()=>{void rpc.call("quotaPolicy",{projectId,team}).then(v=>setThreshold(v.pauseBelowPercent),()=>{});},[rpc,projectId,team]);
  const [usage,setUsage]=useState<OllamaUsage|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  const load=async(refresh=false)=>{setBusy(true);setError(false);try{setUsage(await rpc.call("ollamaUsage",{projectId,team,refresh}));}catch{setError(true);}finally{setBusy(false);}};
  useEffect(()=>{let alive=true;void rpc.call("ollamaUsage",{projectId,team}).then(v=>{if(alive)setUsage(v);},()=>{if(alive)setError(true);});return()=>{alive=false;};},[rpc,projectId,team]);
  useRealtime("team-changed",()=>{void load(false);});
  return <section aria-label="Ollama Cloud" className="rounded border border-border p-2 text-xs">
    <strong>Ollama Cloud · {ru?"хост проекта":"project host"}</strong>
    {usage?.status!=="ready"&&<p>{ru?"Свежие данные лимитов недоступны. Это не означает, что квота свободна.":"Fresh quota data unavailable; this does not mean capacity is available."}</p>}
    {usage?.reason&&<p>{({auth_missing:ru?"Подключите аккаунт Ollama Cloud в Pi.":"Connect your Ollama Cloud account in Pi.",auth_unsupported:ru?"Способ авторизации не поддержан. Проверьте /ollama-cloud-usage в Pi.":"Unsupported authentication source; check /ollama-cloud-usage in Pi.",http_error:ru?"Сервис отклонил проверку; проверьте /ollama-cloud-usage в Pi.":"Service rejected the check; inspect /ollama-cloud-usage in Pi.",transport_error:ru?"Связь с сервисом недоступна. Повторите проверку позже.":"Service is unreachable; refresh later.",invalid_response:ru?"Формат лимитов неизвестен; автоматическое решение по нему не принимается.":"Unknown quota format; no automatic capacity decision.",host_unavailable:ru?"Хост проверки недоступен; восстановите подключение.":"Quota host unavailable; reconnect the host."})[usage.reason]}</p>}
    {usage?.windows.map(w=><p key={w.name}>{({plan:ru?"План":"Plan",session:ru?"Сессия":"Session",weekly:ru?"Неделя":"Week",monthly:ru?"Месяц":"Month"})[w.name]}: {ru?"осталось":"remaining"} {Math.round(w.remainingPercent*10)/10}%{w.resetsAtMs?` · ${ru?"сброс":"reset"} ${new Date(w.resetsAtMs).toLocaleString()}`:""}</p>)}
    {usage?.observedAtMs&&<p>{ru?"Последние успешные данные":"Last successful data"}: {new Date(usage.observedAtMs).toLocaleString()}</p>}
    {usage&&<p>{ru?"Проверено":"Checked"}: {new Date(usage.checkedAtMs).toLocaleString()}</p>}
    {usage&&exhaustedOllama(usage)&&<p role="alert">{ru?"Новые запуски Ollama удерживаются. После сброса обновите данные и нажмите «Продолжить очередь» в карточке сотрудника либо выберите независимую утверждённую модель.":"New Ollama starts are held. Refresh after reset, then continue queued work in the employee card, or choose an independent approved model."}</p>}
    <label>{ru?"Удерживать новые ходы при остатке не выше (%)":"Hold new turns at or below remaining (%)"}<input type="number" min={0} max={50} value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></label>
    <button disabled={busy||!Number.isFinite(threshold)||threshold<0||threshold>50} onClick={()=>{setBusy(true);void rpc.call("quotaPolicy",{projectId,team,policy:{pauseBelowPercent:threshold}}).catch(()=>setError(true)).finally(()=>setBusy(false));}}>{ru?"Сохранить порог":"Save threshold"}</button>
    <p>{ru?"Проверка выполняется перед новыми ходами, с кешем до 3 минут. Активные операции не прерываются. Это запас, а не гарантия: другие проекты тоже расходуют аккаунт.":"Checked before new turns, cached up to 3 minutes. Active operations finish. Headroom is not a guarantee: other projects share this account."}</p>
    <p>{ru?"Общий лимит аккаунта для всех моделей Ollama. Проверка не вызывает модель и не списывает токены генерации.":"All Ollama models share the account quota. Checking makes no model call."}</p>
    {error&&<p role="alert">{ru?"Не удалось прочитать лимиты":"Could not read quota"}</p>}
    <button disabled={busy} onClick={()=>void load(true)}>{ru?"Обновить лимиты Ollama":"Refresh Ollama quota"}</button>
  </section>;
}

export function RoleContinuationControls({projectId,team,role,threadId,language,onChanged}:{projectId:string;team:string;role:string;threadId:string|null;language:Language;onChanged:()=>Promise<void>}) {
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
 const [state,setState]=useState<{paused:boolean;threadId:string|null;fallbacks:ExecutionFallbackSelection[];actual?:ExecutionFallbackSelection|null}|null>(null);
 const [reset,setReset]=useState<number|null>(null);
 useEffect(()=>{let alive=true;void Promise.all([rpc.call("ollamaUsage",{projectId,team,role}),rpc.call("quotaPolicy",{projectId,team})]).then(([v,policy])=>{if(alive)setReset(quotaHeadroom(v,policy).resetAtMs);},()=>{});return()=>{alive=false;};},[rpc,projectId,team,role]);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 useEffect(()=>{let alive=true;setState(null);void rpc.call("roleControl",{projectId,team,role,action:"status"}).then(v=>{if(alive)setState(v);},()=>{});return()=>{alive=false;};},[rpc,projectId,team,role,threadId]);
 const act=async(action:"pause"|"resume")=>{if(!state?.threadId||busy)return;setBusy(true);setError(null);
  try{setState(await rpc.call("roleControl",{projectId,team,role,action,expectedThreadId:state.threadId}));await onChanged();}
  catch{setError(ru?"Продолжение не подтверждено. Проверьте ограничения команды и состояние сотрудника.":"Continuation was not confirmed. Inspect team limits and employee state.");}
  finally{setBusy(false);}
 };
 if(!threadId)return null;
 return <section aria-label={ru?"Продолжение работы":"Continue work"} className="flex flex-col gap-2 border-t border-border pt-2 text-xs">
  {state?.actual&&<p>{ru?"Текущая модель сессии":"Current session model"}: {state.actual.provider} · {state.actual.model}</p>}
  {state?.paused&&<strong>{ru?"Сотрудник на паузе":"Employee paused"}</strong>}
  {state&&<button disabled={busy} onClick={()=>void act(state.paused?"resume":"pause")}>{state.paused?(ru?"Продолжить сотрудника":"Resume employee"):(ru?"Приостановить после текущей операции":"Pause after current operation")}</button>}
  <OpenRouterQuotaCard projectId={projectId} team={team} role={role} model={state?.actual?.model} language={language} onReset={setReset}/>
  <RoleModelRecovery projectId={projectId} team={team} role={role} threadId={threadId} language={language} onChanged={onChanged}/>
  <DeferredControls projectId={projectId} team={team} role={role} threadId={threadId} language={language} onChanged={async()=>{setState(await rpc.call("roleControl",{projectId,team,role,action:"status"}));await onChanged();}} resetAtMs={reset} paused={state?.paused}/>
  <details><summary>{ru?"Очередь и дополнительные действия":"Queue and additional actions"}</summary>
   <p>{ru?"Продолжение очереди может запустить модель. Пауза удерживает следующие ходы и не обрывает текущую операцию.":"Continuing queued work may start a model turn. Pause holds future turns without interrupting current work."}</p>
   <button disabled={busy||!state} onClick={()=>void act("resume")}>{ru?"Продолжить очередь":"Check queued work and continue"}</button>
  </details>
  {error&&<p role="alert">{error}</p>}
 </section>;
}
