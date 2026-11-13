// Tracker tests: built-in persistence, project override/default selection,
// Beads-unavailable without fallback, Team⇄Beads projection (statuses,
// string ids), metadata preservation on checkpoints, readiness, and the
// idempotent prepare (absence vs. damage, fixed stealth init, no parent
// inheritance, concurrency).

import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import hostEntry from "./host";
import {
  createTaskTracker,
  isTrackerAbsentError,
  type TaskTracker,
  type TrackerKind,
} from "./tracker";
import type { TrackerScope } from "./tracker";
import type { Workspace } from "./core";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const run = promisify(execFile);
const bdAvailable = spawnSync("bd", ["--version"]).status === 0;

/** Direct bd call inside a test repo (fixtures only; the tracker uses RPC). */
const bd = async (cwd: string, args: (string | number)[]): Promise<unknown> =>
  JSON.parse(
    (
      await run("bd", ["--sandbox", "--json", ...args.map(String)], {
        cwd,
        maxBuffer: 32_000_000,
      })
    ).stdout,
  );

describe("task tracker", () => {
  let bb: BbPluginApi;
  let fakeHarness: ReturnType<typeof createFakePluginHost>["harness"];
  let hostHarness: ReturnType<typeof experimental_createHostEntryHarness>;
  let defaultKind: TrackerKind;
  let published: string[];
  let tracker: TaskTracker;
  const dirs: string[] = [];

  beforeEach(() => {
    hostHarness = experimental_createHostEntryHarness(hostEntry);
    const fake = createFakePluginHost({
      pluginId: "team",
      experimental_callHostRpc: (call) =>
        hostHarness.experimental_call(
          call.method as "bd",
          call.input as never,
          {
            signal: call.signal,
          },
        ),
    });
    bb = fake.bb;
    fakeHarness = fake.harness;
    defaultKind = "builtin";
    published = [];
    tracker = createTaskTracker(bb, {
      defaultTracker: async () => defaultKind,
      publish: (projectId) => published.push(projectId),
    });
  });
  afterEach(async () => {
    await hostHarness.experimental_dispose();
  });
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const tempDir = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  const workspaceOf = (projectId: string, path: string): Workspace => ({
    projectId,
    projectName: "demo",
    path,
    hostId: "host_1",
  });

  const scopeOf = (workspace: Workspace, team: string): TrackerScope => ({
    ...workspace,
    team,
  });

  describe("built-in backend", () => {
    it("preserves existing kv tasks and appends new ones", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      const scope = scopeOf(workspace, "alpha");
      await tracker.setConfig(workspace, "builtin");
      // Pre-existing data under the unchanged key tasks:<projectId>:<team>.
      await bb.storage.kv.set("tasks:p1:alpha", {
        nextId: 8,
        tasks: [
          {
            id: 7,
            role: "dev",
            title: "Old package",
            status: "in-progress",
            note: null,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
        ],
      });
      const store = await tracker.read(scope);
      expect(store.tasks.map((task) => task.id)).toEqual([7]);
      const added = await tracker.add(scope, {
        role: "dev",
        title: "New package",
        note: "details",
        status: "todo",
      });
      expect(added.id).toBe(8);
      expect(added.status).toBe("todo");
      const after = await tracker.read(scope);
      expect(after.tasks.map((task) => task.id)).toEqual([7, 8]);
      expect(after.nextId).toBe(9);
      expect(published).toContain("p1");
      const raw = await bb.storage.kv.get<{ tasks: { id: number }[] }>(
        "tasks:p1:alpha",
      );
      expect(raw?.tasks.map((task) => task.id)).toEqual([7, 8]);
    });

    it("update returns previous, remove deletes", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      const scope = scopeOf(workspace, "alpha");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Work",
        note: null,
        status: "todo",
      });
      const { task: updated, previous } = await tracker.update(scope, task.id, {
        status: "review",
        note: "in review",
      });
      expect(previous.status).toBe("todo");
      expect(updated.status).toBe("review");
      expect(updated.note).toBe("in review");
      const removed = await tracker.remove(scope, task.id);
      expect(removed.id).toBe(task.id);
      expect((await tracker.read(scope)).tasks).toEqual([]);
      await expect(tracker.remove(scope, task.id)).rejects.toThrow();
    });

    it("ready lists TODO tasks only", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      const scope = scopeOf(workspace, "alpha");
      const todo = await tracker.add(scope, {
        role: "a",
        title: "T1",
        note: null,
        status: "todo",
      });
      const inProgress = await tracker.add(scope, {
        role: "a",
        title: "T2",
        note: null,
        status: "in-progress",
      });
      const review = await tracker.add(scope, {
        role: "a",
        title: "T3",
        note: null,
        status: "review",
      });
      const done = await tracker.add(scope, {
        role: "a",
        title: "T4",
        note: null,
        status: "done",
      });
      expect(await tracker.ready(scope)).toEqual([todo.id]);
      expect(inProgress.status).toBe("in-progress");
      expect(review.status).toBe("review");
      expect(done.status).toBe("done");
    });

    it("review data rides in the existing task row and survives updates", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      const scope = scopeOf(workspace, "alpha");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Review work",
        note: null,
        status: "in-progress",
      });
      const submission = {
        id: "sub_t1",
        version: 1 as const,
        result: "Feature done",
        artifacts: ["src/a.ts"],
        checks: [{ what: "Targeted test", result: "pass" }],
        problems: [],
        submittedBy: "dev",
        atMs: 1,
      };
      const withSubmission = await tracker.review(scope, task.id, { submission });
      expect(withSubmission.review?.submission?.id).toBe("sub_t1");
      // The record stays in the task row through ordinary status updates.
      const decision = {
        decision: "accept" as const,
        reason: "checked the diff",
        decidedBy: "lead" as const,
        basis: "submission" as const,
        decidedByRole: "lead",
        submissionRef: "sub_t1",
        atMs: 2,
      };
      await tracker.review(scope, task.id, { decision });
      await tracker.update(scope, task.id, { status: "done" });
      const store = await tracker.read(scope);
      expect(store.tasks[0]!.review?.decisions).toEqual([decision]);
      expect(store.tasks[0]!.review?.submission?.id).toBe("sub_t1");
      const raw = await bb.storage.kv.get<{
        tasks: { id: number; review?: unknown }[];
      }>("tasks:p1:alpha");
      expect((raw?.tasks[0]?.review as { submission: { id: string } }).submission.id).toBe("sub_t1");
      await expect(tracker.review(scope, 999, { submission })).rejects.toThrow(/not found/i);
    });

    it("checkpoint rides in the existing task row", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      const scope = scopeOf(workspace, "alpha");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Work",
        note: null,
        status: "in-progress",
      });
      expect(await tracker.readCheckpoint(scope, task.id)).toBeNull();
      await tracker.writeCheckpoint(scope, task.id, {
        step: 1,
        files: ["a.ts"],
      });
      expect(await tracker.readCheckpoint(scope, task.id)).toEqual({
        step: 1,
        files: ["a.ts"],
      });
      const raw = await bb.storage.kv.get<{
        tasks: { id: number; checkpoint?: unknown }[];
      }>("tasks:p1:alpha");
      expect(raw?.tasks[0]?.checkpoint).toEqual({ step: 1, files: ["a.ts"] });
      await expect(
        tracker.writeCheckpoint(scope, 999, { step: 2 }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("prepare", () => {
    it("is a no-op for the built-in backend", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      expect(await tracker.prepare(scopeOf(workspace, "alpha"))).toEqual({
        status: "ready",
      });
      expect(fakeHarness.experimental_hostRpcCalls).toHaveLength(0);
    });

    describe.skipIf(!bdAvailable)("beads backend", () => {
      beforeEach(() => {
        defaultKind = "beads";
      });

      it("initializes a missing database exactly once, then reports ready", async () => {
        const dir = await tempDir("tracker-prepare-");
        const scope = scopeOf(workspaceOf("prep1", dir), "alpha");
        expect(await tracker.prepare(scope)).toEqual({ status: "created" });
        expect(existsSync(join(dir, ".beads", "config.yaml"))).toBe(true);
        // --skip-agents and --stealth: no AGENTS.md, no .gitignore edit.
        expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
        expect(existsSync(join(dir, ".gitignore"))).toBe(false);
        expect(await tracker.prepare(scope)).toEqual({ status: "ready" });
        // The fresh database is immediately usable end to end.
        const task = await tracker.add(scope, {
          role: "dev",
          title: "Prepared",
          note: null,
          status: "todo",
        });
        expect((await tracker.read(scope)).tasks.map((t) => t.id)).toEqual([
          task.id,
        ]);
      });

      it("reuses an existing database without re-initializing", async () => {
        const dir = await tempDir("tracker-prepare-existing-");
        await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
        await run(
          "bd",
          ["init", "--non-interactive", "--skip-agents", "--skip-hooks"],
          { cwd: dir },
        );
        const scope = scopeOf(workspaceOf("prep2", dir), "beta");
        const seeded = await tracker.add(scope, {
          role: "dev",
          title: "Existing",
          note: null,
          status: "todo",
        });
        expect(await tracker.prepare(scope)).toEqual({ status: "ready" });
        expect((await tracker.read(scope)).tasks.map((t) => t.id)).toEqual([
          seeded.id,
        ]);
      });

      it("concurrent prepares initialize exactly one database", async () => {
        const dir = await tempDir("tracker-prepare-race-");
        const scope = scopeOf(workspaceOf("prep3", dir), "gamma");
        const results = await Promise.all(
          Array.from({ length: 5 }, () => tracker.prepare(scope)),
        );
        expect(results.filter((r) => r.status === "created")).toHaveLength(1);
        expect(results.filter((r) => r.status === "ready")).toHaveLength(4);
        expect(existsSync(join(dir, ".beads", "config.yaml"))).toBe(true);
      });

      it("does not inherit a parent directory's database", async () => {
        const parent = await tempDir("tracker-prepare-parent-");
        await run(
          "bd",
          ["init", "--non-interactive", "--skip-agents", "--skip-hooks"],
          { cwd: parent },
        );
        await bd(parent, [
          "create",
          "Parent issue",
          "--type",
          "task",
          "-a",
          "dev",
          "-l",
          "bb-team:delta",
        ]);
        const child = join(parent, "child");
        await mkdir(child);
        const scope = scopeOf(workspaceOf("prep4", child), "delta");
        expect(await tracker.prepare(scope)).toEqual({ status: "created" });
        expect(existsSync(join(child, ".beads", "config.yaml"))).toBe(true);
        // The child sees only its own empty database, never the parent's.
        expect((await tracker.read(scope)).tasks).toEqual([]);
        const parentScope = scopeOf(workspaceOf("prep4p", parent), "delta");
        expect(
          (await tracker.read(parentScope)).tasks.map((t) => t.title),
        ).toEqual(["Parent issue"]);
      });

      it("refuses a damaged beads directory without initializing", async () => {
        const dir = await tempDir("tracker-prepare-damaged-");
        await writeFile(join(dir, ".beads"), "not a directory\n");
        const scope = scopeOf(workspaceOf("prep5", dir), "epsilon");
        await expect(tracker.prepare(scope)).rejects.toThrow(/not usable/);
        // No init ran and the damaged path is left exactly as it was.
        expect(
          fakeHarness.experimental_hostRpcCalls
            .map((call) => call.method)
            .includes("bdInit"),
        ).toBe(false);
        expect((await stat(join(dir, ".beads"))).isFile()).toBe(true);
      });

      it("reports an unavailable bd as an explicit error, without fallback", async () => {
        const failing = createFakePluginHost({
          pluginId: "team",
          experimental_callHostRpc: async () => {
            throw new Error("host unreachable");
          },
        });
        const failingTracker = createTaskTracker(failing.bb, {
          defaultTracker: async () => "beads",
          publish: () => {},
        });
        const scope = scopeOf(workspaceOf("prep6", "/ws/demo"), "zeta");
        await expect(failingTracker.prepare(scope)).rejects.toThrow(
          /bd where is unavailable on host host_1/,
        );
      });
    });
  });

  describe("tracker selection", () => {
    it("uses the default and honors the project override", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      expect(await tracker.getConfig(workspace)).toEqual({
        kind: "builtin",
        override: null,
      });
      defaultKind = "beads";
      expect(await tracker.getConfig(workspace)).toEqual({
        kind: "beads",
        override: null,
      });
      await tracker.setConfig(workspace, "beads");
      expect(await tracker.getConfig(workspace)).toEqual({
        kind: "beads",
        override: "beads",
      });
      // The override is per project.
      const other = workspaceOf("p2", "/ws/other");
      expect(await tracker.getConfig(other)).toEqual({
        kind: "beads",
        override: null,
      });
      await tracker.setConfig(workspace, null);
      expect(await tracker.getConfig(workspace)).toEqual({
        kind: "beads",
        override: null,
      });
      expect(published).toContain("p1");
    });

    it("ignores junk in the override row", async () => {
      const workspace = workspaceOf("p1", "/ws/demo");
      await bb.storage.kv.set("tracker:p1", "jira");
      expect(await tracker.getConfig(workspace)).toEqual({
        kind: "builtin",
        override: null,
      });
    });
  });

  describe.skipIf(!bdAvailable)("beads backend", () => {
    let repo: string;
    beforeAll(async () => {
      repo = await tempDir("tracker-bd-");
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("bd", ["init"], { cwd: repo });
    });
    beforeEach(() => {
      defaultKind = "beads";
    });

    it("fails explicitly without a database, without fallback", async () => {
      const empty = await tempDir("tracker-bd-empty-");
      const workspace = workspaceOf("p1", empty);
      const scope = scopeOf(workspace, "alpha");
      await tracker.setConfig(workspace, "beads");
      // Built-in data exists and must NOT be used as a fallback.
      await bb.storage.kv.set("tasks:p1:alpha", { nextId: 2, tasks: [] });
      const missing = await tracker.read(scope).catch((cause: unknown) => cause);
      // Callers may degrade to an empty package list on this exact code only.
      expect(isTrackerAbsentError(missing)).toBe(true);
      expect((missing as Error).message).toMatch(/no beads database found/);
      await expect(tracker.ready(scope)).rejects.toThrow(/bd|beads/i);
      await expect(
        tracker.add(scope, {
          role: "dev",
          title: "T",
          note: null,
          status: "todo",
        }),
      ).rejects.toThrow(/bd|beads/i);
    });

    it("projects issues to TeamTask with stable string ids and statuses", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "alpha");
      await tracker.setConfig(workspace, "beads");
      const byTitle = new Map<string, string>();
      for (const [status, title] of [
        ["todo", "Alpha todo"],
        ["in-progress", "Alpha wip"],
        ["review", "Alpha review"],
        ["done", "Alpha done"],
        ["dropped", "Alpha dropped"],
      ] as const) {
        const task = await tracker.add(scope, {
          role: "developer",
          title,
          note: title === "Alpha todo" ? "note text" : null,
          status,
        });
        expect(typeof task.id).toBe("string");
        byTitle.set(title, String(task.id));
      }
      const store = await tracker.read(scope);
      expect(new Set(store.tasks.map((task) => task.id))).toEqual(
        new Set(byTitle.values()),
      );
      const statuses = new Map(
        store.tasks.map((task) => [task.title, task.status]),
      );
      expect(statuses.get("Alpha todo")).toBe("todo");
      expect(statuses.get("Alpha wip")).toBe("in-progress");
      expect(statuses.get("Alpha review")).toBe("review");
      expect(statuses.get("Alpha done")).toBe("done");
      expect(statuses.get("Alpha dropped")).toBe("dropped");
      const todo = store.tasks.find((task) => task.title === "Alpha todo")!;
      expect(todo.role).toBe("developer");
      expect(todo.note).toBe("note text");
      // Team label and role assignee are visible to the plain CLI.
      const [issue] = (await bd(repo, ["show", todo.id])) as [
        { labels: string[]; assignee: string },
      ];
      expect(issue.labels).toContain("bb-team:alpha");
      expect(issue.assignee).toBe("developer");
    });

    it("moves statuses and clears review/dropped labels on other transitions", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "beta");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Flow",
        note: null,
        status: "todo",
      });
      const labels = async (): Promise<string[]> =>
        ((await bd(repo, ["show", task.id])) as [{ labels?: string[] }])[0]
          ?.labels ?? [];
      await tracker.update(scope, task.id, { status: "review" });
      expect(await labels()).toContain("bb-state:review");
      expect((await tracker.read(scope)).tasks[0]!.status).toBe("review");
      const { previous } = await tracker.update(scope, task.id, {
        status: "in-progress",
      });
      expect(previous.status).toBe("review");
      expect(await labels()).not.toContain("bb-state:review");
      // Closing an assigned in-progress task needs no --force: the tracker
      // never bypasses a live claim implicitly.
      await tracker.update(scope, task.id, { status: "done" });
      const assignedDone = (await tracker.read(scope)).tasks[0]!;
      expect(assignedDone.status).toBe("done");
      expect(assignedDone.role).toBe("dev");
      expect(await labels()).toEqual(["bb-team:beta"]);
      await tracker.update(scope, task.id, { status: "todo" });
      expect((await tracker.read(scope)).tasks[0]!.status).toBe("todo");
      await tracker.update(scope, task.id, { status: "dropped" });
      expect(await labels()).toContain("bb-state:dropped");
      expect((await tracker.read(scope)).tasks[0]!.status).toBe("dropped");
      await tracker.update(scope, task.id, { status: "todo" });
      expect(await labels()).toEqual(["bb-team:beta"]);
      expect((await tracker.read(scope)).tasks[0]!.status).toBe("todo");
      await tracker.update(scope, task.id, {
        status: "done",
        title: "Flow done",
      });
      const done = (await tracker.read(scope)).tasks[0]!;
      expect(done.status).toBe("done");
      expect(done.title).toBe("Flow done");
    });

    it("ready excludes dependents, in-progress, review, blocked, and deferred", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "gamma");
      const base = await tracker.add(scope, {
        role: "dev",
        title: "Base",
        note: null,
        status: "todo",
      });
      // Dependents and foreign statuses, created with the plain CLI.
      await bd(repo, [
        "create",
        "Dependent",
        "--type",
        "task",
        "-l",
        "bb-team:gamma",
        "--deps",
        String(base.id),
      ]);
      const inProgress = await tracker.add(scope, {
        role: "dev",
        title: "Wip",
        note: null,
        status: "in-progress",
      });
      const review = await tracker.add(scope, {
        role: "dev",
        title: "In review",
        note: null,
        status: "review",
      });
      const blocked = (await bd(repo, [
        "create",
        "Blocked",
        "-s",
        "blocked",
        "-l",
        "bb-team:gamma",
      ])) as { id: string };
      const deferredIssue = (await bd(repo, [
        "create",
        "Deferred",
        "-l",
        "bb-team:gamma",
      ])) as { id: string };
      await bd(repo, ["defer", deferredIssue.id, "--until=+1d"]);

      const ready = await tracker.ready(scope);
      expect(ready).toEqual([base.id]);
      expect(ready).not.toContain(inProgress.id);
      expect(ready).not.toContain(review.id);
      expect(ready).not.toContain(blocked.id);
      expect(ready).not.toContain(deferredIssue.id);
      // Readiness follows the CLI's own (priority) order, unsorted by us.
      const cliReady = (await bd(repo, [
        "ready",
        "--limit",
        "0",
        "--label",
        "bb-team:gamma",
      ])) as Array<{ id: string }>;
      expect(ready).toEqual(cliReady.map((row) => row.id));
    });

    it("stores the checkpoint in metadata, preserving other tools' keys", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "delta");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Checkpointed",
        note: null,
        status: "todo",
      });
      expect(await tracker.readCheckpoint(scope, task.id)).toBeNull();
      await bd(repo, [
        "update",
        String(task.id),
        "--metadata",
        '{"foreignTool":"keep","other":{"nested":true}}',
      ]);
      await tracker.writeCheckpoint(scope, task.id, {
        step: 1,
        files: ["a.ts"],
      });
      expect(await tracker.readCheckpoint(scope, task.id)).toEqual({
        step: 1,
        files: ["a.ts"],
      });
      const [issue] = (await bd(repo, ["show", task.id])) as [
        { metadata: Record<string, unknown> },
      ];
      expect(issue.metadata.foreignTool).toBe("keep");
      expect(issue.metadata.other).toEqual({ nested: true });
      expect(issue.metadata.bbTeamCheckpoint).toEqual({
        step: 1,
        files: ["a.ts"],
      });
      await tracker.writeCheckpoint(scope, task.id, { step: 2 });
      const [updated] = (await bd(repo, ["show", task.id])) as [
        { metadata: Record<string, unknown> },
      ];
      expect(updated.metadata.bbTeamCheckpoint).toEqual({ step: 2 });
      expect(updated.metadata.foreignTool).toBe("keep");
      // The projection carries the checkpoint without an extra bd show.
      const store = await tracker.read(scope);
      expect(store.tasks[0]!.checkpoint).toEqual({ step: 2 });
    });

    it("stores review data in metadata, preserving other tools' keys", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "iota");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Reviewed",
        note: null,
        status: "todo",
      });
      await bd(repo, [
        "update",
        String(task.id),
        "--metadata",
        '{"foreignTool":"keep"}',
      ]);
      const submission = {
        id: "sub_b1",
        version: 1 as const,
        result: "Report done",
        artifacts: [],
        checks: [{ what: "Read-back check", result: "matches" }],
        problems: [],
        submittedBy: "dev",
        atMs: 1,
      };
      await tracker.review(scope, task.id, { submission });
      const decision = {
        decision: "accept" as const,
        reason: "report is grounded",
        decidedBy: "lead" as const,
        basis: "submission" as const,
        submissionRef: "sub_b1",
        atMs: 2,
      };
      await tracker.review(scope, task.id, { decision });
      const [issue] = (await bd(repo, ["show", task.id])) as [
        { metadata: Record<string, unknown> },
      ];
      expect(issue.metadata.foreignTool).toBe("keep");
      expect(
        (issue.metadata.bbTeamSubmission as { id: string }).id,
      ).toBe("sub_b1");
      expect(issue.metadata.bbTeamAcceptance).toEqual([decision]);
      // The projection carries the whole record without an extra bd show.
      const store = await tracker.read(scope);
      expect(store.tasks[0]!.review?.submission?.id).toBe("sub_b1");
      expect(store.tasks[0]!.review?.decisions).toEqual([decision]);
      expect(store.tasks[0]!.checkpoint).toBeUndefined();
    });

    it("remove deletes the issue and reports it", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "epsilon");
      const task = await tracker.add(scope, {
        role: "dev",
        title: "Doomed",
        note: null,
        status: "todo",
      });
      const removed = await tracker.remove(scope, task.id);
      expect(removed.title).toBe("Doomed");
      expect((await tracker.read(scope)).tasks).toEqual([]);
      await expect(bd(repo, ["show", String(task.id)])).rejects.toThrow();
      await expect(tracker.remove(scope, task.id)).rejects.toThrow(
        /not found/i,
      );
    });

    it("projects priority, criteria, decisions, result, and dependencies", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "eta");
      const blocker = await tracker.add(scope, {
        role: "dev",
        title: "Blocker",
        note: null,
        status: "todo",
      });
      const rich = (await bd(repo, [
        "create",
        "Rich",
        "-l",
        "bb-team:eta",
        "-p",
        "1",
        "--acceptance",
        "It works",
        "--design",
        "Use a hash",
        "--notes",
        "Ran twice",
      ])) as { id: string };
      await bd(repo, ["dep", "add", rich.id, blocker.id]);
      const store = await tracker.read(scope);
      const task = store.tasks.find((item) => item.id === rich.id)!;
      expect(task.priority).toBe(1);
      expect(task.criteria).toBe("It works");
      expect(task.decisions).toBe("Use a hash");
      expect(task.result).toBe("Ran twice");
      expect(task.dependencies).toEqual([blocker.id]);
      // No dependencies → the field stays absent.
      const plain = store.tasks.find((item) => item.id === blocker.id)!;
      expect("dependencies" in plain).toBe(false);
    });

    it("reaches the host entry with the workspace hostId", async () => {
      const workspace = workspaceOf("p1", repo);
      const scope = scopeOf(workspace, "zeta");
      await tracker.setConfig(workspace, "beads");
      await tracker.read(scope);
      const calls = fakeHarness.experimental_hostRpcCalls;
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1]!;
      expect(last.method).toBe("bd");
      expect(last.hostId).toBe("host_1");
      expect((last.input as { cwd: string }).cwd).toBe(repo);
      expect((last.input as { args: string[] }).args[0]).toBe("list");
    });
  });
});
