// bbt-er6.4/6.5: acceptance auto-continue of the package queue and the real
// execution-state surfaced per role. Real Git (host entry) so checkpoints
// verify; BB threads are deterministic SDK fixtures, no model calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import plugin from "../../src/server/server";
import hostEntry from "../../src/host/host";
import { deriveExecutionState } from "../../src/shared/snapshot";
import type { ExecutionFallbackSelection } from "../../src/shared/execution-policy";
import type { ResourceSummary } from "../../src/server/resource-control";
import type { SessionView } from "../../src/shared/session-view";

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

interface Fixture {
  control: (input: Record<string,unknown>) => Promise<{paused:boolean;threadId:string|null;fallbacks:ExecutionFallbackSelection[]}>;
  doctor: () => Promise<{exitCode:number;stdout:string;stderr:string}>;
  rpc: (method:string,input:unknown)=>Promise<unknown>;
  session: (role?: string) => Promise<SessionView>;
  rotate: (expectedThreadId?: string, role?: string) => Promise<SessionView>;
  cli: (args: string[]) => Promise<Record<string, unknown>>;
  startUser:(id:string,key:string)=>Promise<{action:string}>;
  rawCli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kv: (key: string) => Promise<unknown>;
  setKv: (key: string, value: unknown) => Promise<void>;
  snapshotRole: (role: string) => Promise<{ executionState?: unknown } & Record<string, unknown>>;
  sent: { threadId: string; text: string }[];
  spawnCalls: () => number;
  spawnPrompt: () => string;
  failNextSend: () => void;
  failNextRelease: () => void;
  failBeforeRelease: () => void;
  setStatus: (id: string, status: "idle" | "active") => void;
  setQueued:(id:string,value:boolean)=>void;
  archived: (id: string) => boolean;
  emitIdle: (id: string) => Promise<void>;
  /** threads.context counter for a thread (null = unsupported API). */
  setUsage: (id: string, u: null | { estimated: boolean; limit: number; used: number; snapshot?: { estimated?: boolean; contextWindowTokens?: number; usedTokens?: number } }) => void;
  /** Background command/interaction activity seen by threads.list rows. */
  setBackground: (id: string, commands: number, interaction?: boolean) => void;
  /** Fire the debounced experimental_thread.events trigger. */
  emitActivity: (id: string) => Promise<void>;
  /** Externally reassign a task to another role (builtin KV), like a tracker edit. */
  reassignTask: (taskId: number | string, role: string) => Promise<void>;
  spawnCount: () => number;
  quota: (requestId?:string,inputAccepted?:boolean,uncovered?:boolean) => Promise<void>;
  resources: () => Promise<ResourceSummary>;
  startAttempt: (id:string,key:string) => Promise<unknown>;
  writeAfterCheckpoint: () => Promise<void>;
  asCli: (args:string[],threadId:string) => Promise<{exitCode:number;stdout:string;stderr:string}>;
  spawnSelections: Array<{providerId:unknown;model:unknown;environment:unknown}>;
  restore:()=>{stop:()=>Promise<void>};
  dispose: () => Promise<void>;
}

