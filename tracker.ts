// Task tracker for team work packages: the built-in kv store or the
// project's existing Beads (bd) database.
//
// Selection per project:
// - `bb.storage.kv` row `tracker:<projectId>` holds a project override
//   ("beads" | "builtin"); `setConfig(null)` clears it.
// - Without an override the caller-provided `defaultTracker()` decides
//   (the server derives it from settings; default Beads is set there).
//
// Built-in path: the existing pure store operations from tasks.ts under the
// existing kv key `tasks:<projectId>:<team>` — existing data is preserved and
// no duplicate cards are created. The checkpoint rides in the task row
// (`TeamTask.checkpoint`).
//
// Beads path: every operation runs `bd --sandbox --json -C <canonical
// checkout>` through this plugin's host entry on the workspace's hostId. The
// database is owned by the user; the tracker never migrates, syncs, or
// falls back — a failing bd command is an explicit error. The only
// initialization path is `prepare`: it proves the database is absent (bd's
// own "no beads database found" signal), then runs the host's fixed-argv
// `bdInit` in the canonical checkout — never in an execution worktree and
// never a second database. The fixed init is `--stealth`, so no git
// commit is made and no user file is touched. Damage, unavailability, or
// a missing bd binary are explicit errors; prepare never tries to repair
// them. Team work
// packages are issues labeled `bb-team:<team>` (this label convention is the
// shared contract with the bd CLI), with `assignee` carrying the role name.
// Priority, acceptance criteria, design, notes, and dependency ids are
// exposed as a read-only projection (TeamTask.priority/criteria/decisions/
// result/dependencies); content, status, and checkpoints live only in
// Beads — no kv copies are kept.
//
// Status projection (Team ⇄ Beads):
//   todo ⇄ open           in-progress ⇄ in_progress
//   review ⇄ in_progress + label bb-state:review   (cleared on other transitions)
//   done ⇄ closed         dropped ⇄ closed + label bb-state:dropped
// A closed issue without the dropped label is `done` by default. bd's
// blocked/deferred statuses project to in-progress/todo and are never ready.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Workspace } from "./core";
import { hostContract } from "./host-contract";
import { addTask, applyTaskReview, findTask, listTasks, normalizeTaskStore, removeTask, taskKey, updateTask, type TaskStore } from "./tasks";
import { mergeReviewRecord, normalizeReviewRecord, reviewRecordDamage } from "./review";
import { type TaskId, type TeamTask, type TaskStatus } from "./snapshot";

export type TrackerKind = "beads" | "builtin";

/** Scope of a tracker operation: the project's canonical checkout plus team. */
export interface TrackerScope extends Workspace {
  team: string;
}

export interface TaskTracker {
  getConfig(
    workspace: Workspace,
  ): Promise<{ kind: TrackerKind; override: TrackerKind | null }>;
  setConfig(workspace: Workspace, kind: TrackerKind | null): Promise<void>;
  read(scope: TrackerScope): Promise<TaskStore>;
  add(
    scope: TrackerScope,
    input: {
      role: string;
      title: string;
      note: string | null;
      status: TaskStatus;
    },
  ): Promise<TeamTask>;
  update(
    scope: TrackerScope,
    id: TaskId,
    patch: { status?: TaskStatus; title?: string; note?: string | null },
  ): Promise<{ task: TeamTask; previous: TeamTask }>;
  remove(scope: TrackerScope, id: TaskId): Promise<TeamTask>;
  /** Ready TODO ids; Beads dependencies, blocked/deferred/review excluded. */
  ready(scope: TrackerScope): Promise<TaskId[]>;
  /**
   * Minimal idempotent prepare of the selected backend's storage for the
   * scope's canonical checkout on its source host (the caller must pass the
   * canonical workspace; an execution worktree is refused by the host).
   * Built-in: a no-op returning "ready". Beads: probe with read-only bd
   * commands — an absent database (bd's own signal) is initialized with the
   * fixed `bd init --non-interactive --skip-agents --skip-hooks
   * --init-if-missing`, a usable existing one is reused; damage,
   * unavailability, a missing bd binary, or a failing init are explicit
   * errors with no repair and no fallback. Concurrent prepares on one
   * workspace are serialized; bd's `--init-if-missing` keeps cross-process
   * runs duplicate-free. The fixed init argv is `--non-interactive
   * --skip-agents --skip-hooks --stealth --init-if-missing`: no git commit,
   * no AGENTS.md, no hooks, no touched user files.
   */
  prepare(scope: TrackerScope): Promise<TrackerPrepareResult>;
  readCheckpoint(scope: TrackerScope, id: TaskId): Promise<unknown | null>;
  writeCheckpoint(
    scope: TrackerScope,
    id: TaskId,
    checkpoint: unknown,
  ): Promise<void>;
  /**
   * bbt-iwi.2: merge the executor's review submission and/or an acceptance
   * decision into the task in the selected tracker (Beads metadata keys
   * bbTeamSubmission/bbTeamAcceptance via --metadata merge; the task row on
   * built-in). Append-only; never a duplicate kv record.
   */
  review(
    scope: TrackerScope,
    id: TaskId,
    patch: { submission?: unknown; decision?: unknown },
  ): Promise<TeamTask>;
}

