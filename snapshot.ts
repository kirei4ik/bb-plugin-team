// Team snapshot: the shared, serializable picture of a project's team.
// Pure module (no SDK, no node APIs): the server builds it, the CLI report
// renders it, and the Team panel (app.tsx) draws it.

export type Language = "en" | "ru";

export const TASK_STATUSES = ["todo", "in-progress", "review", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TeamTask {
  id: number;
  role: string;
  title: string;
  status: TaskStatus;
  note: string | null;
  createdAtMs: number;
  updatedAtMs: number;
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
  roles: SnapshotRole[];
  generatedAtMs: number;
}

export type StatusTone = "running" | "idle" | "error" | "missing" | "other";

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
