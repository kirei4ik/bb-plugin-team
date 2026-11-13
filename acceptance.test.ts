// Public CLI/RPC flow with real Git worktrees and the real bd CLI; BB threads
// are deterministic SDK fixtures, so this exercises no model/provider calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import plugin from "./server";
import hostEntry from "./host";
const run = promisify(execFile);
const content = {
  goal: "Continue the profile",
  criteria: ["Profile passes acceptance"],
  progress: "Edited profile.ts",
  decisions: [{ what: "Keep the branch", why: "Preserve unfinished work" }],
  checks: [{ what: "Initial check", result: "Not run yet" }],
  blockers: [],
  nextAction: "Finish the profile",
  files: ["profile.ts"],
};

describe("standalone Team workflow (real Git and Beads, no AI)", () => {
  for (const kind of ["builtin", "beads"] as const)
    it(`${kind}: select, queue, checkpoint, replace executor and lead, accept`, async () => {
      const root = await mkdtemp(join(tmpdir(), "team-acceptance-"));
      const checkout = join(root, "project"),
        worktree = join(root, "task");
      const host = experimental_createHostEntryHarness(hostEntry);
      let harness:
        | ReturnType<typeof createFakePluginHost>["harness"]
        | undefined;
      try {
        await mkdir(checkout);
        const git = (args: string[]) => run("git", args, { cwd: checkout });
        await git(["init", "-q", "-b", "main"]);
        await git(["config", "user.name", "Acceptance"]);
        await git(["config", "user.email", "acceptance@example.invalid"]);
        await writeFile(
          join(checkout, "profile.ts"),
          "export const profile = 1;\n",
        );
        await git(["add", "profile.ts"]);
        await git(["commit", "-qm", "Initial state"]);
        await git(["worktree", "add", "-q", "-b", "task/profile", worktree]);
        const originalHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
        await mkdir(join(checkout, ".bb", "teams"), { recursive: true });
        await writeFile(
          join(checkout, ".bb", "teams", "main.yaml"),
          "version: 1\nroles:\n  - name: lead\n    lead: true\n    prompt: Coordinate the work.\n  - name: dev\n    prompt: Implement the package.\n",
        );
        await writeFile(
          join(worktree, "profile.ts"),
          "export const profile = 2; // unfinished\n",
        );
        await writeFile(
          join(worktree, "checkpoint.json"),
          JSON.stringify(content),
        );
        const threads = new Map<
          string,
          {
            id: string;
            parentThreadId: string | null;
            archivedAt: number | null;
            status: "idle" | "active";
            metadata: Record<string, unknown>;
          }
        >();
        for (const [id, role, parent] of [
          ["thr_lead", "lead", null],
          ["thr_dev", "dev", "thr_lead"],
          ["thr_helper", null, "thr_dev"],
        ] as const)
          threads.set(id, {
            id,
            parentThreadId: parent,
            archivedAt: null,
            status: "idle",
            metadata: role
              ? { teamName: "main", teamRole: role }
              : { teamName: "main", teamHelperOf: "dev" },
          });
        const response = (id: string) => {
          const t = threads.get(id)!;
          return makeThreadResponse({
            id: t.id,
            projectId: "proj_flow",
            environmentId: "env_task",
            environmentPath: worktree,
            environmentHostId: "host_local",
            status: t.status,
            parentThreadId: t.parentThreadId,
            archivedAt: t.archivedAt,
            providerId: "pi",
          });
        };
        const queued = new Map<
          string,
          { type: "text"; text: string; mentions: [] }[]
        >();
        const sent: { threadId: string; text: string }[] = [];
        let spawnCount = 0;
        const fake = createFakePluginHost({
          pluginId: "team",
          experimental_hostEntry: true,
          settings: { defaultTracker: kind, teamSection: false, roster: false },
          experimental_callHostRpc: (call) =>
            host.experimental_call(call.method as never, call.input as never, {
              signal: call.signal,
            }),
          sdk: {
            system: { config: async () => ({ primaryHostId: "host_local" }) },
            projects: {
              list: async () => [
                {
                  id: "proj_flow",
                  name: "flow",
                  kind: "standard",
                  createdAt: 0,
                  updatedAt: 0,
                  gitRemoteUrl: null,
                  sources: [
                    {
                      id: "source",
                      projectId: "proj_flow",
                      hostId: "host_local",
                      path: checkout,
                      type: "local_path",
                      isDefault: true,
                      createdAt: 0,
                      updatedAt: 0,
                    },
                  ],
                },
              ],
            },
            files: {
              read: async ({ path }: { path: string }) => ({
                content: await readFile(path, "utf8"),
                sha256: "unused",
              }),
              list: async ({ path }: { path: string }) => ({
                files: (await readdir(path)).map((name) => ({
                  name,
                  path: name,
                })),
                truncated: false,
              }),
            },
            environments: {
              get: async () => ({
                id: "env_task",
                hostId: "host_local",
                projectId: "proj_flow",
                path: worktree,
                status: "ready",
              }),
              list: async () => [
                {
                  id: "env_task",
                  hostId: "host_local",
                  path: worktree,
                  status: "ready",
                },
              ],
            },
            threads: {
              queuedMessages: {
                list: async ({ threadId }: { threadId: string }) =>
                  queued.has(threadId)
                    ? [
                        {
                          state: "waiting",
                          originPluginId: "team",
                          waitingOn: { kind: "plugin", pluginId: "team" },
                          content: queued.get(threadId),
                        },
                      ]
                    : [],
              },
              list: async () =>
                [...threads.keys()]
                  .filter((id) => threads.get(id)!.archivedAt === null)
                  .map(response),
              get: async ({ threadId }: { threadId: string }) =>
                response(threadId),
              getPluginMetadata: async ({ threadId }: { threadId: string }) =>
                threads.get(threadId)?.metadata ?? {},
              experimental_listPluginMetadata: async ({
                threadIds,
              }: {
                threadIds: string[];
              }) => ({
                threads: threadIds.map((threadId) => ({
                  threadId,
                  metadata: threads.get(threadId)?.metadata ?? {},
                })),
              }),
              experimental_listDescendants: async ({
                threadIds,
              }: {
                threadIds: string[];
              }) => ({
                threads: threadIds.map((threadId) => {
                  const ids = new Set<string>();
                  for (let i = 0; i < threads.size; i++)
                    for (const t of threads.values())
                      if (
                        t.parentThreadId === threadId ||
                        (t.parentThreadId && ids.has(t.parentThreadId))
                      )
                        ids.add(t.id);
                  return { threadId, descendantIds: [...ids] };
                }),
              }),
              spawn: async (args: Record<string, unknown>) => {
                expect(args.environment).toEqual({
                  type: "reuse",
                  environmentId: "env_task",
                });
                expect(args.input).toEqual([
                  { type: "text", text: expect.any(String), mentions: [] },
                ]);
                expect(args.prompt).toBeUndefined();
                const id = `thr_replacement${++spawnCount}`;
                threads.set(id, {
                  id,
                  parentThreadId: (args.parentThreadId as string) ?? null,
                  archivedAt: null,
                  status: "idle",
                  metadata:
                    (args.pluginMetadata as Record<string, unknown>) ?? {},
                });
                queued.set(
                  id,
                  args.input as { type: "text"; text: string; mentions: [] }[],
                );
                const decision = await harness!.inspection.registrations.hooks[
                  "message.dispatch"
                ]!({
                  thread: response(id),
                  initiator: "agent",
                  originPluginId: "team",
                } as never);
                expect(decision.action).toBe("wait");
                sent.push({
                  threadId: id,
                  text: (args.input as { text: string }[])[0]!.text,
                });
                return response(id);
              },
              update: async ({
                threadId,
                parentThreadId,
              }: {
                threadId: string;
                parentThreadId?: string;
              }) => {
                if (parentThreadId !== undefined)
                  threads.get(threadId)!.parentThreadId = parentThreadId;
                return response(threadId);
              },
              updatePluginMetadata: async ({
                threadId,
                set,
                remove,
              }: {
                threadId: string;
                set?: Record<string, unknown>;
                remove?: string[];
              }) => {
                const t = threads.get(threadId)!;
                Object.assign(t.metadata, set);
                for (const key of remove ?? []) delete t.metadata[key];
                return t.metadata;
              },
              archive: async ({ threadId }: { threadId: string }) => {
                expect(threads.get(threadId)!.status).toBe("idle");
                threads.get(threadId)!.archivedAt = Date.now();
                return { ok: true };
              },
              send: async ({
                threadId,
                input,
              }: {
                threadId: string;
                input: { text: string }[];
              }) => {
                sent.push({
                  threadId,
                  text: input.map((x) => x.text).join("\n"),
                });
                return { ok: true, delivery: "sent" };
              },
            },
          },
        });
        harness = fake.harness;
        const recheck = fake.bb.experimental_hooks.recheck;
        fake.bb.experimental_hooks.recheck = async (hook) => {
          await recheck(hook);
          for (const id of queued.keys()) {
            const decision = await harness!.inspection.registrations.hooks[
              "message.dispatch"
            ]!({
              thread: response(id),
              initiator: "agent",
              originPluginId: "team",
            } as never);
            if (decision.action === "proceed") queued.delete(id);
          }
        };
        await plugin(fake.bb);
        const cli = async (args: string[]) => {
          const r = await harness!.behavior.runCli([
            ...args,
            "--project",
            "flow",
            "--json",
          ]);
          expect(r.exitCode, r.stderr || r.stdout).toBe(0);
          return JSON.parse(r.stdout);
        };
        // Start with no database; the real create path prepares only Beads.
        const created = await cli(["create"]);
        expect(created.spawned).toHaveLength(0); // existing role sessions reused
        expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
        await cli(["create"]); // repeated preparation preserves the same database
        const selection = await cli(["tracker", kind]);
        expect(selection.kind).toBe(kind);
        const first = await cli(["task", "add", "dev", "Profile", "--send"]);
        const second = await cli([
          "task",
          "add",
          "dev",
          "Next profile task",
          "--send",
        ]);
        expect(first.task.status).toBe("in-progress");
        expect(second.task.status).toBe("todo");
        expect(second.sentTo).toBeNull();
        expect(sent.filter((x) => x.threadId === "thr_dev")).toHaveLength(1);
        const checkpointArgs = [
          "checkpoint",
          String(first.task.id),
          "--file",
          join(worktree, "checkpoint.json"),
        ];
        await cli(checkpointArgs);
        const beforeSpawn = spawnCount;
        threads.get("thr_dev")!.status = "active";
        const active = await harness.behavior.runCli([
          "replace",
          "dev",
          "--project",
          "flow",
        ]);
        expect(active.exitCode).not.toBe(0);
        expect(spawnCount).toBe(beforeSpawn);
        threads.get("thr_dev")!.status = "idle";
        await writeFile(
          join(worktree, "profile.ts"),
          "export const profile = 3; // changed after checkpoint\n",
        );
        const stale = await harness.behavior.runCli([
          "replace",
          "dev",
          "--project",
          "flow",
        ]);
        expect(stale.exitCode).not.toBe(0);
        expect(spawnCount).toBe(beforeSpawn);
        await cli(checkpointArgs);
        const replacement = await cli(["replace", "dev"]);
        expect(threads.get("thr_helper")!.parentThreadId).toBe(
          replacement.newThreadId,
        );
        expect(threads.get("thr_dev")!.archivedAt).not.toBeNull();
        expect(await readFile(join(worktree, "profile.ts"), "utf8")).toContain(
          "profile = 3",
        );
        expect(
          (
            await run("git", ["branch", "--show-current"], { cwd: worktree })
          ).stdout.trim(),
        ).toBe("task/profile");
        expect(
          sent.find((x) => x.threadId === replacement.newThreadId)!.text,
        ).toContain("Continue the profile");
        await cli([
          "task",
          "update",
          String(first.task.id),
          "--status",
          "review",
        ]);
        expect(
          (await cli(["task", "list"])).tasks.find(
            (t: { id: number | string }) => t.id === second.task.id,
          ).status,
        ).toBe("todo");
        await cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
        expect(
          (await cli(["task", "list"])).tasks.find(
            (t: { id: number | string }) => t.id === second.task.id,
          ).status,
        ).toBe("todo");
        // The earlier handoff checkpoint belongs to the retired session.
        // Saving a fresh checkpoint releases automatic continuation: no manual replace.
        const spawnsBeforeContinuation = spawnCount;
        await cli(checkpointArgs);
        const nextSession = {newThreadId: await fake.bb.storage.kv.get<string>("active-session:proj_flow:main:dev") as string};
        expect(spawnCount).toBe(spawnsBeforeContinuation + 1);
        expect(nextSession.newThreadId).not.toBe(replacement.newThreadId);
        expect(
          (await cli(["task", "list"])).tasks.find(
            (t: { id: number | string }) => t.id === second.task.id,
          ).status,
        ).toBe("in-progress");
        expect(
          sent.filter((x) => x.threadId === nextSession.newThreadId).at(-1)!
            .text,
        ).toContain("Next profile task");
        const leadTask = await cli(["task", "add", "lead", "Coordinate"]);
        await cli([
          "checkpoint",
          String(leadTask.task.id),
          "--file",
          join(worktree, "checkpoint.json"),
        ]);
        const newLead = await cli(["replace", "lead", "--keep"]);
        expect(threads.get(nextSession.newThreadId)!.parentThreadId).toBe(
          newLead.newThreadId,
        );
        const tell = await cli([
          "tell",
          "lead",
          "--message",
          "Decision needed",
        ]);
        expect(tell.sent[0].threadId).toBe(newLead.newThreadId);
        expect(threads.get("thr_lead")!.metadata.teamRetired).toBe(true);
        const snapshot = (await harness.behavior.callRpc("snapshot", {
          projectId: "proj_flow",
          team: "main",
        })) as {
          snapshot: {
            tracker: string;
            roles: { name: string; tasks: { id: number | string }[] }[];
          };
        };
        expect(snapshot.snapshot.tracker).toBe(kind);
        expect(
          snapshot.snapshot.roles.find((r) => r.name === "dev")!.tasks[0]!.id,
        ).toBe(second.task.id);
        if (kind === "beads") {
          expect(typeof first.task.id).toBe("string");
          expect(
            await fake.bb.storage.kv.get("tasks:proj_flow:main"),
          ).toBeUndefined();
          // Remove no data: temporarily point the source at an absent database
          // through a separate fake project is covered by tracker unavailable tests.
          const cp = JSON.parse(
            (
              await run(
                "bd",
                [
                  "show",
                  String(first.task.id),
                  "--json",
                  "--readonly",
                  "--sandbox",
                ],
                { cwd: checkout },
              )
            ).stdout,
          )[0].metadata.bbTeamCheckpoint;
          expect(cp.environmentId).toBe("env_task");
          expect(cp.path).toBe(worktree);
          expect(cp.content.goal).toBe(content.goal);
        }
      } finally {
        if (harness) await harness.lifecycle.dispose();
        await host.experimental_dispose();
        await rm(root, { recursive: true, force: true });
      }
    }, 120000);
});
