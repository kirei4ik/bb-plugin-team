// Same fixed read-only endpoint as pi-ollama-cloud /ollama-cloud-usage.
// Credentials never leave the host. No model, shell command, or auth mutation.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseOllamaBalance, type OllamaUsage } from "../shared/ollama-usage";

export async function readOllamaUsage(signal?: AbortSignal, deps = { env: process.env, read: readFile, fetch: globalThis.fetch }): Promise<OllamaUsage> {
  const checkedAtMs = Date.now();
  const unavailable = (reason: OllamaUsage["reason"]): OllamaUsage => ({status:"unavailable",checkedAtMs,windows:[],reason});
  let key = deps.env.OLLAMA_API_KEY;
  try {
    const text = await deps.read(join(deps.env.PI_CODING_AGENT_DIR || join(homedir(),".pi","agent"),"auth.json"), "utf8");
    if (Buffer.byteLength(text) > 1024*1024) return unavailable("auth_unsupported");
    const stored = JSON.parse(text)["ollama-cloud"];
    if (stored) {
      if (stored.type !== "api_key" || typeof stored.key !== "string" || stored.key.startsWith("!")) return unavailable("auth_unsupported");
      key = stored.key.startsWith("$") ? deps.env[stored.key.slice(1)] : stored.key;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable("auth_unsupported");
  }
  if (!key?.trim()) return unavailable("auth_missing");
  try {
    const response = await deps.fetch("https://ollama.com/api/balance", {method:"GET",redirect:"error",headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])])});
    if (!response.ok) { await response.body?.cancel(); return unavailable("http_error"); }
    const reader = response.body?.getReader(); if (!reader) return unavailable("invalid_response");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); return unavailable("invalid_response"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    return parseOllamaBalance(JSON.parse(Buffer.concat(chunks).toString("utf8")), checkedAtMs);
  } catch { return unavailable("transport_error"); }
}