async function setup(opts: { spawnFailures?: number; fallbacks?:ExecutionFallbackSelection[]; codexUsage?:unknown; codexEnv?:string[] } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "team-auto-"));
  const checkout = join(root, "project");
  const worktree = join(root, "task");
  const host = experimental_createHostEntryHarness(hostEntry);
  let harness: ReturnType<typeof createFakePluginHost>["harness"] | undefined;
  try {
    await mkdir(checkout);
    const git = (args: string[]) => run("git", args, { cwd: checkout });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.name", "Auto"]);
    await git(["config", "user.email", "auto@example.invalid"]);
    await writeFile(join(checkout, "profile.ts"), "export const profile = 1;\n");
    await git(["add", "profile.ts"]);
    await git(["commit", "-qm", "Initial state"]);
    await git(["worktree", "add", "-q", "-b", "task/profile", worktree]);
    await mkdir(join(checkout, ".bb", "teams"), { recursive: true });
    await writeFile(
      join(checkout, ".bb", "teams", "main.yaml"),
      "version: 1\nroles:\n  - name: lead\n    lead: true\n    prompt: Coordinate the work.\n  - name: dev\n    prompt: Implement the package.\n"+(opts.codexUsage?"    provider: codex\n    model: default\n":"")+(opts.fallbacks?`    provider: pi\n    model: ollama-cloud/original\n    executionPolicy: ${JSON.stringify({noAdditionalCost:true,fallbacks:opts.fallbacks})}\n`:""),
    );
    await writeFile(join(worktree, "profile.ts"), "export const profile = 2; // unfinished\n");
    await writeFile(join(worktree, "checkpoint.json"), JSON.stringify(content));
    const threads = new Map<
      string,
      { id: string; parentThreadId: string | null; archivedAt: number | null; status: "idle" | "active"; providerId?:string; metadata: Record<string, unknown> }
    >();
    for (const [id, role, parent] of [
      ["thr_lead", "lead", null],
      ["thr_dev", "dev", "thr_lead"],
    ] as const)
      threads.set(id, { id, parentThreadId: parent, archivedAt: null, status: "idle", providerId:opts.codexUsage?"codex":undefined, metadata: { teamName: "main", teamRole: role } });
    const response = (id: string) => {
      const t = threads.get(id)!;
      const bg = background.get(id);
      return makeThreadResponse({
        id: t.id,
        projectId: "proj_flow",
        environmentId: "env_task",
        environmentPath: worktree,
        environmentHostId: "host_local",
        status: t.status,
        parentThreadId: t.parentThreadId,
        archivedAt: t.archivedAt,
        providerId: t.providerId??"pi",
        ...(bg
          ? { hasPendingInteraction: bg.interaction, activity: { activeBackgroundCommandCount: bg.commands, activeBackgroundAgentCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }
          : {}),
      });
    };
    const usage = new Map<string, { usage: unknown }>();
    const background = new Map<string, { commands: number; interaction: boolean }>();
    const quotaEvents:Array<{id:string;threadId:string;scope:string;seq:number;createdAt:number;type:string;data:Record<string,unknown>}>=[];
    const queued = new Map<string, { type: "text"; text: string; mentions: [] }[]>();
    const sent: { threadId: string; text: string }[] = [];
    const spawnSelections:Array<{providerId:unknown;model:unknown;environment:unknown}>=[];
    let spawnNo = 0;
    let spawnPrompt = "";
    let sendFailures = 0;
    let releaseFailures = 0;
    let releaseBeforeFailures = 0;
    let failures = opts.spawnFailures ?? 0;
    const spawnThread = (args: Record<string, unknown>) => {
      spawnPrompt=(args.input as Array<{text:string}>)?.[0]?.text??"";
      spawnSelections.push({providerId:args.providerId,model:args.model,environment:args.environment});
      spawnNo += 1;
      if (spawnNo <= failures) throw new Error("HTTP 500: Internal server error");
      const id = `thr_replacement${spawnNo}`;
      threads.set(id, {
        id,
        parentThreadId: (args.parentThreadId as string) ?? null,
        archivedAt: null,
        status: "idle",
        providerId:args.providerId as string,
        metadata: (args.pluginMetadata as Record<string, unknown>) ?? {},
      });
      queued.set(id, args.input as { type: "text"; text: string; mentions: [] }[]);
      return id;
    };
    const fake = createFakePluginHost({
      pluginId: "team",
      experimental_hostEntry: true,
      settings: { defaultTracker: "builtin", teamSection: false, roster: false },
      experimental_callHostRpc: (call) => call.method==="ollamaUsage"?Promise.resolve({status:"unavailable",checkedAtMs:Date.now(),windows:[],reason:"host_unavailable"}):host.experimental_call(call.method as never, call.input as never, { signal: call.signal }),
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_local" }), usageLimits:async(args)=>{expect(args).toMatchObject({hostId:"host_local",providerId:"codex",refresh:true});return {codex:opts.codexUsage} as never;} },
        providers:{list:async()=>[{id:"pi",enabled:true},{id:"opencode2",enabled:true}] as never,models:async()=>({providers:[{id:"pi",available:true},{id:"opencode2",available:true}],models:[{id:"approved/free",model:"approved/free",defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"}]}],modelLoadError:null}) as never},
        projects: {
          machineEnvironment:async()=>({variables:(opts.codexEnv??[]).map(name=>({name,note:null,secret:true,value:null})),inheritedVariables:[],builtInGit:{status:"disabled",statusMessage:""}}),
          list: async () => [
            {
              id: "proj_flow",
              name: "flow",
              kind: "standard",
              createdAt: 0,
              updatedAt: 0,
              gitRemoteUrl: null,
              sources: [
                { id: "source", projectId: "proj_flow", hostId: "host_local", path: checkout, type: "local_path", isDefault: true, createdAt: 0, updatedAt: 0 },
              ],
            },
          ],
        },
        files: {
          write:async({path,content}:{path:string;content:string})=>{await writeFile(path,content);return {outcome:"written",sha256:"unused",sizeBytes:content.length};},
          read: async ({ path }: { path: string }) => ({ content: await readFile(path, "utf8"), sha256: "unused" }),
          list: async ({ path }: { path: string }) => ({ files: (await readdir(path)).map((name) => ({ name, path: name })), truncated: false }),
        },
        environments: {
          get: async () => ({ id: "env_task", hostId: "host_local", projectId: "proj_flow", path: worktree, status: "ready" }),
          list: async () => [{ id: "env_task", hostId: "host_local", path: worktree, status: "ready" }],
        },
        threads: {
          events:{list:async({threadId,order,afterSeq,beforeSeq})=>(order==="desc"?[...quotaEvents].reverse():quotaEvents).filter(r=>r.threadId===threadId&&r.seq>Number(afterSeq??0)&&r.seq<Number(beforeSeq??Infinity)) as never},
          context: async ({ threadId }: { threadId: string }) => usage.get(threadId) ?? { usage: null },
          queuedMessages: {
            list: async ({ threadId }: { threadId: string }) =>
              queued.has(threadId)
                ? [{ state: "waiting", originPluginId: "team", waitingOn: { kind: "plugin", pluginId: "team" }, content: queued.get(threadId) }]
                : [],
          },
          list: async () => [...threads.keys()].filter((id) => threads.get(id)!.archivedAt === null).map(response),
          get: async ({ threadId }: { threadId: string }) => response(threadId),
          getPluginMetadata: async ({ threadId }: { threadId: string }) => threads.get(threadId)?.metadata ?? {},
          experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
            threads: threadIds.map((threadId) => ({ threadId, metadata: threads.get(threadId)?.metadata ?? {} })),
          }),
          experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) => ({
            threads: threadIds.map((threadId) => {
              const ids = new Set<string>();
              for (let i = 0; i < threads.size; i++)
                for (const t of threads.values()) if (t.parentThreadId === threadId || (t.parentThreadId && ids.has(t.parentThreadId))) ids.add(t.id);
              return { threadId, descendantIds: [...ids] };
            }),
          }),
          spawn: async (args: Record<string, unknown>) => {
            expect(args.environment).toEqual({ type: "reuse", environmentId: "env_task" });
            expect(args.input).toEqual([{ type: "text", text: expect.any(String), mentions: [] }]);
            expect(args.prompt).toBeUndefined();
            const id = spawnThread(args);
            const decision = await harness!.inspection.registrations.hooks["message.dispatch"]!({
              thread: response(id),
              initiator: "agent",
              originPluginId: "team",
            } as never);
            expect(decision.action).toBe("wait");
            sent.push({ threadId: id, text: (args.input as { text: string }[])[0]!.text });
            return response(id);
          },
          update: async ({ threadId, parentThreadId }: { threadId: string; parentThreadId?: string }) => {
            if (parentThreadId !== undefined) threads.get(threadId)!.parentThreadId = parentThreadId;
            return response(threadId);
          },
          updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) => {
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
          send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
            if (sendFailures > 0) { sendFailures -= 1; throw new Error("Host disconnected while sending"); }
            sent.push({ threadId, text: input.map((x) => x.text).join("\n") });
            return { ok: true, delivery: "sent" };
          },
        },
      },
    });
    harness = fake.harness;
    const recheck = fake.bb.experimental_hooks.recheck;
    fake.bb.experimental_hooks.recheck = async (hook) => {
      if(releaseBeforeFailures>0){releaseBeforeFailures--;throw new Error("Queue unavailable before release");}
      await recheck(hook);
      for (const id of queued.keys()) {
        const decision = await harness!.inspection.registrations.hooks["message.dispatch"]!({
          thread: response(id),
          initiator: "agent",
          originPluginId: "team",
        } as never);
        if (decision.action === "proceed") queued.delete(id);
      }
      if(releaseFailures>0){releaseFailures--;throw new Error("Release acknowledgement was lost");}
    };
    await plugin(fake.bb);
    const cli = async (args: string[]) => {
      const r = await harness!.behavior.runCli([...args, "--project", "flow", "--json"]);
      expect(r.exitCode, r.stderr || r.stdout).toBe(0);
      return JSON.parse(r.stdout) as Record<string, unknown>;
    };
    const rawCli = (args: string[]) => harness!.behavior.runCli([...args, "--project", "flow"]);
    return {
      rpc:(method,input)=>harness!.behavior.callRpc(method,input),
      control:input=>harness!.behavior.callRpc("roleControl",{projectId:"proj_flow",team:"main",role:"dev",...input}) as never,
      doctor:()=>harness!.behavior.runCli(["doctor","--project","flow","--json"]),
      setQueued:(id,value)=>{if(value)queued.set(id,[{type:"text",text:"Original queued work",mentions:[]}]);else queued.delete(id);},
      restore:()=>{const service=harness!.behavior.runService("restore-auto-continuation");return {stop:async()=>{service.controller.abort();await service.done;}};},
      spawnSelections,
      resources:()=>harness!.behavior.callRpc("resources",{projectId:"proj_flow",team:"main"}) as Promise<ResourceSummary>,
      quota:async(requestId="quota-1",inputAccepted=false,uncovered=false)=>{
        if(!quotaEvents.length){if(uncovered)quotaEvents.push({id:"older-work",threadId:"thr_dev",scope:"thread",seq:1,createdAt:Date.now(),type:"turn/completed",data:{status:"completed"}});quotaEvents.push({id:"refused-request",threadId:"thr_dev",scope:"thread",seq:2,createdAt:Date.now(),type:"client/turn/requested",data:{requestId}});}
        await harness!.behavior.emitThreadEvent("turn.failed",{threadId:"thr_dev",requestId,turnId:null,errorInfo:{category:"budget-exceeded",httpStatusCode:429,providerCode:"quota_exceeded"},inputAccepted,rateLimits:null,attemptNumber:1,originPluginId:"team"});},
      startUser:async(id,key)=>harness!.inspection.registrations.hooks["message.dispatch"]!({thread:response(id),attempt:"start-turn",initiator:"user",senderThreadId:null,originPluginId:null,queuedMessages:[{id:key,initiator:"user",senderThreadId:null,originPluginId:null}],input:{text:key,blocks:[]},requestedExecution:{providerId:threads.get(id)!.providerId??"pi",model:"approved/free",reasoningLevel:"low",serviceTier:null,permissionMode:"full"}} as never) as never,
      startAttempt:async(id,key)=>harness!.inspection.registrations.hooks["message.dispatch"]!({thread:response(id),attempt:"start-turn",initiator:"system",originPluginId:"team",queuedMessages:[{id:key}],input:{text:key,blocks:[]},requestedExecution:{providerId:threads.get(id)!.providerId??"pi",model:"approved/free",reasoningLevel:"low",serviceTier:null,permissionMode:"full"}} as never),
      writeAfterCheckpoint:()=>writeFile(join(worktree,"profile.ts"),"changed after checkpoint\n"),
      asCli:(args,threadId)=>harness!.behavior.runCli([...args,"--project","flow","--json"],{projectId:"proj_flow",threadId}),
      cli,
      rawCli,
      session: (role = "dev") => harness!.behavior.callRpc("sessionView", {projectId: "proj_flow", team: "main", role}) as Promise<SessionView>,
      rotate: (expectedThreadId = "thr_dev", role = "dev") => harness!.behavior.callRpc("sessionRotate", {projectId: "proj_flow", team: "main", role, expectedThreadId}) as Promise<SessionView>,
      kv: (key: string) => fake.bb.storage.kv.get(key),
      setKv: (key, value) => fake.bb.storage.kv.set(key, value as never),
      snapshotRole: async (role: string) => {
        const snap = (await harness!.behavior.callRpc("snapshot", { projectId: "proj_flow", team: "main" })) as {
          snapshot: { roles: Array<{ name: string; executionState?: unknown }> };
        };
        return snap.snapshot.roles.find((r) => r.name === role) as { executionState?: unknown } & Record<string, unknown>;
      },
      sent,
      spawnCalls: () => spawnNo,
      spawnPrompt: () => spawnPrompt,
      failNextSend: () => { sendFailures += 1; },
      failNextRelease: () => { releaseFailures += 1; },
      failBeforeRelease: () => { releaseBeforeFailures += 1; },
      spawnCount: () => spawnNo,
      setStatus: (id, status) => {
        threads.get(id)!.status = status;
      },
      archived: (id) => threads.get(id)!.archivedAt !== null,
      emitIdle: async (id) => {
        await harness!.behavior.emitThreadEvent("thread.idle", {
          thread: response(id),
          lastAssistantText: null,
        } as never);
      },
      setUsage: (id, u) => {
        if (!u) {
          usage.delete(id);
          return;
        }
        usage.set(id, {
          usage: {
            estimated: u.estimated,
            modelContextWindow: u.limit,
            usedTokens: u.used,
            ...(u.snapshot
              ? {
                  snapshot: {
                    estimated: u.snapshot.estimated ?? false,
                    contextWindowTokens: u.snapshot.contextWindowTokens ?? u.limit,
                    usedTokens: u.snapshot.usedTokens ?? u.used,
                    autoCompactAtTokens: null,
                    capturedAt: "2026-01-01T00:00:00Z",
                    categories: [],
                    model: "m",
                    providerSessionId: "s",
                    providerTurnId: null,
                  },
                }
              : {}),
          },
        });
      },
      setBackground: (id, commands, interaction = false) => {
        if (commands === 0 && !interaction) background.delete(id);
        else background.set(id, { commands, interaction });
      },
      emitActivity: async (id) => {
        await harness!.behavior.emitThreadEvent("experimental_thread.events", {
          thread: response(id),
          sequence: 1,
        } as never);
      },
      reassignTask: async (taskId, role) => {
        const store = (await fake.bb.storage.kv.get("tasks:proj_flow:main")) as { tasks: Array<{ id: number | string; role: string }> };
        const task = store.tasks.find((t) => t.id === taskId);
        if (!task) throw new Error(`task ${taskId} not found in the builtin store`);
        task.role = role;
        await fake.bb.storage.kv.set("tasks:proj_flow:main", store);
      },
      dispose: async () => {
        await harness!.lifecycle.dispose();
        await host.experimental_dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (harness) await harness.lifecycle.dispose();
    await host.experimental_dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

describe("авто-продолжение очереди после приёмки (bbt-er6.4)", () => {
  it("done без checkpoint: явное ожидание + уведомление исполнителю, не подделка", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      await fx.cli(["task", "add", "dev", "Second", "--send"]);
      await fx.cli(["task", "update", String(first.task.id), "--status", "review"]);
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      // Никакого спавна и никакого фейкового checkpoint из output.
      expect(fx.spawnCalls()).toBe(0);
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; taskId: unknown };
      expect(record.stage).toBe("awaiting-checkpoint");
      expect(record.taskId).toBe(first.task.id);
      const requests = fx.sent.filter((x) => x.threadId === "thr_dev" && x.text.includes("bb team checkpoint"));
      expect(requests).toHaveLength(1);
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string; taskId: unknown };
      expect(state.kind).toBe("awaiting-checkpoint");
      expect(state.taskId).toBe(first.task.id);
      // Повторный триггер не дублирует уведомление (durable-запрос, dedup).
      await fx.cli(["task", "add", "dev", "Third"]);
      expect(fx.sent.filter((x) => x.threadId === "thr_dev" && x.text.includes("bb team checkpoint"))).toHaveLength(1);
      expect(fx.spawnCalls()).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it("исполнитель сохранил checkpoint: авто-замена сессии и dispatch следующего ready пакета", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      const second = (await fx.cli(["task", "add", "dev", "Second", "--send"])) as { task: { id: number | string } };
      await fx.cli(["task", "update", String(first.task.id), "--status", "review"]);
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect((await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string } | null).not.toBeNull();
      // Агент сохраняет содержательный checkpoint — это и есть триггер.
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      const replacement = await fx.kv("active-session:proj_flow:main:dev");
      expect(typeof replacement).toBe("string");
      expect(replacement).not.toBe("thr_dev");
      expect(fx.archived("thr_dev")).toBe(true);
      // Следующий ready пакет отправлен в новую сессию.
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string; role: string }> };
      expect(list.tasks.find((t) => t.id === second.task.id)!.status).toBe("in-progress");
      expect(fx.sent.filter((x) => x.threadId === replacement && x.text.includes("Work package #") && x.text.includes("Second"))).toHaveLength(1);
      // Запрос закрыт; fixture остаётся idle до подтверждённого active.
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string; taskId: unknown };
      expect(state.kind).toBe("waiting");
      expect(state.taskId).toBe(second.task.id);
    } finally {
      await fx.dispose();
    }
  });

  it("нет готового следующего пакета: сессия не тратится, ожидание готовой задачи", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(fx.spawnCalls()).toBe(0);
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string };
      expect(record.stage).toBe("awaiting-package");
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string };
      expect(state.kind).toBe("awaiting-package");
      // Появилась готовая задача → замена и dispatch.
      const second = (await fx.cli(["task", "add", "dev", "Second"])) as { task: { id: number | string } };
      expect(fx.spawnCalls()).toBe(1);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string }> };
      expect(list.tasks.find((t) => t.id === second.task.id)!.status).toBe("in-progress");
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it("агент активен: ждём безопасной границы, замена на idle, ничего не прерываем", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      await fx.cli(["task", "add", "dev", "Second", "--send"]);
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      fx.setStatus("thr_dev", "active");
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(fx.spawnCalls()).toBe(0);
      expect(((await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string }).stage).toBe("awaiting-safe-boundary");
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string };
      expect(state.kind).toBe("awaiting-safe-boundary");
      // Поток завершил работу — безопасная граница, замена на idle-событии.
      fx.setStatus("thr_dev", "idle");
      await fx.emitIdle("thr_dev");
      expect(fx.spawnCalls()).toBe(1);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string; role: string }> };
      expect(list.tasks.find((t) => t.role === "dev" && t.status === "in-progress")!.title).toBe("Second");
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it("неясный сбой спавна: failed без авто-повтора, lead уведомлён, ошибка не висит вечно", async () => {
    const fx = await setup({ spawnFailures: 1 });
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      await fx.cli(["task", "add", "dev", "Second", "--send"]);
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(fx.spawnCalls()).toBe(1); // одна попытка, без авто-повтора spawn/send
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; errorCode: string };
      expect(record.stage).toBe("failed");
      expect(record.errorCode).toBe("spawn_uncertain");
      expect(fx.sent.some((x) => x.threadId === "thr_lead" && x.text.includes("spawn_uncertain"))).toBe(true);
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string; errorCode: string; safeAction: string; errorMessage?: string };
      expect(state.kind).toBe("error");
      expect(state.errorCode).toBe("spawn_uncertain");
      expect(state.safeAction).toContain("bb team replace");
      expect(state.errorMessage).toContain("HTTP 500");
      // Повторный триггер (приёмка задачи lead) не повторяет спавн.
      const wake = (await fx.cli(["task", "add", "lead", "Wake"])) as { task: { id: number | string } };
      await fx.cli(["task", "done", String(wake.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(fx.spawnCalls()).toBe(1);
      // Ручное восстановление: abort неясного интента, затем ручной replace.
      await fx.cli(["replace", "dev", "--abort"]);
      await fx.cli(["replace", "dev"]);
      expect(fx.spawnCalls()).toBe(2);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string; role: string }> };
      expect(list.tasks.find((t) => t.role === "dev" && t.status === "in-progress")!.title).toBe("Second");
      // Триггер после ручного восстановления очищает stale failed-запись.
      const wake2 = (await fx.cli(["task", "add", "lead", "Wake 2"])) as { task: { id: number | string } };
      await fx.cli(["task", "done", String(wake2.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      const state2 = (await fx.snapshotRole("dev")).executionState as { kind: string };
      expect(state2.kind).toBe("waiting");
    } finally {
      await fx.dispose();
    }
  });
});

