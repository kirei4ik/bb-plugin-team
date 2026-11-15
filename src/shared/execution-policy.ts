// Execution policy for a role: an ordered list of allowed fallback model
// selections plus an explicit user confirmation that these fallbacks are
// permitted without additional payment.
//
// Automatic fallback uses the existing safe handoff on confirmed quota; this
// file only defines the schema, types and small pure helpers used by core,
// templates and the UI editors.

import { z } from "zod";

/**
 * One allowed fallback selection. Fields intentionally mirror the existing
 * role/template model fields so unknown provider/model/reasoning/serviceTier
// values round-trip untouched.
 */
export const executionFallbackSelectionSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(300),
  reasoningLevel: z.string().trim().min(1).max(100).optional(),
  serviceTier: z.string().trim().min(1).max(100).optional(),
});

export type ExecutionFallbackSelection = z.infer<typeof executionFallbackSelectionSchema>;

/**
 * The execution policy attached to a role or template role.
 * `noAdditionalCost: true` is an explicit user confirmation, not a proof of
 * zero price derived from the provider catalog.
 */
export const executionPolicySchema = z.object({
  noAdditionalCost: z.literal(true),
  fallbacks: z.array(executionFallbackSelectionSchema).min(1).max(32),
}).superRefine((policy, ctx) => {
  const seen = new Set<string>();
  policy.fallbacks.forEach((entry, index) => {
    const key = JSON.stringify([entry.provider, entry.model]);
    if (seen.has(key)) ctx.addIssue({code: "custom", path: ["fallbacks", index], message: "Duplicate fallback provider/model"});
    seen.add(key);
  });
});

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

/** Normalize a policy: drop empty fallback lists, keep everything else. */
export function normalizeExecutionPolicy(policy: ExecutionPolicy | undefined): ExecutionPolicy | undefined {
  if (!policy || !policy.fallbacks.length) return undefined;
  return policy;
}

/** True when two fallback selections address the same provider+model pair. */
export function fallbackSelectionsEqual(
  a: ExecutionFallbackSelection,
  b: ExecutionFallbackSelection,
): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** Find the first duplicate provider+model in the list, if any. */
export function findDuplicateFallback(
  fallbacks: ExecutionFallbackSelection[],
): ExecutionFallbackSelection | undefined {
  const seen = new Set<string>();
  for (const fb of fallbacks) {
    const key = JSON.stringify([fb.provider, fb.model]);
    if (seen.has(key)) return fb;
    seen.add(key);
  }
  return undefined;
}

/** Read from the team config on each spawn/replace; templates are copied, never live-linked. */
export function executionRosterPrompt(roles: Array<{name:string;provider?:string;model?:string;reasoningLevel?:string;serviceTier?:string;executionPolicy?:ExecutionPolicy}>, lang:"en"|"ru"):string {
  const rows=roles.map(({name,provider,model,reasoningLevel,serviceTier,executionPolicy})=>({role:name,primary:{provider:provider??null,model:model??null,reasoningLevel:reasoningLevel??null,serviceTier:serviceTier??null},fallbacks:executionPolicy?.fallbacks??[],userConfirmedNoAdditionalCost:executionPolicy?.noAdditionalCost===true}));
  const intro=lang==="ru"
    ? "Профили из действующего конфига команды. null означает настройку BB по умолчанию, а не разрешение выбирать произвольную модель. Только эти подтверждённые резервы разрешены пользователем; это не проверка цены. Замена при квоте требует независимого подтверждённого провайдера и свежего сохранённого checkpoint, иначе работа останавливается. Изменение шаблона не меняет эту команду."
    : "Profiles from the current team config. null means the BB default, not permission to choose an arbitrary model. Only these user-approved backups are allowed; this is not a price check. Quota switching requires an independent approved provider and a fresh saved checkpoint; otherwise it stops. Template edits do not change this team.";
  return `<!-- team-execution-profile -->\n${intro}\n${JSON.stringify(rows)}\n<!-- /team-execution-profile -->`;
}
export function withExecutionProfile(prompt:string, roles:Parameters<typeof executionRosterPrompt>[0], lang:"en"|"ru"):string {
  const original=prompt.replace(/\s*<!-- team-execution-profile -->[\s\S]*?<!-- \/team-execution-profile -->/g,"");
  return `${original}\n\n${executionRosterPrompt(roles,lang)}`;
}
