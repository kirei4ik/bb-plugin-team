import {describe,it,expect,vi} from "vitest";
import {parseOllamaBalance,exhaustedOllama,isOllamaCloud} from "./ollama-usage";
import {readOllamaUsage} from "./ollama-usage-host";
import type {readFile} from "node:fs/promises";

describe("Pi Ollama quota without a model turn",()=>{
 it("keeps account windows, reset and exact remainder; purchased credit does not authorize overage",()=>{
   const data=parseOllamaBalance({included:{session:{remaining_percent:0,resets_at:"2026-11-15T02:00:00Z"},weekly:{remaining_percent:75}},purchased:{balance_usd:20}},100);
   expect(data.status).toBe("ready");expect(data.windows[0]?.resetsAtMs).toBe(Date.parse("2026-11-15T02:00:00Z"));expect(exhaustedOllama(data)).toBe(true);
   expect(isOllamaCloud("pi","ollama-cloud/other")).toBe(true);expect(isOllamaCloud("pi","openrouter/free")).toBe(false);
 });
 it("missing, malformed and non-finite counters are unavailable, never zero capacity or free",()=>{
   for(const raw of [{},{included:{}},{included:{session:{remaining_percent:NaN}}},{included:{session:{remaining_percent:101}}},{included:{session:{remaining_percent:30,resets_at:"invalid"}}}])expect(parseOllamaBalance(raw,1)).toMatchObject({status:"unavailable",windows:[]});
 });
 it("supports allowance balance without exposing account identity or purchased credits",()=>{
   expect(parseOllamaBalance({included:{balance_usd:2,allowance_usd:10,period:{until:"2026-12-01T00:00:00Z"}}},1).windows[0]?.remainingPercent).toBe(20);
 });
 const deps=(raw:unknown,auth='{"ollama-cloud":{"type":"api_key","key":"private-fixture-key"}}')=>({env:{},read:vi.fn(async()=>auth) as unknown as typeof readFile,fetch:vi.fn(async()=>new Response(JSON.stringify(raw))) as unknown as typeof fetch});
 it("uses the fixed endpoint, forbids redirect, sends key only in host-side Authorization",async()=>{
   const d=deps({included:{weekly:{remaining_percent:90}}});const value=await readOllamaUsage(undefined,d);
   expect(value.status).toBe("ready");expect(JSON.stringify(value)).not.toContain("private-fixture-key");expect(d.fetch).toHaveBeenCalledWith("https://ollama.com/api/balance",expect.objectContaining({redirect:"error",headers:{Authorization:"Bearer private-fixture-key"}}));
 });
 it("refuses executable credentials and never calls a model/shell",async()=>{
   const d=deps({},'{"ollama-cloud":{"type":"api_key","key":"!read-secret"}}');expect(await readOllamaUsage(undefined,d)).toMatchObject({status:"unavailable",reason:"auth_unsupported"});expect(d.fetch).not.toHaveBeenCalled();
 });
 it("does not return credentials, raw HTTP bodies or transport errors",async()=>{
   const d=deps({});d.fetch=vi.fn(async()=>new Response("private-fixture-key",{status:401})) as unknown as typeof fetch;
   expect(await readOllamaUsage(undefined,d)).toMatchObject({reason:"http_error",windows:[]});
   d.fetch=vi.fn(async()=>{throw new Error("private-fixture-key");}) as unknown as typeof fetch;
   expect(JSON.stringify(await readOllamaUsage(undefined,d))).not.toContain("private-fixture-key");
 });
 it("bounds HTTP output",async()=>{
   const d=deps({});d.fetch=vi.fn(async()=>new Response("x".repeat(33000))) as unknown as typeof fetch;
   expect(await readOllamaUsage(undefined,d)).toMatchObject({reason:"invalid_response"});
 });
 it("resolves static environment references without evaluating shell",async()=>{
   const d=deps({included:{session:{remaining_percent:10}}},'{"ollama-cloud":{"type":"api_key","key":"$CUSTOM_OLLAMA_KEY"}}');d.env={CUSTOM_OLLAMA_KEY:"fixture-env-key"};expect((await readOllamaUsage(undefined,d)).status).toBe("ready");
 });
});