export interface TaskTrackerOptions {
  defaultTracker: () => Promise<TrackerKind>;
  /** Notify listeners that the project's task picture changed. */
  publish: (projectId: string) => void;
}

/** Outcome of TaskTracker.prepare. */
export interface TrackerPrepareResult {
  /** "ready": an existing database is usable (built-in needs nothing); "created": this call initialized the previously missing database. */
  status: "ready" | "created";
}

/* ──────────────────────── Shared bits ──────────────────────── */

const TASK_NOT_FOUND_RE = /not found|no issue found/i;
const BD_TIMEOUT_MS = 120_000;
/** bd's own structured signals that no database exists in the directory. */
const BD_ABSENT_JSON_ERROR = "no_beads_directory";
const BD_ABSENT_STDERR_RE = /no beads database found/i;
/**
 * Error code for "bd itself reports that no database exists". Callers may
 * degrade to an empty task list and offer `prepare` instead of failing.
 */
export const TRACKER_ABSENT_CODE = "beads_absent";

export const isTrackerAbsentError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === TRACKER_ABSENT_CODE;

/* ──────────────────────── Beads projection ──────────────────────── */

const TEAM_LABEL_PREFIX = "bb-team:";
const REVIEW_LABEL = "bb-state:review";
const DROPPED_LABEL = "bb-state:dropped";
const CHECKPOINT_METADATA_KEY = "bbTeamCheckpoint";
/** bbt-iwi.2: review submission + acceptance decisions live in Beads metadata (merge keys, other tools' keys preserved). */
const SUBMISSION_METADATA_KEY = "bbTeamSubmission";
const ACCEPTANCE_METADATA_KEY = "bbTeamAcceptance";

/** One row of `bd list --json` / `bd show --json` (subset this module reads). */
interface BdIssue {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  assignee?: string;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
  priority?: number;
  acceptance_criteria?: string;
  design?: string;
  notes?: string;
  metadata?: { [key: string]: unknown } | null;
}

/** One record of `bd dep list --json` for several issues (raw record form). */
interface BdDependencyRecord {
  issue_id?: string;
  depends_on_id?: string;
}

const toMs = (value: string | undefined): number => {
  const ms = Date.parse(value ?? "");
  return Number.isNaN(ms) ? 0 : ms;
};

const bdStatusToTeam = (
  status: string | undefined,
  labels: string[],
): TaskStatus => {
  switch (status) {
    case "closed":
      return labels.includes(DROPPED_LABEL) ? "dropped" : "done";
    case "in_progress":
      return labels.includes(REVIEW_LABEL) ? "review" : "in-progress";
    case "blocked":
      return "in-progress";
    case "deferred":
    case "open":
    default:
      return "todo";
  }
};

const projectIssue = (issue: BdIssue): TeamTask => {
  const checkpoint = issue.metadata?.[CHECKPOINT_METADATA_KEY];
  const task: TeamTask = {
    // The stable bd id (string), never a numeric alias.
    id: issue.id,
    role: issue.assignee ?? "",
    title: issue.title ?? "",
    status: bdStatusToTeam(issue.status, issue.labels ?? []),
    note: issue.description ?? null,
    createdAtMs: toMs(issue.created_at),
    updatedAtMs: toMs(issue.updated_at),
  };
  if (checkpoint !== undefined) task.checkpoint = checkpoint;
  if (issue.metadata) {
    const review = normalizeReviewRecord({
      submission: issue.metadata[SUBMISSION_METADATA_KEY],
      decisions: issue.metadata[ACCEPTANCE_METADATA_KEY],
    });
    if (review) task.review = review;
  }
  if (typeof issue.priority === "number") task.priority = issue.priority;
  if (issue.acceptance_criteria) task.criteria = issue.acceptance_criteria;
  if (issue.design) task.decisions = issue.design;
  if (issue.notes) task.result = issue.notes;
  return task;
};

