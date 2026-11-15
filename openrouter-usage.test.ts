import {homedir} from "node:os";
import {describe,it,expect,vi} from "vitest";
import {readOpenRouterUsage} from "./openrouter-usage-host";
import {parseOpenRouterKey,emptyOpenRouter,openRouterHeadroom,quotaSourceSchema} from "./openrouter-usage";
import {teamConfigSchema} from "./core";
import {teamFilesFromTemplate,templateRoleSchema} from "./templates";
import type {readFile} from "node:fs/promises";
const key="fixture-private-OpenRouter-key";
const raw={data:{limit:10,limit_remaining:7,usage:3,free_model_daily_requests:{used:45,limit:50,remaining:5}}};
const json=(files:Record<string,unknown>,env:NodeJS.ProcessEnv={})=>({env,read:vi.fn(async(path:unknown)=>{
 const p=String(path);const match=Object.keys(files).find(k=>k.startsWith("/project/")?p===k:k.startsWith("/.qwen/")?p===homedir()+k:!p.startsWith("/project/")&&p.endsWith(k));if(match)return typeof files[match]==="string"?files[match] as string:JSON.stringify(files[match]);throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});
}) as unknown as typeof readFile,fetch:vi.fn(async(url:unknown)=>String(url).endsWith('/credits')?new Response("not permitted",{status:403}):new Response(JSON.stringify(raw))) as unknown as typeof fetch});
const pi={provider:"pi",model:"openrouter/free",cwd:"/project"};
describe("OpenRouter upstream quota without inference",()=>{
 it("separates free daily counter, key spending cap and unknown account balance",async()=>{
  const deps=json({"/auth.json":{openrouter:{type:"api_key",key}}});const data=await readOpenRouterUsage(pi,undefined,deps);
  expect(data).toMatchObject({service:"openrouter",status:"ready",source:"pi-auth",freeDaily:{used:45,remaining:5,limit:50},keyRemainingUsd:7,accountBalanceUsd:null});
  expect(openRouterHeadroom(data,pi.model)).toMatchObject({held:true,unknown:false,remainingPercent:10});expect(openRouterHeadroom(data,"openrouter/paid").held).toBe(false);
  expect(JSON.stringify(data)).not.toContain(key);
  expect(deps.fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key",expect.objectContaining({method:"GET",redirect:"error",headers:{Authorization:`Bearer ${key}`}}));
 });
 it("resolves the Qwen model profile and groups the same key across Qwen and Pi",async()=>{
  const files={"/auth.json":{openrouter:{type:"api_key",key}},"/.qwen/settings.json":{env:{ROUTER_KEY:key},modelProviders:{openai:[{id:"openrouter/free",baseUrl:"https://openrouter.ai/api/v1",envKey:"ROUTER_KEY"}]}}};
  const a=await readOpenRouterUsage(pi,undefined,json(files));const b=await readOpenRouterUsage({...pi,provider:"acp-qwen-code"},undefined,json(files));
  expect(b).toMatchObject({status:"ready",source:"qwen-settings"});expect(a.keyId).toBe(b.keyId);
 });
 it("supports any launcher by an explicit actual-key env reference, without guessing a host key",async()=>{
  const deps=json({}, {ROUTER_EXECUTION_KEY:key,OPENROUTER_API_KEY:"unrelated-secret"});
  const unknown=await readOpenRouterUsage({...pi,provider:"custom"},undefined,deps);expect(unknown.status).toBe("unavailable");expect(deps.fetch).not.toHaveBeenCalled();
  const data=await readOpenRouterUsage({...pi,provider:"custom",binding:{service:"openrouter",credentialEnv:"ROUTER_EXECUTION_KEY"}},undefined,deps);expect(data.status).toBe("ready");
  expect(JSON.stringify(deps.fetch.mock?.calls??[])).not.toContain("unrelated-secret");
 });
 it("rejects a project Qwen override, mismatched endpoint, ambiguous profiles and nonstatic credentials",async()=>{
  const profile={env:{ROUTER_KEY:key},modelProviders:{openai:[{id:"openrouter/free",baseUrl:"https://openrouter.ai/api/v1",envKey:"ROUTER_KEY"}]}};
  for(const files of [
   {"/project/.qwen/settings.json":{env:{ROUTER_KEY:"other"}},"/.qwen/settings.json":profile},
   {"/.qwen/settings.json":{...profile,modelProviders:{openai:[{...profile.modelProviders.openai[0],baseUrl:"https://other.example/api/v1"}]}}},
   {"/.qwen/settings.json":{...profile,modelProviders:{openai:[...profile.modelProviders.openai,...profile.modelProviders.openai]}}},
   {"/.qwen/settings.json":{...profile,env:{ROUTER_KEY:"!shell-secret"}}}
  ]){const deps=json(files);expect((await readOpenRouterUsage({...pi,provider:"acp-qwen-code"},undefined,deps)).status).toBe("unavailable");expect(deps.fetch).not.toHaveBeenCalled();}
 });
 it("Pi respects its stored key/reference and refuses OAuth or executable auth",async()=>{
  const deps=json({"/auth.json":{openrouter:{type:"api_key",key:"$EXEC_KEY"}}},{EXEC_KEY:key});expect((await readOpenRouterUsage(pi,undefined,deps)).status).toBe("ready");
  for(const stored of [{type:"oauth",access:key},{type:"api_key",key:"!print-secret"}]){const d=json({"/auth.json":{openrouter:stored}});expect((await readOpenRouterUsage(pi,undefined,d)).status).toBe("unavailable");expect(d.fetch).not.toHaveBeenCalled();}
 });
 it("handles stale/unknown counters without treating dollars as free requests or null as zero",()=>{
  const empty=emptyOpenRouter("http_error");expect(openRouterHeadroom(empty,pi.model)).toMatchObject({unknown:true,held:false});
  const data=parseOpenRouterKey({data:{limit:null,limit_remaining:null,usage:0}},empty);expect(data.status).toBe("ready");expect(openRouterHeadroom(data,pi.model).unknown).toBe(true);
  for(const d of [{},{data:{}},{data:{usage:Infinity}},{data:{free_model_daily_requests:{used:45,limit:50,remaining:20}}}])expect(parseOpenRouterKey(d,empty).status).toBe("unavailable");
 });
 it("paid budgets hold without blocking free routes; negative account balance can block both",()=>{
  const data=parseOpenRouterKey({data:{...raw.data,limit_remaining:0,budgets:[{limit_usd:10,remaining_usd:0,resets_at:"2026-11-16T00:00:00Z"}],free_model_daily_requests:{used:0,limit:50,remaining:50}}},emptyOpenRouter(null));
  expect(openRouterHeadroom(data,pi.model).held).toBe(false);expect(openRouterHeadroom(data,"paid/model")).toMatchObject({held:true,resetAtMs:Date.parse("2026-11-16T00:00:00Z")});
  expect(openRouterHeadroom({...data,accountBalanceUsd:-0.1},pi.model).held).toBe(true);
 });
 it("keeps credential and raw HTTP bodies private; redirect, cap and cancellation are bounded",async()=>{
  const deps=json({"/auth.json":{openrouter:{type:"api_key",key}}});
  deps.fetch=vi.fn(async()=>new Response(key,{status:401})) as never;expect(JSON.stringify(await readOpenRouterUsage(pi,undefined,deps))).not.toContain(key);
  deps.fetch=vi.fn(async()=>new Response("x".repeat(66000))) as never;expect((await readOpenRouterUsage(pi,undefined,deps)).status).toBe("unavailable");
  deps.fetch=vi.fn(async()=>{throw new Error(key);}) as never;expect(JSON.stringify(await readOpenRouterUsage(pi,undefined,deps))).not.toContain(key);
 });
 it("never uses a distinct Qwen credential to fill missing Pi auth",async()=>{
  const deps=json({"/.qwen/settings.json":{env:{OPENROUTER_API_KEY:key}}});expect((await readOpenRouterUsage(pi,undefined,deps)).reason).toBe("auth_missing");expect(deps.fetch).not.toHaveBeenCalled();
 });
 it("account balance is returned only when the same credential can read credits",async()=>{
  const deps=json({"/auth.json":{openrouter:{type:"api_key",key}}});deps.fetch=vi.fn(async(url)=>new Response(JSON.stringify(String(url).endsWith('/credits')?{data:{total_credits:20,total_usage:3}}:raw))) as never;
  expect((await readOpenRouterUsage(pi,undefined,deps)).accountBalanceUsd).toBe(17);
 });
 it("source selection round-trips through role/template/team generation; secret-like env names are refused",()=>{
  const quotaSource={service:"openrouter" as const,credentialEnv:"AGENT_OPENROUTER_KEY"};
  expect(quotaSourceSchema.safeParse({...quotaSource,credentialEnv:"sk-or-private-key"}).success).toBe(false);
  const role=templateRoleSchema.parse({name:"lead",provider:"custom",model:"alias",quotaSource});
  expect(teamConfigSchema.parse({roles:[role]}).roles[0]?.quotaSource).toEqual(quotaSource);
  const files=teamFilesFromTemplate("en",{id:"custom",title:"Custom",roles:[role]},"main",{} as never);expect(JSON.stringify(files)).toContain("AGENT_OPENROUTER_KEY");
 });
 it("Qwen process env wins over settings, and ambiguous dotenv credentials are not guessed",async()=>{
  const profile={env:{KEY:key},modelProviders:{openai:[{id:"openrouter/free",baseUrl:"https://openrouter.ai/api/v1",envKey:"KEY"}]}};
  const deps=json({"/.qwen/settings.json":profile},{KEY:"actual-process-key"});
  const data=await readOpenRouterUsage({...pi,provider:"acp-qwen-code"},undefined,deps);expect(data.status).toBe("ready");expect(deps.fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key",expect.objectContaining({headers:{Authorization:"Bearer actual-process-key"}}));
  const d=json({"/.qwen/settings.json":profile,"/project/.env":"KEY=dotenv-key"});expect((await readOpenRouterUsage({...pi,provider:"acp-qwen-code"},undefined,d)).reason).toBe("auth_unsupported");expect(d.fetch).not.toHaveBeenCalled();
 });

});
