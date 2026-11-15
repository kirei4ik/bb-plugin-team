// Only normalized usage and an opaque key digest leave the execution host.
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join,dirname} from "node:path";
import {parseEnv} from "node:util";
import {createHash} from "node:crypto";
import {emptyOpenRouter,isOpenRouterModel,parseOpenRouterKey,type QuotaSource,type OpenRouterUsage} from "../shared/openrouter-usage";
const official=(value:unknown)=>{try{const u=new URL(String(value));return u.protocol==="https:"&&u.hostname==="openrouter.ai"&&["/api/v1","/api/v1/"].includes(u.pathname)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
export interface OpenRouterHostInput {provider:string;model:string;cwd:string;binding?:QuotaSource}
export async function readOpenRouterUsage(input:OpenRouterHostInput,signal?:AbortSignal,deps={env:process.env,read:readFile,fetch:globalThis.fetch}):Promise<OpenRouterUsage>{
 const known=isOpenRouterModel(input.model)||input.binding?.service==="openrouter";
 let result=emptyOpenRouter("route_unknown",known?"openrouter":"unknown");
 const readJson=async(path:string)=>{try{const s=await deps.read(path,"utf8");if(Buffer.byteLength(s)>1024*1024)throw new Error("oversized");return JSON.parse(s);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}};
 const staticValue=(v:unknown,env:NodeJS.ProcessEnv):string|undefined=>typeof v==="string"&&!v.startsWith("!")?(v.startsWith("$")?env[v.slice(1)]:v):undefined;
 let key:string|undefined;
 try{
  if(input.binding?.credentialEnv){key=deps.env[input.binding.credentialEnv];result={...result,service:input.binding.service==="openrouter"||known?"openrouter":"unknown",source:"environment"};}
  else if(input.provider==="pi"&&known){
   const agentDir=deps.env.PI_CODING_AGENT_DIR||join(homedir(),".pi","agent");
   const models=await readJson(join(agentDir,"models.json"));
   if(models?.providers?.openrouter?.apiKey||models?.providers?.openrouter?.baseUrl)return {...result,reason:"auth_unsupported"};
   const auth=await readJson(join(agentDir,"auth.json"));
   const stored=auth?.openrouter;
   if(stored&&stored.type!=="api_key")return {...result,reason:"auth_unsupported"};
   key=stored?staticValue(stored.key,deps.env):deps.env.OPENROUTER_API_KEY;result={...result,source:"pi-auth"};
  }else if(input.provider==="acp-qwen-code"){
   // Project/custom settings can override the user profile. Refuse rather than
   // inspect a different key; an explicit host env reference supports wrappers.
   if(await readJson(join(input.cwd,".qwen","settings.json")))return {...result,reason:"auth_unsupported"};
   const config=await readJson(join(homedir(),".qwen","settings.json"));
   const models=(Object.values(config?.modelProviders??{}) as unknown[]).flatMap(v=>Array.isArray(v)?v:[]);
   const matches=models.filter(m=>m&&m.id===input.model);
   if(matches.length!==1||!official(matches[0].baseUrl))return {...result,reason:"route_unknown"};
   const name=matches[0].envKey;
   if(typeof name!=="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))return {...result,reason:"auth_unsupported"};
   // Qwen fills unset environment variables: process env > .env > settings.env.
   // Never silently use settings.env when another scoped file may supply the key.
   if(deps.env.QWEN_CODE_CONFIG_DIR||config?.advanced?.excludedEnvVars?.includes(name))return {...result,reason:"auth_unsupported"};
   if(!deps.env[name]){
     for(const file of [join(homedir(),".env"),join(homedir(),".qwen",".env")]){
       try{const text=await deps.read(file,"utf8");if(Buffer.byteLength(text)>1024*1024||parseEnv(text)[name]!==undefined)return {...result,reason:"auth_unsupported"};}
       catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")return {...result,reason:"auth_unsupported"};}
     }
     let dir=input.cwd;
     for(let depth=0;depth<32;depth++){
       const settings=join(dir,".qwen","settings.json");
       if(settings!==join(homedir(),".qwen","settings.json")&&await readJson(settings))return {...result,reason:"auth_unsupported"};
       for(const file of [join(dir,".env"),join(dir,".qwen",".env")]){
         try{const text=await deps.read(file,"utf8");if(Buffer.byteLength(text)>1024*1024||parseEnv(text)[name]!==undefined)return {...result,reason:"auth_unsupported"};}
         catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")return {...result,reason:"auth_unsupported"};}
       }
       const parent=dirname(dir);if(parent===dir)break;if(depth===31)return {...result,reason:"auth_unsupported"};dir=parent;
     }
   }
   const env={...config?.env,...deps.env};
   if(typeof env[name]!=="string"||env[name].startsWith("$")||env[name].startsWith("!"))return {...result,reason:"auth_unsupported"};
   key=env[name];result={...result,service:"openrouter",source:"qwen-settings"};
  }else if(known){
   // Unknown launchers may override OPENROUTER_API_KEY. Explicit declaration is
   // required: never query an arbitrary host key and call it the execution key.
   return {...result,reason:"auth_unsupported"};
  }
 }catch{return {...result,reason:"auth_unsupported"};}
 if(result.service!=="openrouter")return result;
 if(!key?.trim()||key.startsWith("!")||key.length>4096)return {...result,reason:"auth_missing"};
 result={...result,keyId:createHash("sha256").update(key).digest("hex")};
 const request=async(path:"key"|"credits")=>{
  const response=await deps.fetch(`https://openrouter.ai/api/v1/${path}`,{method:"GET",redirect:"error",headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])])});
  if(!response.ok){await response.body?.cancel();return {ok:false,body:null};}
  const reader=response.body?.getReader();if(!reader)throw new Error("missing body");
  let size=0;const parts:Uint8Array[]=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new Error("cap");}parts.push(value);}}finally{reader.releaseLock();}
  return {ok:true,body:JSON.parse(Buffer.concat(parts).toString("utf8"))};
 };
 try{
  const r=await request("key");if(!r.ok)return {...result,reason:"http_error"};
  result=parseOpenRouterKey(r.body,result);if(result.status!=="ready")return result;
  // Ordinary inference keys normally cannot read the account-wide credits.
  // This does not invalidate their precise per-key and free-request counters.
  try{const r=await request("credits");const d=r.body?.data;if(r.ok&&Number.isFinite(d?.total_credits)&&Number.isFinite(d?.total_usage)&&d.total_credits>=0&&d.total_usage>=0)result.accountBalanceUsd=d.total_credits-d.total_usage;}catch{}
  return result;
 }catch{return {...result,status:"unavailable",reason:"transport_error"};}
}