const sortTasks = (tasks: TeamTask[]): TeamTask[] =>
  tasks.sort(
    (a, b) =>
      a.createdAtMs - b.createdAtMs ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );

/** bd update arguments for a Team status (labels are managed add/remove). */
const updateStatusArgs = (status: TaskStatus): string[] => {
  switch (status) {
    case "todo":
      return [
        "-s",
        "open",
        "--remove-label",
        REVIEW_LABEL,
        "--remove-label",
        DROPPED_LABEL,
      ];
    case "in-progress":
      return [
        "-s",
        "in_progress",
        "--remove-label",
        REVIEW_LABEL,
        "--remove-label",
        DROPPED_LABEL,
      ];
    case "review":
      return [
        "-s",
        "in_progress",
        "--add-label",
        REVIEW_LABEL,
        "--remove-label",
        DROPPED_LABEL,
      ];
    case "done":
      return [
        "-s",
        "closed",
        "--remove-label",
        REVIEW_LABEL,
        "--remove-label",
        DROPPED_LABEL,
      ];
    case "dropped":
      return [
        "-s",
        "closed",
        "--add-label",
        DROPPED_LABEL,
        "--remove-label",
        REVIEW_LABEL,
      ];
  }
};

/** bd create arguments for a Team status (create takes only -s and -l). */
const createStatusArgs = (status: TaskStatus): string[] => {
  switch (status) {
    case "in-progress":
      return ["-s", "in_progress"];
    case "review":
      return ["-s", "in_progress", "-l", REVIEW_LABEL];
    case "done":
      return ["-s", "closed"];
    case "dropped":
      return ["-s", "closed", "-l", DROPPED_LABEL];
    case "todo":
      return [];
  }
};

/* ──────────────────────── Factory ──────────────────────── */