describe("ротация контекста сессии (bbt-er6.8)", () => {
  it("смена binding при незавершённом intent сохраняет ошибку восстановления", async () => {
    const fx = await setup();
    try {
      const first = await fx.cli(["task", "add", "dev", "Continue", "--send"]) as { task: { id: number } };
      await fx.setKv("auto-continue:proj_flow:main:dev", {
        taskId: first.task.id, reason: "context", originThreadId: "thr_previous",
        stage: "awaiting-safe-boundary", errorCode: null, error: null,
        notifiedStage: null, requestedAtMs: 0, updatedAtMs: 0,
      });
      await fx.setKv("replacement:proj_flow:main:dev", {
        oldThreadId: "thr_previous", newThreadId: "thr_dev", environmentId: "env_task",
        keep: false, stage: "switching", delivery: "pending", reparented: 0, resumed: false, startedAt: 0,
      });
      await fx.emitIdle("thr_dev");
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toMatchObject({ stage: "failed", errorCode: "replacement_unfinished" });
      expect((await fx.snapshotRole("dev")).executionState).toMatchObject({ kind: "error", errorCode: "replacement_unfinished" });
      expect(fx.spawnCalls()).toBe(0);
      const sent = fx.sent.length;
      await fx.emitIdle("thr_dev");
      expect(fx.sent).toHaveLength(sent);
    } finally {
      await fx.dispose();
    }
  });

  it("--rotate: та же задача продолжается в новой сессии, без dispatch другой; активный агент не прерывается", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      // Собственный active turn агента: запрос только записывается.
      fx.setStatus("thr_dev", "active");
      const saved = (await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("requested");
      expect(fx.spawnCalls()).toBe(0);
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; reason: string };
      expect(record.stage).toBe("awaiting-safe-boundary");
      expect(record.reason).toBe("context");
      // Безопасная граница: idle — замена, задача передаётся дальше.
      fx.setStatus("thr_dev", "idle");
      await fx.emitIdle("thr_dev");
      expect(fx.spawnCalls()).toBe(1);
      const replacement = await fx.kv("active-session:proj_flow:main:dev");
      expect(fx.archived("thr_dev")).toBe(true);
      // Тот же taskId продолжает работу в новой сессии, никакой другой пакет не dispatch-ится.
      expect(await fx.kv(`session-task:proj_flow:main:${replacement}`)).toBe(first.task.id);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string }> };
      expect(list.tasks.find((t) => t.id === first.task.id)!.status).toBe("in-progress");
      expect(fx.sent.filter((x) => x.threadId === replacement && x.text.includes("Resume checkpoint nextAction for task"))).toHaveLength(1);
      expect(fx.sent.filter((x) => x.text.includes("Work package #") && x.text.includes("First"))).toHaveLength(1); // только исходная доставка
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it("lead --rotate: дети перепривязываются к новой lead-сессии, routing сообщения уходят", async () => {
    const fx = await setup();
    try {
      const leadTask = (await fx.cli(["task", "add", "lead", "Coordinate", "--send"])) as { task: { id: number | string } };
      const saved = (await fx.cli(["checkpoint", String(leadTask.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("replaced"); // роль idle — выполнено сразу
      const newLead = await fx.kv("active-session:proj_flow:main:lead");
      expect(typeof newLead).toBe("string");
      expect(fx.archived("thr_lead")).toBe(true);
      expect(fx.sent.some((x) => x.threadId === "thr_dev" && x.text.includes("Team routing changed"))).toBe(true);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string }> };
      expect(list.tasks.find((t) => t.id === leadTask.task.id)!.status).toBe("in-progress");
      expect(await fx.kv(`session-task:proj_flow:main:${newLead}`)).toBe(leadTask.task.id);
      expect(await fx.kv("auto-continue:proj_flow:main:lead")).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it("здоровое точное 80%: авто-запрос, одно уведомление о checkpoint, затем передача; дубли idle/events не дают второй spawn", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 80000 });
      await fx.emitIdle("thr_dev");
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; reason: string; taskId: unknown };
      expect(record.stage).toBe("awaiting-checkpoint");
      expect(record.reason).toBe("context");
      expect(record.taskId).toBe(first.task.id);
      expect(fx.sent.filter((x) => x.threadId === "thr_dev" && x.text.includes("bb team checkpoint"))).toHaveLength(1);
      expect(fx.spawnCalls()).toBe(0);
      // Агент сохраняет checkpoint (без --rotate) — запрос продолжается.
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      expect(fx.spawnCalls()).toBe(1);
      const replacement = await fx.kv("active-session:proj_flow:main:dev");
      expect(fx.sent.filter((x) => x.threadId === replacement && x.text.includes("Resume checkpoint nextAction for task"))).toHaveLength(1);
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      // Повторные idle и activity-события новой сессии без usage — ничего не будят и не дублируют.
      await fx.emitIdle(String(replacement));
      await fx.emitActivity(String(replacement));
      await fx.emitActivity(String(replacement));
      expect(fx.spawnCalls()).toBe(1);
    } finally {
      await fx.dispose();
    }
  });

  it("estimated/null/нечисловое/противоречивый snapshot — без автоматики, без запросов и ошибок роли", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      const deliveriesBefore = fx.sent.length;
      fx.setUsage("thr_dev", { estimated: true, limit: 1000000, used: 1000000 });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", null);
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 0, used: 5 });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: -1 });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 90000, snapshot: { estimated: true } });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 90000, snapshot: { contextWindowTokens: 50000 } });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: Infinity, used: 90000 });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: Infinity });
      await fx.emitIdle("thr_dev");
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 90000, snapshot: { usedTokens: 85000 } });
      await fx.emitIdle("thr_dev");
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      expect(fx.spawnCalls()).toBe(0);
      expect(fx.sent.length).toBe(deliveriesBefore); // ни уведомлений, ни ошибок роли
      // Явный --rotate при этом работает.
      const saved = (await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("replaced");
      expect(fx.spawnCalls()).toBe(1);
    } finally {
      await fx.dispose();
    }
  });

  it("низкий usage не влияет на accepted policy", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      const second = (await fx.cli(["task", "add", "dev", "Second", "--send"])) as { task: { id: number | string } };
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 1000 });
      await fx.emitIdle("thr_dev");
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      // Обычный принятый поток не затронут.
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      await fx.cli(["task", "update", String(first.task.id), "--status", "review"]);
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      await fx.emitIdle("thr_dev");
      expect(fx.spawnCalls()).toBe(1);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string }> };
      expect(list.tasks.find((t) => t.id === second.task.id)!.status).toBe("in-progress");
      expect(list.tasks.some((t) => t.id === first.task.id)).toBe(false); // done не в открытых
    } finally {
      await fx.dispose();
    }
  });

  it("accepted/context гонка: одна запись, одна замена; принятый пакет не повторяется", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      fx.setUsage("thr_dev", { estimated: false, limit: 100000, used: 95000 });
      await fx.emitIdle("thr_dev"); // context-запрос ждёт checkpoint
      expect(((await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string }).stage).toBe("awaiting-checkpoint");
      // Задачу приняли до ротации — работает accepted policy, запись одна.
      await fx.cli(["task", "done", String(first.task.id), "--reason", "Manual acceptance of the fixture package"]);
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; taskId: unknown };
      expect(record.stage).toBe("awaiting-package");
      expect(record.taskId).toBe(first.task.id);
      expect(fx.spawnCalls()).toBe(0);
      await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json"]);
      expect(fx.spawnCalls()).toBe(0); // ready-задачи нет — замены нет
      const second = (await fx.cli(["task", "add", "dev", "Second"])) as { task: { id: number | string } };
      expect(fx.spawnCalls()).toBe(1); // ровно одна замена
      const replacement = await fx.kv("active-session:proj_flow:main:dev");
      // Принятый пакет не повторяется, новый — отправлен.
      expect(fx.sent.filter((x) => x.threadId === replacement && x.text.includes("already accepted"))).toHaveLength(1);
      const list = (await fx.cli(["task", "list"])) as { tasks: Array<{ id: number | string; status: string }> };
      expect(list.tasks.find((t) => t.id === second.task.id)!.status).toBe("in-progress");
      expect(list.tasks.some((t) => t.id === first.task.id)).toBe(false); // done не повторяется и не в открытых
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
    } finally {
      await fx.dispose();
    }
  });

  it("переназначенная внешне задача не продолжается старой ролью: task_reassigned до спавна (auto + manual)", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      await fx.cli(["task", "add", "dev", "Second"]); // готовая следующая для старой роли
      fx.setStatus("thr_dev", "active");
      const saved = (await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("requested");
      await fx.reassignTask(first.task.id, "lead"); // внешнее переназначение
      fx.setStatus("thr_dev", "idle");
      await fx.emitIdle("thr_dev");
      // Замены нет: отказ до спавна, явный failed с причиной и safeAction.
      expect(fx.spawnCalls()).toBe(0);
      const record = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; errorCode: string };
      expect(record.stage).toBe("failed");
      expect(record.errorCode).toBe("task_reassigned");
      expect(fx.sent.some((x) => x.threadId === "thr_lead" && x.text.includes("task_reassigned"))).toBe(true);
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string; errorCode: string; safeAction: string; errorMessage?: string };
      expect(state.kind).toBe("error");
      expect(state.errorCode).toBe("task_reassigned");
      expect(state.safeAction).toContain("tracker");
      expect(state.errorMessage).toContain("assigned to role lead");
      // Ручной replace той же ролью тоже отказывает до спавна.
      const manual = await fx.rawCli(["replace", "dev"]);
      expect(manual.exitCode).not.toBe(0);
      expect(manual.stderr).toContain("assigned to role lead");
      expect(fx.spawnCalls()).toBe(0);
    } finally {
      await fx.dispose();
    }
  });

  it("context recovery: ручное восстановление продолжает тот же taskId; stale failed очищается по originThreadId", async () => {
    const fx = await setup({ spawnFailures: 1 });
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      fx.setStatus("thr_dev", "active");
      const saved = (await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("requested");
      fx.setStatus("thr_dev", "idle");
      await fx.emitIdle("thr_dev");
      const failed = (await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string; errorCode: string; originThreadId?: string };
      expect(failed.stage).toBe("failed");
      expect(failed.errorCode).toBe("spawn_uncertain");
      expect(failed.originThreadId).toBe("thr_dev");
      expect(fx.spawnCalls()).toBe(1);
      // Ручное восстановление: abort неясного интента, затем replace — задача та же.
      await fx.cli(["replace", "dev", "--abort"]);
      await fx.cli(["replace", "dev"]);
      expect(fx.spawnCalls()).toBe(2);
      const newId = await fx.kv("active-session:proj_flow:main:dev");
      expect(await fx.kv(`session-task:proj_flow:main:${newId}`)).toBe(first.task.id); // тот же taskId
      expect(((await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string }).stage).toBe("failed"); // запись ещё stale
      // Триггер очищает по originThreadId, хотя taskId тот же.
      const wake = (await fx.cli(["task", "add", "lead", "Wake"])) as { task: { id: number | string } };
      await fx.cli(["task", "done", String(wake.task.id), "--reason", "Manual acceptance of the fixture package"]);
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      const state = (await fx.snapshotRole("dev")).executionState as { kind: string; taskId: unknown };
      expect(state.kind).toBe("waiting");
      expect(state.taskId).toBe(first.task.id);
    } finally {
      await fx.dispose();
    }
  });

  it("фоновая команда завершилась без нового idle: experimental_thread.events продвигает запрос; без запроса ничего не будит", async () => {
    const fx = await setup();
    try {
      const first = (await fx.cli(["task", "add", "dev", "First", "--send"])) as { task: { id: number | string } };
      fx.setBackground("thr_dev", 1); // idle-статус, но живая фоновая команда
      const saved = (await fx.cli(["checkpoint", String(first.task.id), "--file", "checkpoint.json", "--rotate"])) as { rotate: string };
      expect(saved.rotate).toBe("requested"); // безопасная граница ещё не достигнута
      expect(fx.spawnCalls()).toBe(0);
      expect(((await fx.kv("auto-continue:proj_flow:main:dev")) as { stage: string }).stage).toBe("awaiting-safe-boundary");
      // Фон завершился, нового thread.idle нет — только activity-событие.
      fx.setBackground("thr_dev", 0);
      await fx.emitActivity("thr_dev");
      expect(fx.spawnCalls()).toBe(1);
      const replacement = await fx.kv("active-session:proj_flow:main:dev");
      expect(await fx.kv(`session-task:proj_flow:main:${replacement}`)).toBe(first.task.id);
      expect(await fx.kv("auto-continue:proj_flow:main:dev")).toBeUndefined();
      // Обычные события без запроса ничего не будят (ни spawn, ни сообщений).
      const sentBefore = fx.sent.length;
      await fx.emitActivity("thr_dev");
      await fx.emitActivity("thr_lead");
      expect(fx.spawnCalls()).toBe(1);
      expect(fx.sent.length).toBe(sentBefore);
    } finally {
      await fx.dispose();
    }
  });
});

