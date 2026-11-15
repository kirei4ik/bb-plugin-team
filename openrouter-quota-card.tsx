import {useEffect,useState} from "react";
import {useRpc,useRealtime} from "@get-bb/plugin-sdk/app";
import {openRouterHeadroom,type OpenRouterUsage} from "./openrouter-usage";
import type {rpcContract} from "./server";
export function OpenRouterQuotaCard({projectId,team,role,model,language,onReset}:{projectId:string;team:string;role:string;model?:string|null;language:"ru"|"en";onReset?:(ms:number|null)=>void}){
 const rpc=useRpc<typeof rpcContract>(),ru=language==="ru";
 const money=(n:number)=>n!==0&&Math.abs(n)<0.0001?`${n<0?"−":""}$<0.0001`:`$${Number(n.toFixed(4))}`;
 const [data,setData]=useState<OpenRouterUsage|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
 const load=async(refresh=false)=>{setBusy(true);setError(false);try{const [u,policy]=await Promise.all([rpc.call("openrouterUsage",{projectId,team,role,refresh}),rpc.call("quotaPolicy",{projectId,team})]);setData(u);if(u.service==="openrouter")onReset?.(openRouterHeadroom(u,model,policy.pauseBelowPercent).resetAtMs);}catch{setError(true);}finally{setBusy(false);}};
 useEffect(()=>{void load();},[rpc,projectId,team,role,model]);
 useRealtime("team-changed",payload=>{if((payload as {projectId?:string}|null)?.projectId===projectId)void load();});
 if(data?.service==="unknown")return null;
 return <details className="rounded border border-border p-2 text-xs"><summary>{ru?"Квота OpenRouter / источник подключения":"OpenRouter quota / connection source"}</summary>
  {data?.service==="openrouter"?<>
   <p>{ru?"Сервис: OpenRouter. Агент и модель не создают отдельную квоту.":"Service: OpenRouter. Agents and models do not create a separate quota."}</p>
   {data.freeDaily&&<p>{ru?"Бесплатные запросы за сутки":"Daily free requests"}: {ru?"осталось":"remaining"} {data.freeDaily.remaining} / {data.freeDaily.limit} · {ru?"использовано":"used"} {data.freeDaily.used} · {ru?"сброс":"reset"} {new Date(data.freeDaily.resetsAtMs).toLocaleString()}</p>}
   <p>{ru?"Остаток денежного лимита ключа":"Key spending cap remaining"}: {data.keyRemainingUsd===null?(ru?"не задан или не сообщён":"unset or not reported"):money(data.keyRemainingUsd)}</p>
   <p>{ru?"Баланс аккаунта":"Account balance"}: {data.accountBalanceUsd===null?(ru?"не сообщён этим ключом; обычно нужен управляющий ключ":"not reported by this key; usually requires management access"):money(data.accountBalanceUsd)}</p>
   {data.budgets.map((b,i)=><p key={i}>{ru?"Бюджет":"Budget"} {i+1}: {money(b.remainingUsd)} / {money(b.limitUsd)}{b.resetsAtMs?` · ${new Date(b.resetsAtMs).toLocaleString()}`:""}</p>)}
   <p>{ru?"Минутный остаток и доступность конкретной бесплатной модели этим счётчиком не подтверждаются.":"This counter does not confirm per-minute headroom or availability of a specific free model."}</p>
  </>:<p>{ru?"Источник не определён. В профиле сотрудника выберите OpenRouter и при необходимости имя переменной с действующим ключом.":"Connection source unknown. Select OpenRouter in the employee profile and, if needed, the actual key variable."}</p>}
  {data?.status!=="ready"&&<p role="status">{ru?"Свежая квота не подтверждена. Неизвестный остаток не означает доступную квоту.":"Fresh quota unconfirmed. Unknown does not mean available."} {data?.reason}</p>}
  {data&&<p>{ru?"Проверено":"Checked"}: {new Date(data.checkedAtMs).toLocaleString()}{data.observedAtMs?` · ${ru?"последние успешные данные":"last successful data"} ${new Date(data.observedAtMs).toLocaleString()}`:""}</p>}
  {error&&<p role="alert">{ru?"Проверка не выполнена":"Check unavailable"}</p>}
  <button disabled={busy} onClick={()=>void load(true)}>{ru?"Обновить квоту OpenRouter":"Refresh OpenRouter quota"}</button>
 </details>;
}