export function createTaskTracker(
  bb: BbPluginApi,
  options: TaskTrackerOptions,
): TaskTracker {
  const kv = bb.storage.kv;
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });

  /* ── Kind selection: per-project override in kv ── */

  const overrideKey = (projectId: string) => `tracker:${projectId}`;

  const readOverride = async (
    projectId: string,
  ): Promise<TrackerKind | null> => {
    const raw = await kv.get<unknown>(overrideKey(projectId));
    return raw === "beads" || raw === "builtin" ? raw : null;
  };

  /* ── Serialization locks (read-modify-write and prepare safety) ── */

  const chain = <T>(
    locks: Map<string, Promise<void>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => gate);
    locks.set(key, chained);
    return (async () => {
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(key) === chained) locks.delete(key);
      }
    })();
  };

  /** Per project+team mutation lock (read-modify-write safety). */
  const mutationLocks = new Map<string, Promise<void>>();
  const withLock = <T>(scope: TrackerScope, fn: () => Promise<T>): Promise<T> =>
    chain(mutationLocks, `${scope.projectId}:${scope.team}`, fn);

  /** Per host+path prepare lock: concurrent prepares never double-init. */
  const prepareLocks = new Map<string, Promise<void>>();
  const withPrepareLock = <T>(
    workspace: Workspace,
    fn: () => Promise<T>,
  ): Promise<T> =>
    chain(prepareLocks, `${workspace.hostId}|${workspace.path}`, fn);

  /* ── bd runner: explicit errors, never fallback ── */

  const bdRaw = async (
    workspace: Workspace,
    args: string[],
  ): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> => {
    try {
      return await hostClient.call(
        "bd",
        { cwd: workspace.path, args },
        {
          hostId: workspace.hostId,
          timeoutMs: BD_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw new Error(
        `bd ${args[0]} is unavailable on host ${workspace.hostId} (${workspace.path}): ${(error as Error).message}`,
      );
    }
  };

  const bd = async (workspace: Workspace, args: string[]): Promise<unknown> => {
    const result = await bdRaw(workspace, args);
    if (!result.ok) {
      const stderr = result.stderr.trim();
      if (TASK_NOT_FOUND_RE.test(stderr)) {
        throw new Error(`beads task not found: ${stderr.split("\n")[0]}`);
      }
      const failed = new Error(
        `bd ${args[0]} failed (exit ${result.exitCode}) in ${workspace.path}: ${stderr || "no stderr"}`,
      );
      if (BD_ABSENT_STDERR_RE.test(stderr)) {
        throw Object.assign(failed, { code: TRACKER_ABSENT_CODE });
      }
      throw failed;
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `bd ${args[0]} returned invalid JSON in ${workspace.path}`,
      );
    }
  };

  const bdOne = async (
    workspace: Workspace,
    args: string[],
  ): Promise<BdIssue> => {
    const parsed = await bd(workspace, args);
    if (Array.isArray(parsed)) return parsed[0] as BdIssue;
    return parsed as BdIssue;
  };

  const showIssue = (scope: TrackerScope, id: TaskId): Promise<BdIssue> =>
    bdOne(scope, ["show", String(id)]);

  /**
   * Dependency ids per task via batched read-only `bd dep list` (≤16 ids
   * per call). With several ids bd returns raw records (issue_id →
   * depends_on_id); with one id it returns the depended-on issues —
   * handle both shapes. Failures never break reading the task list.
   */
  const readDependencies = async (
    scope: TrackerScope,
    ids: string[],
  ): Promise<Map<string, string[]>> => {
    const map = new Map<string, string[]>();
    for (let start = 0; start < ids.length; start += 16) {
      const batch = ids.slice(start, start + 16);
      let rows: Array<{
        issue_id?: string;
        depends_on_id?: string;
        id?: string;
      }>;
      try {
        rows = (await bd(scope, ["dep", "list", ...batch])) as Array<{
          issue_id?: string;
          depends_on_id?: string;
          id?: string;
        }>;
      } catch {
        // Dependencies are projection sugar; a lookup failure must not
        // break reading the task list.
        continue;
      }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row.issue_id && row.depends_on_id) {
          const list = map.get(row.issue_id) ?? [];
          list.push(row.depends_on_id);
          map.set(row.issue_id, list);
        } else if (batch.length === 1 && row.id) {
          const list = map.get(batch[0]!) ?? [];
          list.push(row.id);
          map.set(batch[0]!, list);
        }
      }
    }
    return map;
  };

  /* ── Built-in backend: existing tasks.ts store under tasks:<projectId>:<team> ── */

  const builtinRead = async (scope: TrackerScope): Promise<TaskStore> =>
    normalizeTaskStore(
      await kv.get<unknown>(taskKey(scope.projectId, scope.team)),
    );

  const builtinWrite = async (
    scope: TrackerScope,
    store: TaskStore,
  ): Promise<void> => {
    await kv.set(taskKey(scope.projectId, scope.team), store);
  };

  /* ── Public API ── */

  const getConfig = async (workspace: Workspace) => {
    const override = await readOverride(workspace.projectId);
    return { kind: override ?? (await options.defaultTracker()), override };
  };

  const setConfig = async (
    workspace: Workspace,
    kind: TrackerKind | null,
  ): Promise<void> => {
    if (kind === null) await kv.delete(overrideKey(workspace.projectId));
    else await kv.set(overrideKey(workspace.projectId), kind);
    options.publish(workspace.projectId);
  };

  const read = async (scope: TrackerScope): Promise<TaskStore> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") return builtinRead(scope);
    const rows = (await bd(scope, [
      "list",
      "--all",
      "--limit",
      "0",
      "--label",
      `${TEAM_LABEL_PREFIX}${scope.team}`,
    ])) as BdIssue[];
    if (!Array.isArray(rows)) {
      throw new Error(`bd list did not return an array in ${scope.path}`);
    }
    const dependencies = await readDependencies(
      scope,
      rows.map((row) => row.id),
    );
    const tasks = sortTasks(rows.map(projectIssue));
    for (const task of tasks) {
      const deps = dependencies.get(String(task.id));
      if (deps && deps.length > 0) task.dependencies = [...deps];
    }
    return { nextId: 1, tasks };
  };

  const add = async (
    scope: TrackerScope,
    input: {
      role: string;
      title: string;
      note: string | null;
      status: TaskStatus;
    },
  ): Promise<TeamTask> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      return withLock(scope, async () => {
        const store = await builtinRead(scope);
        const result = addTask(store, input, Date.now());
        await builtinWrite(scope, result.store);
        options.publish(scope.projectId);
        return result.task;
      });
    }
    const args = [
      "create",
      input.title,
      "--type",
      "task",
      "-a",
      input.role,
      "-l",
      `${TEAM_LABEL_PREFIX}${scope.team}`,
    ];
    if (input.note !== null) args.push("-d", input.note);
    args.push(...createStatusArgs(input.status));
    const task = projectIssue(await bdOne(scope, args));
    options.publish(scope.projectId);
    return task;
  };

  const update = async (
    scope: TrackerScope,
    id: TaskId,
    patch: { status?: TaskStatus; title?: string; note?: string | null },
  ): Promise<{ task: TeamTask; previous: TeamTask }> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      return withLock(scope, async () => {
        const store = await builtinRead(scope);
        const result = updateTask(store, id, patch, Date.now());
        await builtinWrite(scope, result.store);
        options.publish(scope.projectId);
        return { task: result.task, previous: result.previous };
      });
    }
    return withLock(scope, async () => {
      const previous = projectIssue(await showIssue(scope, id));
      const args = ["update", String(id)];
      if (patch.title !== undefined) args.push("--title", patch.title);
      if (patch.note !== undefined) args.push("-d", patch.note ?? "");
      if (patch.status !== undefined)
        args.push(...updateStatusArgs(patch.status));
      await bd(scope, args);
      const task = projectIssue(await showIssue(scope, id));
      options.publish(scope.projectId);
      return { task, previous };
    });
  };

  const remove = async (scope: TrackerScope, id: TaskId): Promise<TeamTask> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      return withLock(scope, async () => {
        const store = await builtinRead(scope);
        const result = removeTask(store, id);
        await builtinWrite(scope, result.store);
        options.publish(scope.projectId);
        return result.task;
      });
    }
    return withLock(scope, async () => {
      const task = projectIssue(await showIssue(scope, id));
      // --force deletes without the interactive preview; never --cascade.
      await bd(scope, ["delete", String(id), "--force"]);
      options.publish(scope.projectId);
      return task;
    });
  };

  const ready = async (scope: TrackerScope): Promise<TaskId[]> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      const store = await builtinRead(scope);
      // No dependency model: every TODO is ready, oldest first.
      return listTasks(store)
        .filter((task) => task.status === "todo")
        .map((task) => task.id);
    }
    // bd ready applies blocker-aware semantics and excludes in_progress
    // (hence review), blocked, deferred, and hooked issues. Keep the CLI's
    // readiness order; exclude any review-labelled stragglers defensively.
    const rows = (await bd(scope, [
      "ready",
      "--limit",
      "0",
      "--label",
      `${TEAM_LABEL_PREFIX}${scope.team}`,
    ])) as BdIssue[];
    if (!Array.isArray(rows)) {
      throw new Error(`bd ready did not return an array in ${scope.path}`);
    }
    return rows
      .filter((row) => !(row.labels ?? []).includes(REVIEW_LABEL))
      .map((row) => row.id);
  };

  const readCheckpoint = async (
    scope: TrackerScope,
    id: TaskId,
  ): Promise<unknown | null> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      const task = findTask(await builtinRead(scope), id);
      return task.checkpoint ?? null;
    }
    const issue = await showIssue(scope, id);
    const checkpoint = issue.metadata?.[CHECKPOINT_METADATA_KEY];
    return checkpoint === undefined ? null : checkpoint;
  };

  const writeCheckpoint = async (
    scope: TrackerScope,
    id: TaskId,
    checkpoint: unknown,
  ): Promise<void> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      await withLock(scope, async () => {
        const store = await builtinRead(scope);
        const task = findTask(store, id);
        task.checkpoint = checkpoint;
        await builtinWrite(scope, store);
      });
      return;
    }
    // --metadata merges top-level keys, so other tools' metadata keys and
    // every other bbTeamCheckpoint-unrelated entry are preserved.
    await bd(scope, [
      "update",
      String(id),
      "--metadata",
      JSON.stringify({ [CHECKPOINT_METADATA_KEY]: checkpoint }),
    ]);
  };

  const review = async (
    scope: TrackerScope,
    id: TaskId,
    patch: { submission?: unknown; decision?: unknown },
  ): Promise<TeamTask> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") {
      return withLock(scope, async () => {
        const store = await builtinRead(scope);
        const task = findTask(store, id);
        // Integrity: a damaged stored record is never overwritten by a new
        // append — the original history stays for a human decision.
        const damage = reviewRecordDamage(task.review);
        if (damage) throw new Error(damage);
        const result = applyTaskReview(store, id, patch);
        await builtinWrite(scope, result.store);
        options.publish(scope.projectId);
        return result.task;
      });
    }
    return withLock(scope, async () => {
      const issue = await showIssue(scope, id);
      const rawSubmission = issue.metadata?.[SUBMISSION_METADATA_KEY];
      const rawDecisions = issue.metadata?.[ACCEPTANCE_METADATA_KEY];
      const damage =
        rawSubmission === undefined && rawDecisions === undefined
          ? null
          : reviewRecordDamage({ submission: rawSubmission, decisions: rawDecisions });
      if (damage) throw new Error(damage);
      const existing = normalizeReviewRecord({
        submission: rawSubmission,
        decisions: rawDecisions,
      });
      const merged = mergeReviewRecord(existing, patch);
      const metadata: Record<string, unknown> = {
        [ACCEPTANCE_METADATA_KEY]: merged.decisions,
      };
      if (merged.submission) metadata[SUBMISSION_METADATA_KEY] = merged.submission;
      await bd(scope, ["update", String(id), "--metadata", JSON.stringify(metadata)]);
      const task = projectIssue(await showIssue(scope, id));
      options.publish(scope.projectId);
      return task;
    });
  };

  /*
   * ── Beads prepare ──
   *
   * Probe with read-only bd commands; bd's own signals decide absent vs.
   * present. `bd where` resolves the workspace and prints a structured
   * `no_beads_directory` JSON error when nothing exists; `bd list` then
   * proves the database actually opens (damage and unavailability surface
   * here). Absence is the only case where the fixed-argv host `bdInit` runs;
   * every other failure is an explicit error — no repair, no fallback.
   */
  const probeDatabase = async (
    workspace: Workspace,
  ): Promise<"absent" | "present"> => {
    const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
    const where = await bdRaw(workspace, ["where"]);
    if (!where.ok) {
      let absent = false;
      try {
        absent =
          (JSON.parse(where.stdout) as { error?: string }).error ===
          BD_ABSENT_JSON_ERROR;
      } catch {
        // Not bd's structured absence JSON: fall through to the stderr text.
      }
      if (!absent) absent = BD_ABSENT_STDERR_RE.test(where.stderr);
      if (absent) return "absent";
      throw new Error(
        `beads database in ${workspace.path} is present but not usable (bd where exit ${where.exitCode}): ${
          firstLine(where.stderr) || firstLine(where.stdout) || "no output"
        }`,
      );
    }
    const list = await bdRaw(workspace, ["list", "--all", "--limit", "0"]);
    if (!list.ok) {
      throw new Error(
        `beads database in ${workspace.path} is present but not usable (bd list exit ${list.exitCode}): ${
          firstLine(list.stderr) || firstLine(list.stdout) || "no output"
        }`,
      );
    }
    return "present";
  };

  const prepare = async (
    scope: TrackerScope,
  ): Promise<TrackerPrepareResult> => {
    const { kind } = await getConfig(scope);
    if (kind === "builtin") return { status: "ready" };
    return withPrepareLock(scope, async () => {
      if ((await probeDatabase(scope)) === "present") return { status: "ready" };
      let init: { ok: boolean; exitCode: number; stdout: string; stderr: string };
      try {
        init = await hostClient.call(
          "bdInit",
          { cwd: scope.path },
          { hostId: scope.hostId, timeoutMs: BD_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `bd init is unavailable on host ${scope.hostId} (${scope.path}): ${(error as Error).message}`,
        );
      }
      if (!init.ok) {
        throw new Error(
          `bd init failed (exit ${init.exitCode}) in ${scope.path}: ${
            init.stderr.trim().split("\n")[0] ||
            init.stdout.trim().split("\n")[0] ||
            "no output"
          }; no repair attempted`,
        );
      }
      if ((await probeDatabase(scope)) !== "present") {
        throw new Error(
          `bd init reported success but no usable beads database exists in ${scope.path}`,
        );
      }
      return { status: "created" };
    });
  };

  return {
    getConfig,
    setConfig,
    read,
    add,
    update,
    remove,
    ready,
    prepare,
    readCheckpoint,
    writeCheckpoint,
    review,
  };
}