it("handoff carries original task constraints even when the agent checkpoint omitted them",async()=>{
 const fx=await setup();
 try{
  const task=await fx.cli(["task","add","dev","Restricted work","--note","Only the tester may accept this task; do not close it yourself","--send"]) as {task:{id:number|string}};
  await fx.cli(["checkpoint",String(task.task.id),"--file","checkpoint.json"]);
  await fx.rotate();
  expect(fx.spawnPrompt()).toContain("Only the tester may accept this task; do not close it yourself");
  expect(fx.spawnPrompt()).toContain("A handoff or a saved report is not an acceptance decision");
  expect(fx.spawnPrompt()).toContain('"status":"in-progress"');
 }finally{await fx.dispose();}
});

it("RPC recovery rechecks confirmation and revision, then releases the existing queue once",async()=>{
 const fx=await setup();
 try{
  const task=await fx.cli(["task","add","dev","Work","--send"]) as {task:{id:number|string}};
  await fx.startAttempt("thr_dev","journal-check");
  const history=await fx.rpc("executionHistory",{projectId:"proj_flow",team:"main",role:"dev"}) as {events:Array<{eventType:string}>};
  expect(history.events.some(event=>event.eventType==="attempt")).toBe(true);
  await fx.cli(["checkpoint",String(task.task.id),"--file","checkpoint.json"]);
  fx.failBeforeRelease();
  const failed=await fx.rawCli(["replace","dev"]);expect(failed.exitCode).not.toBe(0);
  const input={projectId:"proj_flow",team:"main",role:"dev"};
  const view=await fx.rpc("sessionRecovery",input) as {revision:string;actions:string[];newThreadId:string};
  expect(view.actions).toContain("release");
  await expect(fx.rpc("sessionRecovery",{...input,action:"release",expectedRevision:view.revision})).rejects.toThrow();
  await expect(fx.rpc("sessionRecovery",{...input,action:"release",confirmed:true,expectedRevision:"stale"})).rejects.toThrow();
  const count=fx.spawnCalls();
  await fx.rpc("sessionRecovery",{...input,action:"release",confirmed:true,expectedRevision:view.revision});
  expect(fx.spawnCalls()).toBe(count);
  await expect(fx.rpc("sessionRecovery",{...input,action:"release",confirmed:true,expectedRevision:view.revision})).rejects.toThrow();
 }finally{await fx.dispose();}
});

