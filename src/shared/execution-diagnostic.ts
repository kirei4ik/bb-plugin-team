import type { RoleExecutionState, TaskId, TeamTask } from "./snapshot";

/** Presentation only. Tracker statuses and execution bindings are never changed. */
export type ExecutionStatus = "waiting" | "working" | "review" | "resource" | "handoff" | "recovering" | "decision" | "done" | "cancelled";
export interface ExecutionDiagnostic {
  taskId: TaskId;
  role: string;
  status: ExecutionStatus;
  source: "tracker" | "session" | "handoff" | "resources";
  reasonCode: string;
  atMs: number;
  /** A saved report is evidence of submission, never proof of acceptance. */
  savedResult: "submitted" | "accepted" | "none";
}

export function executionDiagnostic(task: TeamTask, state?: RoleExecutionState): ExecutionDiagnostic {
  const result: ExecutionDiagnostic = {taskId: task.id, role: task.role, status: "waiting", source: "tracker",
    reasonCode: "task_waiting", atMs: task.updatedAtMs,
    savedResult: task.status === "done" ? "accepted" : task.review?.submission ? "submitted" : "none"};
  if (task.status === "done" || task.status === "dropped") {
    return {...result, status: task.status === "done" ? "done" : "cancelled", reasonCode: task.status === "done" ? "task_accepted" : "task_cancelled"};
  }
  if (task.status === "review") return {...result, status: "review", reasonCode: "awaiting_acceptance"};
  // A role's current hold/replacement must not make its queued packages active.
  if (!state || state.taskId !== task.id) return result;
  const base = {...result, atMs: state.atMs, reasonCode: state.errorCode ?? state.kind};
  switch (state.kind) {
    case "working": return {...base, status: "working", source: "session"};
    case "error": return {...base, status: state.errorCode === "resource_hold" ? "resource" : "decision", source: state.errorCode === "resource_hold" ? "resources" : state.errorCode === "session_failed" ? "session" : "handoff"};
    case "awaiting-resource": return {...base, status: "resource", source: "resources"};
    case "replacing": return {...base, status: "recovering", source: "handoff"};
    case "awaiting-checkpoint":
    case "awaiting-safe-boundary": return {...base, status: "handoff", source: "handoff"};
    case "awaiting-team-decision": return {...base, status: "decision", source: "resources"};
    default: return {...base, source: "session"};
  }
}

export const EXECUTION_STATUS_LABELS: Record<"ru" | "en", Record<ExecutionStatus, string>> = {
  ru: {waiting: "Ожидает", working: "Выполняется", review: "На проверке", resource: "Ожидает ресурс", handoff: "Ожидает передачу", recovering: "Восстанавливается", decision: "Требует решения", done: "Завершено", cancelled: "Отменено"},
  en: {waiting: "Waiting", working: "Working", review: "In review", resource: "Waiting for resources", handoff: "Waiting for handoff", recovering: "Recovering", decision: "Needs a decision", done: "Completed", cancelled: "Cancelled"},
};
