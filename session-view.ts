// Read-only session presentation; no model calls, polling or execution state storage.
import { z } from "zod";

export const contextViewSchema = z.object({
  kind: z.enum(["exact", "estimated", "unavailable"]),
  usedTokens: z.number().nonnegative().nullable(),
  limitTokens: z.number().positive().nullable(),
});
export type ContextView = z.infer<typeof contextViewSchema>;
export const sessionViewSchema = z.object({
  threadId: z.string().nullable(),
  taskId: z.union([z.number(), z.string()]).nullable(),
  context: contextViewSchema,
  checkpoint: z.enum(["ready", "missing", "stale", "unavailable"]),
  phase: z.enum(["idle", "awaiting-checkpoint", "awaiting-safe-boundary", "awaiting-package", "replacing", "error"]),
  reason: z.enum(["context", "accepted"]).nullable(),
  blockedReason: z.enum(["no_session", "multiple_sessions", "session_changed", "no_task", "task_reassigned", "tracker_unavailable", "paused", "failed", "replacement_pending"]).nullable(),
  errorCode: z.string().nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

/** Invalid/contradictory counters are unavailable, never presented as 0% or exact. */
export function contextView(value: unknown): ContextView {
  const empty: ContextView = { kind: "unavailable", usedTokens: null, limitTokens: null };
  if (!value || typeof value !== "object") return empty;
  const u = value as Record<string, unknown>;
  const used = u.usedTokens, limit = u.modelContextWindow;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 ||
      typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || typeof u.estimated !== "boolean" || !Number.isFinite(used / limit)) return empty;
  const s = u.snapshot;
  if (s != null) {
    if (typeof s !== "object") return empty;
    const snap = s as Record<string, unknown>;
    if (snap.usedTokens !== used || snap.contextWindowTokens !== limit || typeof snap.estimated !== "boolean") return empty;
    if (!u.estimated && snap.estimated) return empty;
  }
  return { kind: u.estimated ? "estimated" : "exact", usedTokens: used, limitTokens: limit };
}