describe("execution-state роли (bbt-er6.5, чистая функция)", () => {
  const task = (id: number | string, status: string) => ({ id, title: "t", status, note: null, createdAtMs: 0, updatedAtMs: 42, role: "dev" });
  it("приоритеты: failed-запрос важнее зависшего intent; intent описывает замену", () => {
    const failed = deriveExecutionState({
      role: "dev",
      tasks: [],
      replacement: { stage: "switching", delivery: "pending", startedAtMs: 1 },
      autoContinue: { taskId: 3, stage: "failed", errorCode: "release_failed", updatedAtMs: 5 },
      threadStatus: "idle",
    });
    expect(failed?.kind).toBe("error");
    expect(failed?.errorCode).toBe("release_failed");
    expect(failed?.safeAction).toContain("bb team resume");
    const replacing = deriveExecutionState({
      role: "dev",
      tasks: [],
      replacement: { stage: "switching", delivery: "pending", startedAtMs: 1 },
      autoContinue: null,
      threadStatus: "idle",
    });
    expect(replacing?.kind).toBe("replacing");
  });

  it("intent: spawn_uncertain и delivery_uncertain — явные ошибки с безопасным действием", () => {
    const spawn = deriveExecutionState({
      role: "dev", tasks: [], replacement: { stage: "spawn_uncertain", delivery: "pending", startedAtMs: 1 }, autoContinue: null, threadStatus: null,
    });
    expect(spawn?.kind).toBe("error");
    expect(spawn?.safeAction).toContain("bb team replace dev --dry-run");
    const delivery = deriveExecutionState({
      role: "dev", tasks: [], replacement: { stage: "complete", delivery: "uncertain", startedAtMs: 1 }, autoContinue: null, threadStatus: null,
    });
    expect(delivery?.kind).toBe("error");
    expect(delivery?.safeAction).toContain("bb team resume");
  });

  it("replacement_unfinished и unknown коды дают конкретное безопасное действие", () => {
    const unfinished = deriveExecutionState({
      role: "dev", tasks: [], replacement: null,
      autoContinue: { taskId: 1, stage: "failed", errorCode: "replacement_unfinished", updatedAtMs: 1 }, threadStatus: null,
    });
    expect(unfinished?.safeAction).toContain("bb team replace dev");
    expect(unfinished?.safeAction).toContain("--abort");
    const unknown = deriveExecutionState({
      role: "dev", tasks: [], replacement: null,
      autoContinue: { taskId: 1, stage: "failed", errorCode: "old_environment_mismatch", updatedAtMs: 1 }, threadStatus: null,
    });
    expect(unknown?.kind).toBe("error");
    expect(unknown?.safeAction).toContain("bb team doctor");
  });

  it("errorMessage: ограниченная первая строка исходной причины, без стеков и без потерь коротких сообщений", () => {
    const long = `line one ${"x".repeat(2000)}\n  at stackFrame (file.ts:1:1)\n  at another (file.ts:2:2)`;
    const state = deriveExecutionState({
      role: "dev", tasks: [], replacement: null,
      autoContinue: { taskId: 1, stage: "failed", errorCode: "auto_continue_failed", error: long, updatedAtMs: 1 }, threadStatus: null,
    });
    expect(state?.errorMessage).toBe(`line one ${"x".repeat(991)}`);
    expect(state?.errorMessage).not.toContain("stackFrame");
    const short = deriveExecutionState({
      role: "dev", tasks: [], replacement: null,
      autoContinue: { taskId: 1, stage: "failed", errorCode: "release_failed", error: "recheck failed: timeout", updatedAtMs: 1 }, threadStatus: null,
    });
    expect(short?.errorMessage).toBe("recheck failed: timeout");
    const none = deriveExecutionState({
      role: "dev", tasks: [], replacement: null,
      autoContinue: { taskId: 1, stage: "failed", errorCode: "spawn_uncertain", updatedAtMs: 1 }, threadStatus: null,
    });
    expect(none?.errorMessage).toBeUndefined();
  });

  it("задачи: работает / ждёт приёмки; running-тред без задач — работает; idle — нет состояния", () => {
    expect(deriveExecutionState({ role: "dev", tasks: [task(1, "in-progress")], replacement: null, autoContinue: null, threadStatus: "idle" })?.kind).toBe("waiting");
    expect(deriveExecutionState({ role: "dev", tasks: [task(1, "review")], replacement: null, autoContinue: null, threadStatus: "idle" })?.kind).toBe("awaiting-acceptance");
    expect(deriveExecutionState({ role: "dev", tasks: [], replacement: null, autoContinue: null, threadStatus: "active" })?.kind).toBe("working");
    expect(deriveExecutionState({ role: "dev", tasks: [task(1, "done")], replacement: null, autoContinue: null, threadStatus: "idle" })).toBeUndefined();
  });
});


describe("карточка сессии: RPC и безопасное действие", () => {
  it("чтение старой сессии без задачи показывает оценку и не будит модель", async () => {
    const fx = await setup();
    try {
      fx.setUsage("thr_dev", { estimated: true, used: 82000, limit: 100000 });
      const view = await fx.session();
      expect(view).toMatchObject({threadId: "thr_dev", taskId: null, blockedReason: "no_task", context: {kind: "estimated", usedTokens: 82000}});
      await fx.session();
      expect(fx.sent).toHaveLength(0);
      expect(fx.spawnCalls()).toBe(0);
      await expect(fx.rotate()).rejects.toThrow();
      expect(fx.sent).toHaveLength(0);
    } finally { await fx.dispose(); }
  });

  it("запрос с кнопки не прерывает active; повторы дедуплицируются, checkpoint и idle передают ту же задачу", async () => {
    const fx = await setup();
    try {
      const first = await fx.cli(["task", "add", "dev", "Profile", "--send"]);
      fx.setStatus("thr_dev", "active");
      fx.setUsage("thr_dev", {estimated: false, used: 81000, limit: 100000});
      const before = fx.sent.length;
      expect((await fx.session()).context.kind).toBe("exact");
      expect(fx.sent.length).toBe(before);
      const repeated = await Promise.all([fx.rotate(), fx.rotate()]);
      expect(repeated.map(view => view.phase)).toEqual(["awaiting-checkpoint", "awaiting-checkpoint"]);
      expect(fx.sent.length).toBe(before + 1);
      expect(fx.spawnCalls()).toBe(0);
      expect(fx.archived("thr_dev")).toBe(false);
      await fx.cli(["checkpoint", String((first.task as {id: number}).id), "--file", "checkpoint.json"]);
      expect((await fx.session()).phase).toBe("awaiting-safe-boundary");
      fx.setStatus("thr_dev", "idle");
      await fx.emitIdle("thr_dev");
      const after = await fx.session();
      expect(after.threadId).toBe("thr_replacement1");
      expect(after.taskId).toBe((first.task as {id:number}).id);
      expect(fx.spawnCalls()).toBe(1);
      await expect(fx.rotate()).rejects.toThrow(); // stale card cannot replace the fresh thread
      expect(fx.spawnCalls()).toBe(1);
    } finally { await fx.dispose(); }
  });

  it("готовый checkpoint используется сразу, неизвестные метрики не блокируют явную передачу", async () => {
    const fx = await setup();
    try {
      const first = await fx.cli(["task", "add", "dev", "Profile", "--send"]);
      await fx.cli(["checkpoint", String((first.task as {id:number}).id), "--file", "checkpoint.json"]);
      expect(await fx.session()).toMatchObject({checkpoint: "ready", context: {kind: "unavailable"}});
      const sentBefore = fx.sent.length;
      expect(await fx.rotate()).toMatchObject({threadId: "thr_replacement1", phase: "idle"});
      expect(fx.spawnCalls()).toBe(1);
      expect(fx.sent.slice(sentBefore).some(message => message.text.includes("Save a fresh checkpoint"))).toBe(false);
    } finally { await fx.dispose(); }
  });

  it("неоднозначный spawn отражается ошибкой, повтор не создаёт вторую сессию", async () => {
    const fx = await setup({spawnFailures: 1});
    try {
      const first = await fx.cli(["task", "add", "dev", "Profile", "--send"]);
      await fx.cli(["checkpoint", String((first.task as {id:number}).id), "--file", "checkpoint.json"]);
      const result = await fx.rotate();
      expect(result.phase).toBe("error");
      expect(result.blockedReason).not.toBeNull();
      expect(fx.spawnCalls()).toBe(1);
      await expect(fx.rotate()).rejects.toThrow();
      expect(fx.spawnCalls()).toBe(1);
    } finally { await fx.dispose(); }
  });

  it("пауза и внешнее переназначение объясняются до любых сообщений и spawn", async () => {
    const fx = await setup();
    try {
      const first = await fx.cli(["task", "add", "dev", "Profile", "--send"]);
      await fx.cli(["pause"]);
      expect((await fx.session()).blockedReason).toBe("paused");
      await expect(fx.rotate()).rejects.toThrow();
      await fx.reassignTask((first.task as {id:number}).id, "lead");
      expect((await fx.session()).blockedReason).toBe("task_reassigned");
      await expect(fx.rotate()).rejects.toThrow();
      expect(fx.spawnCalls()).toBe(0);
    } finally { await fx.dispose(); }
  });
});


