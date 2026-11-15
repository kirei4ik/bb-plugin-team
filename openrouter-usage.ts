import {z} from "zod";
export const quotaSourceSchema=z.object({service:z.enum(["auto","openrouter","ollama-cloud"]),credentialEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional()}).strict();
export type QuotaSource=z.infer<typeof quotaSourceSchema>;
const money=z.number().finite();
export const openRouterUsageSchema=z.object({
 service:z.enum(["openrouter","unknown"]),status:z.enum(["ready","unavailable"]),checkedAtMs:z.number().finite(),observedAtMs:z.number().finite().optional(),
 keyId:z.string().regex(/^[a-f0-9]{64}$/).nullable(),source:z.enum(["pi-auth","qwen-settings","environment","unsupported"]),
 reason:z.enum(["auth_missing","auth_unsupported","route_unknown","http_error","transport_error","invalid_response","host_unavailable"]).nullable(),
 freeDaily:z.object({used:z.number().int().nonnegative(),limit:z.number().int().nonnegative(),remaining:z.number().int().nonnegative(),resetsAtMs:z.number().finite()}).nullable(),
 keyRemainingUsd:money.nullable(),keyLimitUsd:money.nonnegative().nullable(),usageUsd:money.nonnegative().nullable(),accountBalanceUsd:money.nullable(),
 budgets:z.array(z.object({remainingUsd:money,limitUsd:money.nonnegative(),resetsAtMs:z.number().finite().nullable()})).max(50),
}).strict();
export type OpenRouterUsage=z.infer<typeof openRouterUsageSchema>;
export const isOpenRouterModel=(model:string|null|undefined)=>model?.startsWith("openrouter/")===true;
export const isOpenRouterFree=(model:string|null|undefined)=>model==="openrouter/free"||model?.endsWith(":free")===true||model?.startsWith("openrouter/free/")===true;
export function emptyOpenRouter(reason:OpenRouterUsage["reason"],service:OpenRouterUsage["service"]="openrouter",checkedAtMs=Date.now()):OpenRouterUsage{
 return {service,status:"unavailable",checkedAtMs,keyId:null,source:"unsupported",reason,freeDaily:null,keyRemainingUsd:null,keyLimitUsd:null,usageUsd:null,accountBalanceUsd:null,budgets:[]};
}
export function parseOpenRouterKey(raw:unknown,base:OpenRouterUsage):OpenRouterUsage{
 const dollar=money.nullable().optional();
 const parsed=z.object({data:z.object({limit:dollar,limit_remaining:dollar,usage:money.nonnegative().optional(),
  free_model_daily_requests:z.object({used:z.number().int().nonnegative(),limit:z.number().int().nonnegative(),remaining:z.number().int().nonnegative()}).optional(),
  budgets:z.array(z.object({limit_usd:money.nonnegative(),remaining_usd:money,resets_at:z.iso.datetime().nullable()})).max(50).optional(),
 })}).safeParse(raw);
 if(!parsed.success)return {...base,status:"unavailable",reason:"invalid_response"};
 const d=parsed.data.data;
 if(d.limit===undefined&&d.limit_remaining===undefined&&d.usage===undefined&&!d.free_model_daily_requests&&!d.budgets)return {...base,status:"unavailable",reason:"invalid_response"};
 if(d.free_model_daily_requests&&d.free_model_daily_requests.remaining>Math.max(0,d.free_model_daily_requests.limit-d.free_model_daily_requests.used))return {...base,status:"unavailable",reason:"invalid_response"};
 return {...base,status:"ready",reason:null,freeDaily:d.free_model_daily_requests?{...d.free_model_daily_requests,resetsAtMs:(Math.floor(base.checkedAtMs/86400_000)+1)*86400_000}:null,
 keyRemainingUsd:d.limit_remaining??null,keyLimitUsd:d.limit??null,usageUsd:d.usage??null,budgets:(d.budgets??[]).map(b=>({remainingUsd:b.remaining_usd,limitUsd:b.limit_usd,resetsAtMs:b.resets_at?Date.parse(b.resets_at):null}))};
}
export function openRouterHeadroom(usage:OpenRouterUsage|undefined,model:string|null|undefined,threshold=10){
 const free=isOpenRouterFree(model),daily=usage?.freeDaily;
 const remainingPercent=free?(daily?daily.limit>0?100*daily.remaining/daily.limit:0:null):usage?.keyLimitUsd!=null&&usage.keyLimitUsd>0&&usage.keyRemainingUsd!=null?100*usage.keyRemainingUsd/usage.keyLimitUsd:null;
 const lowBudgets=!free?(usage?.budgets??[]).filter(b=>b.remainingUsd<=0||b.limitUsd>0&&100*b.remainingUsd/b.limitUsd<=threshold):[];
 const held=(remainingPercent!==null&&remainingPercent<=threshold)||lowBudgets.length>0||(!free&&usage?.keyRemainingUsd!=null&&usage.keyRemainingUsd<=0)||(usage?.accountBalanceUsd!=null&&usage.accountBalanceUsd<0);
 const resets=[...(free&&held&&daily?[daily.resetsAtMs]:[]),...lowBudgets.map(b=>b.resetsAtMs)];
 return {held,unknown:usage?.status!=="ready"||(free?!daily:usage.accountBalanceUsd===null&&usage.keyRemainingUsd===null&&!usage.budgets.length),remainingPercent,resetAtMs:resets.length&&resets.every(n=>n!==null)?Math.max(...resets as number[]):null};
}
