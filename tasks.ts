// Work packages ("tasks") of a team: pure store operations.
// The server keeps one store per project in bb.storage.kv under taskKey().

import { TASK_STATUSES, isOpenTask, type TaskStatus, type TeamTask } from "./snapshot";

export interface TaskStore {
  nextId: number;
  tasks: TeamTask[];
}

/** Closed tasks kept per project; older ones are pruned (kv values ≤256KB). */
export const CLOSED_TASKS_KEPT = 200;
export const TASK_TITLE_MAX = 300;
export const TASK_NOTE_MAX = 2000;

export class TaskError extends Error {
  constructor(
    readonly code: "task_not_found" | "task_invalid",
    message: string,
  ) {
    super(message);
  }
}

export function taskKey(projectId: string, team: string): string {
  return `tasks:${projectId}:${team}`;
}

export function emptyTaskStore(): TaskStore {
  return { nextId: 1, tasks: [] };
}

/** Accept whatever kv returned; fall back to an empty store on junk. */
export function normalizeTaskStore(raw: unknown): TaskStore {
  if (!raw || typeof raw !== "object") return emptyTaskStore();
  const value = raw as Partial<TaskStore>;
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.filter(
        (task): task is TeamTask =>
          !!task &&
          typeof task.id === "number" &&
          typeof task.role === "string" &&
          typeof task.title === "string" &&
          (TASK_STATUSES as readonly string[]).includes(task.status),
      )
    : [];
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  const nextId =
    typeof value.nextId === "number" && value.nextId > maxId ? value.nextId : maxId + 1;
  return { nextId, tasks };
}

export function parseTaskStatus(value: string): TaskStatus {
  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  const alias: Record<string, TaskStatus> = {
    open: "todo",
    new: "todo",
    start: "in-progress",
    started: "in-progress",
    progress: "in-progress",
    wip: "in-progress",
    accepted: "done",
    closed: "done",
    cancel: "dropped",
    cancelled: "dropped",
    canceled: "dropped",
  };
  const status = (alias[normalized] ?? normalized) as TaskStatus;
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new TaskError(
      "task_invalid",
      `unknown task status "${value}" (${TASK_STATUSES.join(" | ")})`,
    );
  }
  return status;
}

function cleanTitle(title: string): string {
  const value = title.replace(/\s+/g, " ").trim();
  if (!value) throw new TaskError("task_invalid", "task title is empty");
  return value.slice(0, TASK_TITLE_MAX);
}

function cleanNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const value = note.trim();
  return value ? value.slice(0, TASK_NOTE_MAX) : null;
}

function prune(tasks: TeamTask[]): TeamTask[] {
  const closed = tasks.filter((task) => !isOpenTask(task.status));
  if (closed.length <= CLOSED_TASKS_KEPT) return tasks;
  const drop = new Set(
    closed
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
      .slice(0, closed.length - CLOSED_TASKS_KEPT)
      .map((task) => task.id),
  );
  return tasks.filter((task) => !drop.has(task.id));
}

export function addTask(
  store: TaskStore,
  input: { role: string; title: string; note?: string | null; status?: TaskStatus },
  nowMs: number,
): { store: TaskStore; task: TeamTask } {
  const task: TeamTask = {
    id: store.nextId,
    role: input.role,
    title: cleanTitle(input.title),
    status: input.status ?? "todo",
    note: cleanNote(input.note),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  return {
    store: { nextId: store.nextId + 1, tasks: prune([...store.tasks, task]) },
    task,
  };
}

export function findTask(store: TaskStore, id: number): TeamTask {
  const task = store.tasks.find((item) => item.id === id);
  if (!task) throw new TaskError("task_not_found", `task #${id} not found`);
  return task;
}

export function updateTask(
  store: TaskStore,
  id: number,
  patch: { status?: TaskStatus; title?: string; note?: string | null; role?: string },
  nowMs: number,
): { store: TaskStore; task: TeamTask; previous: TeamTask } {
  const previous = findTask(store, id);
  const task: TeamTask = {
    ...previous,
    status: patch.status ?? previous.status,
    title: patch.title !== undefined ? cleanTitle(patch.title) : previous.title,
    note: patch.note !== undefined ? cleanNote(patch.note) : previous.note,
    role: patch.role ?? previous.role,
    updatedAtMs: nowMs,
  };
  return {
    store: {
      nextId: store.nextId,
      tasks: prune(store.tasks.map((item) => (item.id === id ? task : item))),
    },
    task,
    previous,
  };
}

export function removeTask(store: TaskStore, id: number): { store: TaskStore; task: TeamTask } {
  const task = findTask(store, id);
  return {
    store: { nextId: store.nextId, tasks: store.tasks.filter((item) => item.id !== id) },
    task,
  };
}

export function listTasks(
  store: TaskStore,
  filter: { role?: string; includeClosed?: boolean } = {},
): TeamTask[] {
  return store.tasks
    .filter((task) => (filter.role ? task.role === filter.role : true))
    .filter((task) => (filter.includeClosed ? true : isOpenTask(task.status)))
    .sort((a, b) => a.id - b.id);
}

/** Open tasks of a role already in work: the "one active package" rule. */
export function busyTasks(store: TaskStore, role: string, exceptId?: number): TeamTask[] {
  return store.tasks.filter(
    (task) =>
      task.role === role &&
      task.id !== exceptId &&
      (task.status === "in-progress" || task.status === "review"),
  );
}