it("карточка: ошибка доставки checkpoint-запроса явная и не повторяется автоматически", async () => {
  const fx = await setup();
  try {
    await fx.cli(["task", "add", "dev", "Profile", "--send"]);
    fx.failNextSend();
    const view = await fx.rotate();
    expect(view).toMatchObject({phase: "error", blockedReason: "failed", errorCode: "auto_continue_failed"});
    await expect(fx.rotate()).rejects.toThrow();
    await fx.emitIdle("thr_dev");
    expect(fx.spawnCalls()).toBe(0);
    expect((await fx.session()).phase).toBe("error");
  } finally { await fx.dispose(); }
});

it("карточка: руководитель передаёт связанную задачу координации с перепривязкой детей", async () => {
  const fx = await setup();
  try {
    const first = await fx.cli(["task", "add", "lead", "Coordinate", "--send"]);
    await fx.cli(["checkpoint", String((first.task as {id:number}).id), "--file", "checkpoint.json"]);
    expect((await fx.rotate("thr_lead", "lead")).threadId).toBe("thr_replacement1");
    const dev = await fx.snapshotRole("dev");
    expect((dev.threads as {parentThreadId: string}[])[0]?.parentThreadId).toBe("thr_replacement1");
    expect(fx.spawnCalls()).toBe(1);
  } finally { await fx.dispose(); }
});


it("карточка: завершённая задача руководителя ждёт новый пакет и не называется продолжением старой задачи", async () => {
  const fx = await setup();
  try {
    const first = await fx.cli(["task", "add", "lead", "Coordinate", "--send"]);
    await fx.cli(["checkpoint", String((first.task as {id:number}).id), "--file", "checkpoint.json"]);
    await fx.cli(["task", "done", String((first.task as {id:number}).id), "--reason", "Manual acceptance of the fixture package"]);
    expect(await fx.rotate("thr_lead", "lead")).toMatchObject({phase: "awaiting-package", reason: "accepted"});
    expect(fx.spawnCalls()).toBe(0);
  } finally { await fx.dispose(); }
});


describe("resource quota continuation and grounded acceptance (bbt-iwi.6)",()=>{
 const backups=[{provider:"pi",model:"same-pool"},{provider:"opencode2",model:"approved/free",reasoningLevel:"low"}];
 it("continues the same task/environment with the approved independent model, then lead accepts evidence",async()=>{
  const fx=await setup({fallbacks:backups});try{
   await fx.cli(["task","add","dev","Continue profile","--send"]);
   await fx.cli(["checkpoint","1","--file","checkpoint.json"]);
   await fx.startAttempt("thr_dev","first-attempt");
   await fx.quota();
   const state=await fx.resources();expect(state.fallbacks[0]).toMatchObject({stage:"complete",selection:backups[1],newThreadId:"thr_replacement1"});
   expect(fx.spawnSelections[0]).toMatchObject({providerId:"opencode2",model:"approved/free",environment:{type:"reuse",environmentId:"env_task"}});
   expect(await fx.kv("session-task:proj_flow:main:thr_replacement1")).toBe(1);
   await fx.quota();expect(fx.spawnCalls()).toBe(1);
   expect(await fx.startAttempt("thr_dev","core-retry")).toMatchObject({action:"wait"});
   expect(await fx.startAttempt("thr_replacement1","continued-turn")).toMatchObject({action:"proceed"});
   const report=await fx.asCli(["task","update","1","--status","review","--review",JSON.stringify({result:"Unfinished profile preserved across handoff",artifacts:["profile.ts"],checks:[{what:"Fixture verified same environment and task binding",result:"env_task/task1 preserved"}],problems:[]})],"thr_replacement1");
   expect(report.exitCode,report.stderr).toBe(0);
   const listed=await fx.cli(["task","list","--all"]);const id=(listed.tasks as Array<{review:{submission:{id:string}}}>)[0]!.review.submission.id;
   const accepted=await fx.asCli(["task","done","1","--reason","Compared the bound environment, task and fixture evidence","--expected-submission",id],"thr_lead");expect(accepted.exitCode,accepted.stderr).toBe(0);
   expect((await fx.resources()).starts).toBe(2);
  }finally{await fx.dispose();}
 });
 it("skips an unavailable saved backup without substituting its model",async()=>{
  const fx=await setup({fallbacks:[{provider:"codex",model:"removed-model"},backups[1]!]});try{
   await fx.cli(["task","add","dev","Continue profile","--send"]);await fx.cli(["checkpoint","1","--file","checkpoint.json"]);
   await fx.startAttempt("thr_dev","first");await fx.quota();
   expect((await fx.resources()).fallbacks[0]).toMatchObject({stage:"complete",selection:backups[1]});expect(fx.spawnSelections).toHaveLength(1);
  }finally{await fx.dispose();}
 });
 it("an uncertain quota prompt release keeps one canonical session and never re-sends",async()=>{
  const fx=await setup({fallbacks:backups});try{
   await fx.cli(["task","add","dev","Continue profile","--send"]);await fx.cli(["checkpoint","1","--file","checkpoint.json"]);await fx.startAttempt("thr_dev","first");fx.failNextRelease();
   await fx.quota();const state=await fx.resources();expect(state.fallbacks[0]).toMatchObject({stage:"error",newThreadId:"thr_replacement1"});expect(state.fallbacks[0]?.reason).toContain("release_failed");
   const sent=fx.sent.length;await fx.quota();expect(fx.spawnCalls()).toBe(1);expect(fx.sent).toHaveLength(sent);
   expect(await fx.startAttempt("thr_replacement1","do-not-retry")).toMatchObject({action:"wait"});
   expect(await fx.kv("active-session:proj_flow:main:dev")).toBe("thr_replacement1");
  }finally{await fx.dispose();}
 });
 for(const scenario of ["accepted-input","work-after-checkpoint"] as const)it(`${scenario}: Git equality does not prove the checkpoint covers side effects`,async()=>{
  const fx=await setup({fallbacks:backups});try{
   await fx.cli(["task","add","dev","Continue profile","--send"]);await fx.cli(["checkpoint","1","--file","checkpoint.json"]);await fx.startAttempt("thr_dev","first");
   await fx.quota("quota-1",scenario==="accepted-input",scenario==="work-after-checkpoint");
   const state=await fx.resources();expect(state.fallbacks[0]?.stage).toBe("error");expect(state.fallbacks[0]?.reason).toContain(scenario==="accepted-input"?"quota_input_accepted":"checkpoint_history_stale");expect(fx.spawnCalls()).toBe(0);
  }finally{await fx.dispose();}
 });
 for(const scenario of ["missing","stale","shared","uncertain"] as const)it(`${scenario}: refuses unsafe handoff without respawn`,async()=>{
  const fx=await setup({fallbacks:scenario==="shared"?[backups[0]!]:backups,spawnFailures:scenario==="uncertain"?1:0});try{
   await fx.cli(["task","add","dev","Continue profile","--send"]);
   if(scenario!=="missing")await fx.cli(["checkpoint","1","--file","checkpoint.json"]);
   if(scenario==="stale")await fx.writeAfterCheckpoint();
   await fx.startAttempt("thr_dev","first");await fx.quota();
   const state=await fx.resources();expect(state.fallbacks[0]?.stage).toBe(scenario==="shared"?"blocked":"error");
   const first=fx.spawnCalls();expect(first).toBe(scenario==="uncertain"?1:0);
   await fx.quota();await fx.emitIdle("thr_dev");expect(fx.spawnCalls()).toBe(first);
   if(scenario==="missing"){expect(state.fallbacks[0]?.reason).toContain("checkpoint_missing");expect((await fx.snapshotRole("dev")).executionState).toMatchObject({kind:"error",errorCode:"resource_hold"});}
   if(scenario==="stale")expect(state.fallbacks[0]?.reason).toContain("checkpoint_stale");
  }finally{await fx.dispose();}
 });
});


it("role pause holds future turns and resume releases the same session",async()=>{
 const f=await setup();try {
  await f.control({action:"pause",expectedThreadId:"thr_dev"});
  expect((await f.startAttempt("thr_dev","held")) as object).toMatchObject({action:"wait"});
  expect(f.spawnCount()).toBe(0);
  expect(await f.control({action:"resume",expectedThreadId:"thr_dev"})).toMatchObject({paused:false,threadId:"thr_dev"});
 }finally{await f.dispose();}
});
it("handoff rejects a changed session and unapproved backup before spawn",async()=>{
 const f=await setup();try {
  await expect(f.control({action:"pause",expectedThreadId:"stale"})).rejects.toThrow(/Session changed/);
  await expect(f.control({action:"switch",expectedThreadId:"thr_dev",selection:{provider:"paid",model:"arbitrary"}})).rejects.toThrow(/approved/);
  expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});
it("approved handoff reuses the checkpoint task/environment and keeps new session paused",async()=>{
 const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};
 const f=await setup({fallbacks:[selection]});try {
  await f.cli(["task","add","dev","Profile","--send"]);
  await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  const result=await f.control({action:"switch",expectedThreadId:"thr_dev",selection});
  expect(result.paused).toBe(true);expect(result.threadId).not.toBe("thr_dev");expect(f.spawnCount()).toBe(1);
  expect(f.spawnSelections[0]).toMatchObject({providerId:"opencode2",model:"approved/free",environment:{type:"reuse",environmentId:"env_task"}});
  expect((await f.startAttempt(result.threadId!,"new-held")) as object).toMatchObject({action:"wait"});
 }finally{await f.dispose();}
});

