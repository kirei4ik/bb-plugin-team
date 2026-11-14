import { z } from "zod";

export const ollamaUsageSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  observedAtMs: z.number().finite().nonnegative().optional(),
  checkedAtMs: z.number().finite().nonnegative(),
  windows: z.array(z.object({ name: z.enum(["session", "weekly", "monthly", "plan"]), remainingPercent: z.number().finite().min(0).max(100), resetsAtMs: z.number().finite().positive().nullable() }).strict()).max(3),
  reason: z.enum(["auth_missing", "auth_unsupported", "http_error", "transport_error", "invalid_response", "host_unavailable"]).nullable(),
}).strict();
export type OllamaUsage = z.infer<typeof ollamaUsageSchema>;
export const isOllamaCloud = (provider: string, model: string | null | undefined) => provider === "pi" && model?.startsWith("ollama-cloud/") === true;
export const exhaustedOllama = (usage: OllamaUsage | undefined) => usage?.windows.some(w => w.remainingPercent === 0) === true;
export function parseOllamaBalance(raw: unknown, checkedAtMs: number): OllamaUsage {
  const window = z.object({ remaining_percent: z.number().finite().min(0).max(100), resets_at: z.string().optional() });
  const parsed = z.object({ included: z.object({ session: window.optional(), weekly: window.optional(), monthly: window.optional(), balance_usd: z.number().finite().nonnegative().optional(), allowance_usd: z.number().finite().positive().optional(), period: z.object({ until: z.string().optional() }).optional() }) }).safeParse(raw);
  const bad: OllamaUsage = {status:"unavailable",checkedAtMs,windows:[],reason:"invalid_response"};
  if (!parsed.success) return bad;
  const windows: OllamaUsage["windows"] = [];
  const included = parsed.data.included;
  const date = (s?: string) => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
  for (const name of ["session","weekly","monthly"] as const) {
    const w = included[name]; if (!w) continue;
    if (w.resets_at && date(w.resets_at) === null) return bad;
    windows.push({name,remainingPercent:w.remaining_percent,resetsAtMs:date(w.resets_at)});
  }
  if (!windows.length && included.balance_usd !== undefined && included.allowance_usd !== undefined) {
    windows.push({name:"plan",remainingPercent:Math.min(100,100*included.balance_usd/included.allowance_usd),resetsAtMs:date(included.period?.until)});
  }
  return windows.length ? {status:"ready",checkedAtMs,windows,reason:null} : bad;
}
