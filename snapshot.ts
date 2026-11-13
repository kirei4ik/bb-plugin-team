import type { ResourceSummary } from "./resource-control";
// Team snapshot: the shared, serializable picture of a project's team.
// Pure module (no SDK, no node APIs): the server builds it, the CLI report
// renders it, and the Team panel (app.tsx) draws it.

import type { TaskReviewRecord } from "./review";

export type Language = "en" | "ru";

export const TASK_STATUSES = ["todo", "in-progress", "review", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskId = number | string;

export interface TeamTask {
  id: TaskId;
  role: string;
  title: string;
  status: TaskStatus;
  note: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** Built-in tracker only; Beads owns its checkpoint in task metadata. */
  checkpoint?: unknown;
  priority?: number;
  criteria?: string;
  decisions?: string;
  result?: string;
  dependencies?: TaskId[];
  /** bbt-iwi.2: review submission + acceptance decisions, stored only in the selected tracker. */
  review?: TaskReviewRecord;
}

export interface SnapshotThread {
  threadId: string;
  status: string;
  provider: string;
  title: string;
  updatedAtMs: number;
  parentThreadId: string | null;
}

export interface SnapshotRole {
  name: string;
  title: string;
  lead: boolean;
  /** Declared in .bb/team.yaml (false: a thread carries a role the config lost). */
  inConfig: boolean;
  enabled: boolean;
  provider: string | null;
  model: string | null;
  threads: SnapshotThread[];
  /** Nested threads under the role's thread (spawned by the agent or by hand). */
  helpers: SnapshotThread[];
  /** Open tasks (todo / in-progress / review), oldest first. */
  tasks: TeamTask[];
  /** What the role session is doing from Team's point of view; absent when idle. */
  executionState?: RoleExecutionState;
}

export interface TeamSnapshot {
  projectId: string;
  projectName: string;
  team: string;
  teamTitle: string | null;
  /** Every team of the project (configs and threads), for the team switcher. */
  teams: string[];
  /** Config tracked by git; null when there is no config. */
  versioned: boolean | null;
  /** The root .gitignore ignores .bb/ entirely: versioning is impossible. */
  versioningBlocked: boolean;
  configSource: string | null;
  configError: string | null;
  leadRole: string | null;
  paused: boolean;
  resources?: ResourceSummary;
  roles: SnapshotRole[];
  generatedAtMs: number;
  tracker?: "beads" | "builtin";
  /**
   * The selected tracker's storage is missing: packages are empty and the
   * panel offers the tracker's one prepare action (Beads: create the
   * database). Null when the tracker is usable.
   */
  trackerError?: { code: "beads_absent"; message: string } | null;
}

export type StatusTone = "running" | "idle" | "error" | "missing" | "other";

/* ──────────────────────── Execution state (bbt-er6.5) ──────────────────────── */

/** Technical stage of a durable auto-continue request (KV, ids only). */
export type AutoContinueStage =
  | "awaiting-checkpoint"
  | "awaiting-safe-boundary"
  | "awaiting-package"
  | "failed";

export type ExecutionStateKind =
  /** The session executes an open package (or the thread is running). */
  | "working"
  /** Package in review: waits for the lead (or a human) decision. */
  | "awaiting-acceptance"
  /** Accepted package consumed the session; the agent must save its checkpoint. */
  | "awaiting-checkpoint"
  /** Checkpoint saved; waiting for the session to reach a safe boundary. */
  | "awaiting-safe-boundary"
  /** Consumed session waits for the next ready package before replacement. */
  | "awaiting-package"
  /** Session replacement in progress. */
  | "replacing"
  /** Explicit failure; a human must decide. */
  | "error";

/** Optional, minimal, typed per-role execution state for the UI. */
export interface RoleExecutionState {
  kind: ExecutionStateKind;
  /** The package this state is about, when known. */
  taskId: TaskId | null;
  /** Technical error code for kind "error" (checkpoint_stale, spawn_uncertain, …). */
  errorCode: string | null;
  /** Bounded original failure cause for kind "error" (≤1000 chars, no stack). */
  errorMessage?: string;
  /** Safe next action for a human; null unless kind is "error". */
  safeAction: string | null;
  /** When the state was last observed/updated. */
  atMs: number;
}

export interface ExecutionStateInput {
  role: string;
  /** Open tasks of the role, oldest first. */
  tasks: readonly TeamTask[];
  /** Existing replacement intent (technical fields only), null when none. */
  replacement: {
    stage: string;
    delivery: string;
    startedAtMs: number;
  } | null;
  /** Durable auto-continue request (technical fields only), null when none. */
  autoContinue: {
    taskId: TaskId;
    stage: AutoContinueStage;
    errorCode: string | null;
    /** Bounded original failure cause (technical, no checkpoint content). */
    error?: string | null;
    /** Why the replacement was requested: package acceptance or context rotation. */
    reason?: "accepted" | "context";
    updatedAtMs: number;
  } | null;
  /** Status of the role's canonical session thread, null when it has none. */
  threadStatus: string | null;
}

const RUNNING_THREAD_STATUSES = ["active", "starting", "pending"];

/**
 * Derive the role execution state from tasks, the existing replacement intent
 * and the durable auto-continue request. Priority: replacement > auto-continue
 * > tasks > running thread. Undefined means "nothing to report".
 */
export function deriveExecutionState(
  input: ExecutionStateInput,
): RoleExecutionState | undefined {
  const replaceHint = `bb team replace ${input.role} --dry-run`;
  const auto = input.autoContinue;
  // An explicit auto-continue failure wins over a stuck intent: "replacing"
  // must not hide an error a human has to resolve.
  if (auto?.stage === "failed") {
    return {
      kind: "error",
      taskId: auto.taskId,
      errorCode: auto.errorCode,
      errorMessage: boundCause(auto.error),
      safeAction: autoContinueSafeAction(input.role, auto.errorCode),
      atMs: auto.updatedAtMs,
    };
  }
  if (input.replacement && input.replacement.stage !== "complete") {
    if (input.replacement.stage === "spawn_uncertain") {
      return {
        kind: "error",
        taskId: null,
        errorCode: "spawn_uncertain",
        safeAction: `A spawn attempt is unresolved; inspect BB for a possibly-created thread, then retry ${replaceHint} or abort`,
        atMs: input.replacement.startedAtMs,
      };
    }
    return {
      kind: "replacing",
      taskId: null,
      errorCode: null,
      safeAction: null,
      atMs: input.replacement.startedAtMs,
    };
  }
  if (input.replacement && input.replacement.delivery === "uncertain") {
    return {
      kind: "error",
      taskId: null,
      errorCode: "delivery_uncertain",
      safeAction: `Role switched, but prompt release is uncertain; run bb team resume`,
      atMs: input.replacement.startedAtMs,
    };
  }
  if (auto) {
    if (auto.stage === "awaiting-checkpoint") {
      return {
        kind: "awaiting-checkpoint",
        taskId: auto.taskId,
        errorCode: null,
        safeAction: null,
        atMs: auto.updatedAtMs,
      };
    }
    if (auto.stage === "awaiting-safe-boundary") {
      return {
        kind: "awaiting-safe-boundary",
        taskId: auto.taskId,
        errorCode: null,
        safeAction: null,
        atMs: auto.updatedAtMs,
      };
    }
    return {
      kind: "awaiting-package",
      taskId: auto.taskId,
      errorCode: null,
      safeAction: null,
      atMs: auto.updatedAtMs,
    };
  }
  const inProgress = input.tasks.find((task) => task.status === "in-progress");
  if (inProgress) {
    return {
      kind: "working",
      taskId: inProgress.id,
      errorCode: null,
      safeAction: null,
      atMs: inProgress.updatedAtMs,
    };
  }
  const review = input.tasks.find((task) => task.status === "review");
  if (review) {
    return {
      kind: "awaiting-acceptance",
      taskId: review.id,
      errorCode: null,
      safeAction: null,
      atMs: review.updatedAtMs,
    };
  }
  if (input.threadStatus && RUNNING_THREAD_STATUSES.includes(input.threadStatus)) {
    return {
      kind: "working",
      taskId: null,
      errorCode: null,
      safeAction: null,
      atMs: 0,
    };
  }
  return undefined;
}

/** Bounded original failure cause: one line, ≤1000 chars, no stack traces. */
function boundCause(error: string | null | undefined): string | undefined {
  if (typeof error !== "string" || error.length === 0) return undefined;
  const firstLine = error.split("\n")[0]!;
  return firstLine.length > 1000 ? firstLine.slice(0, 1000) : firstLine;
}

/** Safe next action per auto-continue failure code. */
function autoContinueSafeAction(role: string, errorCode: string | null): string {
  switch (errorCode) {
    case "release_failed":
      return `Role switched, but the queued prompt could not be released; run bb team resume`;
    case "delivery_uncertain":
      return `Prompt delivery is uncertain; run bb team resume`;
    case "replacement_unfinished":
      return `Retry bb team replace ${role} to resume the durable intent, or --abort before the switch`;
    case "task_reassigned":
      return `The package moved to another role; no automatic replacement of the old session — inspect the tracker, then replace or re-checkpoint by hand`;
    case "spawn_uncertain":
      return `A spawn attempt is unresolved; inspect BB for a possibly-created thread, then retry bb team replace ${role} --dry-run or abort`;
    default:
      return `Auto-continue stopped; inspect bb team doctor, then bb team replace ${role} --dry-run; the completed session is kept`;
  }
}

export function statusTone(status: string | null): StatusTone {
  switch (status) {
    case null:
      return "missing";
    case "active":
    case "starting":
    case "pending":
      return "running";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return "other";
  }
}

export function isOpenTask(status: TaskStatus): boolean {
  return status === "todo" || status === "in-progress" || status === "review";
}

/** The task a role is busy with: in-progress first, then review. */
export function currentTask(tasks: readonly TeamTask[]): TeamTask | null {
  return (
    tasks.find((task) => task.status === "in-progress") ??
    tasks.find((task) => task.status === "review") ??
    null
  );
}

/** Relative age like "3m", "2h", "5d" from epoch ms. */
export function relativeAgo(updatedAtMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.round((nowMs - updatedAtMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const minutes = Math.round(deltaSec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ──────────────────────── Hierarchy layout ──────────────────────── */

export interface GraphNode {
  key: string;
  role: string;
  title: string;
  threadId: string | null;
  status: string | null;
  tone: StatusTone;
  lead: boolean;
  task: string | null;
  helpers: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** false: the executor's parent is not the lead thread (doctor warns). */
  linked: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
}

const NODE_W = 168;
const NODE_H = 52;
const GAP_X = 20;
const GAP_Y = 56;
const PAD = 8;

/**
 * Lay the team out as a two-level tree: the lead thread(s) on top, every
 * executor thread below. A role without a thread becomes a "missing" node,
 * so the picture also shows what bb team create would still spawn.
 */
export function layoutHierarchy(snapshot: TeamSnapshot): GraphLayout {
  const top: GraphNode[] = [];
  const bottom: GraphNode[] = [];
  for (const role of snapshot.roles) {
    if (!role.enabled && role.threads.length === 0) continue;
    const task = currentTask(role.tasks);
    const base = {
      role: role.name,
      lead: role.lead,
      task: task ? `#${task.id} ${task.title}` : null,
      helpers: role.helpers?.length ?? 0,
      x: 0,
      y: 0,
    };
    const row = role.lead ? top : bottom;
    if (role.threads.length === 0) {
      row.push({
        ...base,
        key: `${role.name}:missing`,
        title: role.title,
        threadId: null,
        status: null,
        tone: "missing",
      });
      continue;
    }
    for (const thread of role.threads) {
      row.push({
        ...base,
        key: `${role.name}:${thread.threadId}`,
        title: thread.title || role.title,
        threadId: thread.threadId,
        status: thread.status,
        tone: statusTone(thread.status),
      });
    }
  }

  const rowWidth = (count: number) =>
    count === 0 ? 0 : count * NODE_W + (count - 1) * GAP_X;
  const width = Math.max(rowWidth(top.length), rowWidth(bottom.length), NODE_W) + PAD * 2;
  const place = (row: GraphNode[], y: number) => {
    const offset = (width - rowWidth(row.length)) / 2;
    row.forEach((node, index) => {
      node.x = Math.round(offset + index * (NODE_W + GAP_X));
      node.y = y;
    });
  };
  place(top, PAD);
  place(bottom, top.length > 0 ? PAD + NODE_H + GAP_Y : PAD);

  const edges: GraphEdge[] = [];
  const leadNode = top.find((node) => node.threadId !== null) ?? top[0];
  if (leadNode) {
    const threadParents = new Map<string, string | null>();
    for (const role of snapshot.roles) {
      for (const thread of role.threads) threadParents.set(thread.threadId, thread.parentThreadId);
    }
    for (const node of bottom) {
      const parent = node.threadId ? threadParents.get(node.threadId) ?? null : null;
      edges.push({
        from: leadNode.key,
        to: node.key,
        linked: node.threadId === null || (leadNode.threadId !== null && parent === leadNode.threadId),
      });
    }
  }

  const rows = (top.length > 0 ? 1 : 0) + (bottom.length > 0 ? 1 : 0);
  const height = rows === 0 ? 0 : PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y;
  return {
    nodes: [...top, ...bottom],
    edges,
    width,
    height,
    nodeWidth: NODE_W,
    nodeHeight: NODE_H,
  };
}