it("an exhausted cached Ollama pool survives a failed refresh without a model call",async()=>{
 const f=await setup();try {
  await f.setKv("ollama-usage:host_local",{status:"ready",checkedAtMs:0,windows:[{name:"weekly",remainingPercent:0,resetsAtMs:null}],reason:null});
  const value=await f.rpc("ollamaUsage",{projectId:"proj_flow",team:"main",refresh:true});
  expect(value).toMatchObject({status:"unavailable",observedAtMs:0,windows:[{name:"weekly",remainingPercent:0}]});
  expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});
it("busy handoff refuses spawning and holds the role until explicit resume",async()=>{
 const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};
 const f=await setup({fallbacks:[selection]});try {
  await f.cli(["task","add","dev","Profile","--send"]);await f.cli(["checkpoint","1","--file","checkpoint.json"]);f.setStatus("thr_dev","active");
  await expect(f.control({action:"switch",expectedThreadId:"thr_dev",selection})).rejects.toThrow(/active operation/);
  expect(f.spawnCount()).toBe(0);expect(await f.control({action:"status"})).toMatchObject({paused:true});
 }finally{await f.dispose();}
});
it("doctor exposes a resource stop instead of claiming all is good",async()=>{
 const f=await setup();try {
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"One finite start",policy:{taskAttempts:1,teamStarts:100,tokens:null,minutes:null}});
  await f.cli(["task","add","dev","Profile","--send"]);await f.startAttempt("thr_dev","only-start");
  const result=await f.doctor();const data=JSON.parse(result.stdout);expect(data.fail).toBeGreaterThan(0);expect(data.checks.some((c:{check:string;level:string})=>c.check==="resources"&&c.level==="fail")).toBe(true);
 }finally{await f.dispose();}
});

it("manual model recovery needs no preconfigured backup, previews first and preserves scoped approval",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","Profile","--send"]);await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string;blockers:string[];environmentId:string};
  expect(view.blockers).toEqual([]);expect(view.environmentId).toBe("env_task");expect(f.spawnCount()).toBe(0);
  const result=await f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,expectedRecoveryRevision:view.revision});
  expect(result.paused).toBe(true);expect(f.spawnSelections[0]).toMatchObject({providerId:"opencode2",model:"approved/free",environment:{type:"reuse",environmentId:"env_task"}});
  await expect(f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,expectedRecoveryRevision:view.revision})).rejects.toThrow(/changed/);
  expect(f.spawnCount()).toBe(1);
  await f.control({action:"resume",expectedThreadId:result.threadId});await f.emitIdle(result.threadId!);
  await f.cli(["checkpoint","1","--file","checkpoint.json"]);await f.cli(["replace","dev"]);
  expect(f.spawnSelections[1]).toMatchObject({providerId:"opencode2",model:"approved/free"});
 }finally{await f.dispose();}
});
it("recovery preview explains busy/missing state and stale preview cannot spawn",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","Profile","--send"]);
  let view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string;blockers:string[]};
  expect(view.blockers).toContain("checkpoint_missing");expect(f.spawnCount()).toBe(0);
  await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as typeof view;
  f.setStatus("thr_dev","active");
  const busy=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as typeof view;expect(busy.blockers).toContain("busy");
  await expect(f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,expectedRecoveryRevision:view.revision})).rejects.toThrow(/changed/);expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});
it("recovery preview rejects invalid models and exhausted Ollama selection before mutation",async()=>{
 const f=await setup();try{
  await f.cli(["task","add","dev","Profile","--send"]);await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection:{provider:"missing",model:"unavailable"}}) as {blockers:string[]};expect(view.blockers).toContain("model_unavailable");
  await f.setKv("ollama-usage:host_local",{status:"ready",checkedAtMs:Date.now(),windows:[{name:"weekly",remainingPercent:0,resetsAtMs:null}],reason:null});
  const quota=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection:{provider:"pi",model:"ollama-cloud/any"}}) as {blockers:string[]};expect(quota.blockers).toContain("quota_exhausted");expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});
it("explicit workspace recovery works without the exhausted model's checkpoint and preserves dirty work",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","Profile","--send"]);
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string;blockers:string[]};expect(view.blockers).toContain("checkpoint_missing");
  const result=await f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,recoverFromWorkspace:true,expectedRecoveryRevision:view.revision});
  expect(result.paused).toBe(true);expect(f.spawnCount()).toBe(1);expect(f.spawnSelections[0]?.environment).toEqual({type:"reuse",environmentId:"env_task"});
  const role=await f.snapshotRole("dev");const task=(role.tasks as Array<{id:number;checkpoint:{content:{progress:string;nextAction:string};dirtyFiles:string[]}}>)[0]!;
  expect(task.id).toBe(1);expect(task.checkpoint.content.progress).toContain("unconfirmed");expect(task.checkpoint.content.nextAction).toContain("First inventory");expect(task.checkpoint.dirtyFiles).toContain("profile.ts");
 }finally{await f.dispose();}
});
it("workspace recovery preserves an older checkpoint as history instead of asserting its claims",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","Profile","--send"]);await f.cli(["checkpoint","1","--file","checkpoint.json"]);await f.writeAfterCheckpoint();
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string;blockers:string[]};expect(view.blockers).toContain("checkpoint_stale");
  await f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,recoverFromWorkspace:true,expectedRecoveryRevision:view.revision});
  const role=await f.snapshotRole("dev");const task=(role.tasks as Array<{decisions:string;checkpoint:{content:{progress:string}}}>)[0]!;
  expect(task.decisions).toContain("Previous checkpoint preserved");expect(task.decisions).toContain("Edited profile.ts");expect(task.checkpoint.content.progress).toContain("unconfirmed");
 }finally{await f.dispose();}
});

it("workspace recovery never bypasses queued messages",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","Profile","--send"]);f.setQueued("thr_dev",true);
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string;blockers:string[]};expect(view.blockers).toContain("queue");
  await expect(f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,recoverFromWorkspace:true,expectedRecoveryRevision:view.revision})).rejects.toThrow(/queue/);expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});
it("queue admission explains the Team limit without changing counts or creating work",async()=>{
 const f=await setup();try{
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"One allowed start",policy:{taskAttempts:8,coordinationAttempts:1,teamStarts:100,tokens:null,minutes:null}});
  await f.cli(["task","add","lead","Coordinate","--send"]);
  await f.startAttempt("thr_lead","first");await f.emitIdle("thr_lead");
  const before=await f.resources();
  const result=await f.startAttempt("thr_lead","next") as {action:string;reason:string};
  expect(result.action).toBe("wait");
  expect(result.reason).toMatch(/internal plugin limit|внутреннее ограничение/);
  expect(result.reason).toMatch(/not provider quota|не квота провайдера/);
  expect((await f.resources()).starts).toBe(before.starts);expect(f.spawnCalls()).toBe(0);
 }finally{await f.dispose();}
});

it("coordination continuation records the reason in the task without changing overall policy",async()=>{
 const f=await setup();try{
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"One coordination turn",policy:{taskAttempts:8,coordinationAttempts:1,teamStarts:100,tokens:null,minutes:null}});
  await f.cli(["task","add","lead","Coordinate","--send"]);
  await f.startAttempt("thr_lead","coord-one");await f.emitIdle("thr_lead");
  const before=await f.resources();expect(before.blocked).toBeNull();expect(before.taskBlocks?.["task:1"]).toContain("task:1");
  const result=await f.rpc("continueCoordination",{projectId:"proj_flow",team:"main",taskId:1,expectedStarts:before.starts,expectedUsed:1}) as ResourceSummary;
  expect(result.policy).toEqual(before.policy);expect(result.taskLimits?.["task:1"]).toBe(5);expect(result.starts).toBe(before.starts);
  const lead=await f.snapshotRole("lead");expect((lead.tasks as Array<{decisions:string}>)[0]?.decisions).toContain("up to four additional lead starts");
  await expect(f.rpc("continueCoordination",{projectId:"proj_flow",team:"main",taskId:1,expectedStarts:before.starts,expectedUsed:1})).rejects.toThrow(/changed/);
 }finally{await f.dispose();}
});

it("a manual model choice expires after the task instead of becoming a new permanent primary",async()=>{
 const f=await setup();const selection={provider:"opencode2",model:"approved/free",reasoningLevel:"low"};try{
  await f.cli(["task","add","dev","First","--send"]);await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  const view=await f.rpc("roleRecovery",{projectId:"proj_flow",team:"main",role:"dev",selection}) as {revision:string};
  const switched=await f.control({action:"switch",expectedThreadId:"thr_dev",selection,approveSelection:true,expectedRecoveryRevision:view.revision});
  await f.control({action:"resume",expectedThreadId:switched.threadId});await f.emitIdle(switched.threadId!);await f.cli(["checkpoint","1","--file","checkpoint.json"]);
  await f.cli(["task","done","1","--reason","Manually inspected the completed work"]);await f.cli(["task","add","dev","Second","--send"]);
  expect(f.spawnSelections).toHaveLength(2);expect(f.spawnSelections[1]?.providerId).not.toBe("opencode2");
 }finally{await f.dispose();}
});

it("startup restoration runs as an SDK service after registration",async()=>{
 const f=await setup();let service:ReturnType<Fixture["restore"]>|undefined;try{
  await f.cli(["task","add","dev","Profile","--send"]);
  await f.setKv("auto-continue:proj_flow:main:dev",{taskId:1,reason:"context",originThreadId:"thr_dev",stage:"awaiting-safe-boundary",errorCode:null,error:null,notifiedStage:null,requestedAtMs:Date.now(),updatedAtMs:Date.now()});
  expect(f.spawnCount()).toBe(0);service=f.restore();
  await expect.poll(async()=>((await f.kv("auto-continue:proj_flow:main:dev")) as {stage:string}).stage).toBe("awaiting-checkpoint");expect(f.spawnCount()).toBe(0);
 }finally{await service?.stop();await f.dispose();}
});
it("future primary model changes retain the actual current session model and do not restart it",async()=>{
 const f=await setup({fallbacks:[{provider:"opencode2",model:"approved/free"}]});try{
  const profile=await f.rpc("rolePolicy",{projectId:"proj_flow",team:"main",role:"dev"}) as {revision:string};
  await f.rpc("rolePolicy",{projectId:"proj_flow",team:"main",role:"dev",expectedRevision:profile.revision,primary:{provider:"opencode2",model:"approved/free",reasoningLevel:"low"}});
  const current=await f.control({action:"status"}) as {actual?:{provider:string;model:string}};expect(current.actual).toMatchObject({provider:"pi",model:"ollama-cloud/original"});expect(f.spawnCount()).toBe(0);
  const saved=await f.rpc("rolePolicy",{projectId:"proj_flow",team:"main",role:"dev"}) as {role:{provider:string}};expect(saved.role.provider).toBe("opencode2");
 }finally{await f.dispose();}
});

it("future-only profile editing refuses when unfinished work appeared",async()=>{
 const f=await setup();try{
  const profile=await f.rpc("rolePolicy",{projectId:"proj_flow",team:"main",role:"dev"}) as {revision:string};
  await f.cli(["task","add","dev","Started after the form opened","--send"]);
  await expect(f.rpc("rolePolicy",{projectId:"proj_flow",team:"main",role:"dev",expectedRevision:profile.revision,futureOnly:true,expectedThreadId:"thr_dev",primary:{provider:"opencode2",model:"approved/free"}})).rejects.toThrow(/Work started/);expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});

it("budget-held auto continuation does not ask a model for a checkpoint or create a cold session",async()=>{
 const f=await setup();try{
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"One start",policy:{taskAttempts:1,teamStarts:null,tokens:null,minutes:null}});
  await f.cli(["task","add","dev","Profile","--send"]);
  await f.startAttempt("thr_dev","one");await f.emitIdle("thr_dev");
  await f.setKv("auto-continue:proj_flow:main:dev",{taskId:1,reason:"context",originThreadId:"thr_dev",stage:"awaiting-safe-boundary",errorCode:null,error:null,notifiedStage:null,requestedAtMs:Date.now(),updatedAtMs:Date.now()});
  const sent=f.sent.length;await f.emitIdle("thr_dev");expect(f.sent).toHaveLength(sent);expect(f.spawnCount()).toBe(0);
 }finally{await f.dispose();}
});

it("a lead coordination hold does not falsely turn a worker's submitted review into an execution error",async()=>{
 const f=await setup();try{
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"Finite coordination",policy:{taskAttempts:8,coordinationAttempts:1,teamStarts:100,tokens:null,minutes:null}});
  await f.cli(["task","add","lead","Coordinate","--send"]);await f.cli(["task","add","dev","Profile","--send"]);await f.cli(["task","update","2","--status","review"]);
  await f.startAttempt("thr_lead","one");await f.emitIdle("thr_lead");
  expect((await f.snapshotRole("lead")).executionState).toMatchObject({kind:"error",errorCode:"resource_hold"});expect((await f.snapshotRole("dev")).executionState).toMatchObject({kind:"awaiting-acceptance"});
 }finally{await f.dispose();}
});

it("explicit employee resume re-arms only the deterministic old factory error",async()=>{
 const fx=await setup();try{
  const {task}=await fx.cli(["task","add","dev","First","--send"]) as {task:{id:number|string}};
  const key="auto-continue:proj_flow:main:dev";
  const record={taskId:task.id,originThreadId:"thr_dev",reason:"context",stage:"failed",errorCode:"auto_continue_failed",error:"bd list: host plugin calls are unavailable during factory registration; call from a handler, service, or timer",notifiedStage:null,requestedAtMs:Date.now(),updatedAtMs:Date.now()};
  await fx.setKv(key,record);await fx.control({action:"resume",expectedThreadId:"thr_dev"});
  expect((await fx.kv(key) as {stage:string}).stage).toBe("awaiting-checkpoint");expect(fx.spawnCalls()).toBe(0);
  await fx.setKv(key,{...record,error:"spawn result unknown",errorCode:"spawn_uncertain"});await fx.control({action:"resume",expectedThreadId:"thr_dev"});
  expect((await fx.kv(key) as {stage:string}).stage).toBe("failed");expect(fx.spawnCalls()).toBe(0);
 }finally{await fx.dispose();}
});

it("package budget edits record grounds without changing review and reject stale forms",async()=>{
 const f=await setup();try{
  await f.cli(["task","add","dev","Profile","--send"]);await f.startAttempt("thr_dev","one");await f.emitIdle("thr_dev");
  const input={projectId:"proj_flow",team:"main",taskId:1,limit:12,expectedLimit:8,expectedUsed:1,reason:"Complete the missing acceptance checks"};
  const summary=await f.rpc("packageBudget",input) as ResourceSummary;
  expect(summary.starts).toBe(1);expect(summary.taskLimits?.["task:1"]).toBe(12);
  const role=await f.snapshotRole("dev"),task=(role.tasks as Array<{decisions:string;status:string}>)[0]!;
  expect(task.decisions).toContain(input.reason);expect(task.status).toBe("in-progress");
  await expect(f.rpc("packageBudget",input)).rejects.toThrow(/changed/);
  await f.cli(["task","done","1","--reason","Manually checked"]);
  await expect(f.rpc("packageBudget",{...input,expectedLimit:12})).rejects.toThrow(/changed/);
 }finally{await f.dispose();}
});

it("records a budget agreement in a direct user lead turn and rejects automatic or worker grants",async()=>{
 const f=await setup();try{
  await f.rpc("resources",{projectId:"proj_flow",team:"main",reason:"One lead start",policy:{taskAttempts:8,coordinationAttempts:1,teamStarts:null,tokens:null,minutes:null}});
  await f.cli(["task","add","lead","Coordinate profile","--send"]);await f.startAttempt("thr_lead","first");await f.emitIdle("thr_lead");
  const args=["budget","1","--limit","6","--expected-limit","1","--expected-used","2","--reason","User approved six total starts for Coordinate profile"];
  expect((await f.asCli(args,"thr_dev")).exitCode).not.toBe(0);
  expect((await f.asCli(args,"thr_lead")).exitCode).not.toBe(0);
  expect(await f.startUser("thr_lead","I approve six total starts for Coordinate profile")).toMatchObject({action:"proceed"});f.setStatus("thr_lead","active");
  const sent=f.sent.length;const changed=await f.asCli(args,"thr_lead");expect(changed.exitCode,changed.stderr).toBe(0);
  expect(JSON.parse(changed.stdout)).toMatchObject({title:"Coordinate profile",used:2,limit:6,sharedStartCap:null});expect(f.sent).toHaveLength(sent);
  const task=(await f.snapshotRole("lead")).tasks as Array<{decisions:string}>;expect(task[0]?.decisions).toContain("user chat, start");
  expect((await f.asCli(args,"thr_lead")).exitCode).not.toBe(0);
  await f.emitIdle("thr_lead");expect((await f.asCli(["budget","1","--limit","7","--expected-limit","6","--expected-used","2","--reason","reuse old approval"],"thr_lead")).exitCode).not.toBe(0);
 }finally{await f.dispose();}
});
it("an increase with an empty lead queue notifies the lead using the package title",async()=>{
 const f=await setup();try{
  await f.cli(["task","add","lead","Coordinate profile"]);const before=f.sent.length;
  await f.rpc("packageBudget",{projectId:"proj_flow",team:"main",taskId:1,limit:44,expectedLimit:40,expectedUsed:0,reason:"Check the current review"});
  expect(f.sent).toHaveLength(before+1);expect(f.sent.at(-1)).toMatchObject({threadId:"thr_lead",text:expect.stringContaining('"Coordinate profile"')});
  expect(f.sent.at(-1)?.text).toContain("no team-wide start cap");
 }finally{await f.dispose();}
});


describe("manual native Codex quota recovery",()=>{
  it("releases a failed session after fresh capacity without replacing it or resetting spend",async()=>{
    const f=await setup({codexUsage:{status:"ok",windows:[{label:"Session",usedPercent:36,resetsAt:null},{label:"Weekly",usedPercent:64,resetsAt:null}]}});
    try {
      await f.cli(["task","add","dev","Resume existing work","--send"]);f.setQueued("thr_dev",false);await f.quota();const before=await f.resources();expect(before.holds["task:1"]).toBe("budget-exceeded");
      await f.control({action:"resume",expectedThreadId:"thr_dev"});
      const after=await f.resources();expect(after.starts).toBe(before.starts);expect(after.policy).toEqual(before.policy);
      expect(after.holds["task:1"]).toBeUndefined();expect(after.quotaBlocks).toEqual([]);
      expect(after.fallbacks[0]).toMatchObject({manualReleased:true,newThreadId:null});expect(f.spawnCalls()).toBe(0);
      expect(await f.startAttempt("thr_dev","explicit-retry")).toMatchObject({action:"proceed"});
      expect((await f.resources()).starts).toBe(before.starts+1);
    }finally{await f.dispose();}
  });
  for(const [name,usage,env] of [
    ["weekly at threshold",{status:"ok",windows:[{usedPercent:1},{usedPercent:90}]},[]],
    ["missing windows",{status:"ok",windows:[]},[]],
    ["unavailable",{status:"error"},[]],
    ["invalid percentage",{status:"ok",windows:[{usedPercent:NaN}]},[]],
    ["credential override",{status:"ok",windows:[{usedPercent:1}]},["CODEX_HOME"]],
  ] as const)it(`keeps the hold when ${name}`,async()=>{
    const f=await setup({codexUsage:usage,codexEnv:[...env]});try{
      await f.cli(["task","add","dev","Resume existing work","--send"]);f.setQueued("thr_dev",false);await f.quota();const before=await f.resources();
      await expect(f.control({action:"resume",expectedThreadId:"thr_dev"})).rejects.toThrow();
      const after=await f.resources();expect(after.holds).toEqual(before.holds);expect(after.quotaBlocks).toEqual(before.quotaBlocks);expect(after.starts).toBe(before.starts);
    }finally{await f.dispose();}
  });
});
