import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  activeSessionKey,
  readReplacementIntent,
  replaceSession,
  ReplacementError,
  replacementKey,
} from "./sessions";

/* ── Test fixtures ── */

type FakeThreadStatus =
  | "idle"
  | "error"
  | "active"
  | "starting"
  | "pending"
  | "stopping";

interface FakeThread {
  id: string;
  projectId: string;
  status: FakeThreadStatus;
  parentThreadId: string | null;
  environmentId: string | null;
  lifecycleOwnerThreadId: string | null;
  archivedAt: number | null;
  activeBackgroundAgentCount: number;
  activeBackgroundCommandCount: number;
  activeGoalCount: number;
  activePlanModeCount: number;
  activeWorkflowCount: number;
  hasPendingInteraction: boolean;
  queuedMessageCount: number;
  providerId: string;
  title: string;
  metadata: Record<string, unknown>;
}

function threadDefaults(): Omit<FakeThread, "id"> {
  return {
    projectId: "proj_1",
    status: "idle",
    parentThreadId: null,
    environmentId: "env_1",
    lifecycleOwnerThreadId: null,
    archivedAt: null,
    activeBackgroundAgentCount: 0,
    activeBackgroundCommandCount: 0,
    activeGoalCount: 0,
    activePlanModeCount: 0,
    activeWorkflowCount: 0,
    hasPendingInteraction: false,
    queuedMessageCount: 0,
    providerId: "pi",
    title: "Role thread",
    metadata: { teamRole: "developer", teamName: "team-a", teamNotifyOn: [] },
  };
}

interface Host {
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  harness: ReturnType<typeof createFakePluginHost>["harness"];
  threads: Map<string, FakeThread>;
  queuePrompt(threadId: string, text: string): void;
  spawnCount(): number;
  releaseCount(): number;
  archiveCount(): number;
  setSpawnError(error: string | null): void;
  setArchiveFailOnce(error: string): void;
  setReleaseFailOnce(error: string): void;
  setAfterSwitchFailOnce(error: string): void;
  afterSwitchCalls: string[];
  afterSwitchFailOnce: string | null;
}

function makeHost(initial: FakeThread[] = []): Host {
  const threads = new Map<string, FakeThread>();
  for (const t of initial) {
    threads.set(t.id, { ...threadDefaults(), ...t });
  }
  let spawnCounter = 0;
  let releaseCounter = 0;
  let archiveCounter = 0;
  let sendError: string | null = null;
  let spawnError: string | null = null;
  let archiveFailOnce: string | null = null;
  let releaseFailOnce: string | null = null;
  const queued = new Map<
    string,
    { type: "text"; text: string; mentions: [] }[]
  >();
  const afterSwitchCalls: string[] = [];
  let afterSwitchFailOnce: string | null = null;

  const toResponse = (t: FakeThread) =>
    makeThreadResponse({
      id: t.id,
      projectId: t.projectId,
      status: t.status,
      parentThreadId: t.parentThreadId,
      environmentId: t.environmentId,
      lifecycleOwnerThreadId: t.lifecycleOwnerThreadId,
      archivedAt: t.archivedAt,
      activeBackgroundAgentCount: t.activeBackgroundAgentCount,
      queuedMessageCount: t.queuedMessageCount,
      providerId: t.providerId,
      title: t.title,
    });

  const toListRow = (t: FakeThread) => ({
    ...toResponse(t),
    activity: {
      activeBackgroundAgentCount: t.activeBackgroundAgentCount,
      activeBackgroundCommandCount: t.activeBackgroundCommandCount,
      activeGoalCount: t.activeGoalCount,
      activePlanModeCount: t.activePlanModeCount,
      activeWorkflowCount: t.activeWorkflowCount,
    },
    hasPendingInteraction: t.hasPendingInteraction,
    queuedWork: "none" as const,
    environmentBranchName: null,
    environmentHostId: "host_1",
    environmentIsWorktree: true,
    environmentName: null,
    environmentPath: "/ws/demo",
    environmentProviderId: "project-checkout",
    environmentWorkspaceDisplayKind: "managed-worktree" as const,
    pinSortKey: null,
  });

  const descendantsOf = (id: string): string[] => {
    const result: string[] = [];
    for (const t of threads.values()) {
      if (t.parentThreadId === id) {
        result.push(t.id);
        result.push(...descendantsOf(t.id));
      }
    }
    return result;
  };

  const host: Host = {
    bb: null as unknown as ReturnType<typeof createFakePluginHost>["bb"],
    harness: null as unknown as ReturnType<
      typeof createFakePluginHost
    >["harness"],
    threads,
    queuePrompt: (id, text) =>
      queued.set(id, [{ type: "text", text, mentions: [] }]),
    spawnCount: () => spawnCounter,
    releaseCount: () =>
      (host.harness?.inspection.recheckCount as number | undefined) ?? 0,
    archiveCount: () => archiveCounter,
    setSendError: (e) => {
      sendError = e;
    },
    setSpawnError: (e) => {
      spawnError = e;
    },
    setArchiveFailOnce: (e) => {
      archiveFailOnce = e;
    },
    setReleaseFailOnce: (e) => {
      releaseFailOnce = e;
    },
    setAfterSwitchFailOnce: (e) => {
      host.afterSwitchFailOnce = e;
    },
    afterSwitchCalls,
    afterSwitchFailOnce: null,
  };

  const { bb, harness } = createFakePluginHost({
    pluginId: "team",
    sdk: {
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
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (!t) throw new Error(`thread not found: ${threadId}`);
          return toResponse(t);
        },
        spawn: async (args: Record<string, unknown>) => {
          spawnCounter += 1;
          if (spawnError) throw new Error(spawnError);
          const input = args.input as
            | Array<Record<string, unknown>>
            | undefined;
          if (!input || input.length === 0) {
            throw new Error("input must contain at least one entry");
          }
          const meta =
            (args.pluginMetadata as Record<string, unknown> | undefined) ?? {};
          const env = args.environment as
            | { type: string; environmentId?: string }
            | undefined;
          const id = `thr_new${spawnCounter}`;
          const t: FakeThread = {
            ...threadDefaults(),
            id,
            projectId: (args.projectId as string) ?? "proj_1",
            status: "idle",
            parentThreadId: (args.parentThreadId as string) ?? null,
            environmentId: env?.environmentId ?? null,
            providerId: (args.providerId as string) ?? "pi",
            title: (args.title as string) ?? id,
            metadata: { ...meta },
          };
          t.status = "pending";
          t.queuedMessageCount = 1;
          queued.set(
            id,
            args.input as { type: "text"; text: string; mentions: [] }[],
          );
          threads.set(id, t);
          return toResponse(t);
        },
        list: async (
          args: { threadIds?: readonly string[]; projectId?: string } = {},
        ) => {
          return [...threads.values()]
            .filter((t) => !t.archivedAt)
            .filter(
              (t) =>
                (!args.projectId || t.projectId === args.projectId) &&
                (!args.threadIds ||
                  args.threadIds.length === 0 ||
                  args.threadIds.includes(t.id)),
            )
            .map(toListRow);
        },
        update: async ({
          threadId,
          parentThreadId,
        }: {
          threadId: string;
          parentThreadId?: string;
        }) => {
          const t = threads.get(threadId)!;
          if (parentThreadId !== undefined) t.parentThreadId = parentThreadId;
          return toResponse(t);
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
          if (set) t.metadata = { ...t.metadata, ...set };
          if (remove) for (const key of remove) delete t.metadata[key];
          return t.metadata;
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archiveCounter += 1;
          if (archiveFailOnce) {
            const err = archiveFailOnce;
            archiveFailOnce = null;
            throw new Error(err);
          }
          const t = threads.get(threadId)!;
          t.archivedAt = Date.now();
          return { archivedThreadIds: [threadId] };
        },
        send: async ({
          threadId,
          input,
        }: {
          threadId: string;
          input: Array<{ type: string; text: string }>;
        }) => {
          if (sendError) throw new Error(sendError);
          return { ok: true, delivered: input.length };
        },
        experimental_listDescendants: async ({
          threadIds,
        }: {
          threadIds: string[];
        }) => ({
          threads: threadIds.map((id) => ({
            threadId: id,
            descendantIds: descendantsOf(id),
          })),
        }),
      },
    },
  });

  host.bb = bb;
  host.harness = harness;
  const recheck = bb.experimental_hooks.recheck;
  bb.experimental_hooks.recheck = async (hook) => {
    if (releaseFailOnce) {
      const error = releaseFailOnce;
      releaseFailOnce = null;
      throw new Error(error);
    }
    await recheck(hook);
    for (const id of queued.keys()) {
      const thread = threads.get(id)!;
      if (
        thread.metadata.teamRetired !== true &&
        thread.metadata.teamReplacement !== true
      ) {
        queued.delete(id);
        thread.queuedMessageCount = 0;
        thread.status = "idle";
      }
    }
  };
  return host;
}

function baseInput(
  host: Host,
  overrides: Partial<Parameters<typeof replaceSession>[1]> = {},
): Parameters<typeof replaceSession>[1] {
  return {
    projectId: "proj_1",
    team: "team-a",
    role: "developer",
    oldThreadId: "thr_old",
    environmentId: "env_1",
    spawnArgs: {
      projectId: "proj_1",
      title: "Fresh developer",
      providerId: "pi",
      pluginMetadata: {
        teamRole: "developer",
        teamName: "team-a",
        teamNotifyOn: [],
      },
      prompt: "should be stripped",
      input: [{ type: "text", text: "ignored", mentions: [] }],
    } as unknown as Parameters<typeof replaceSession>[1]["spawnArgs"],
    prompt: "Continue the work.",
    keep: false,
    afterSwitch: async (id) => {
      if (host.afterSwitchFailOnce) {
        const err = host.afterSwitchFailOnce;
        host.afterSwitchFailOnce = null;
        throw new Error(err);
      }
      host.afterSwitchCalls.push(id);
    },
    ...overrides,
  };
}

/* ── Tests ── */

describe("replaceSession", () => {
  it("refuses an active old thread and performs no spawn or archive", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        status: "active",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toBeInstanceOf(ReplacementError);

    expect(host.spawnCount()).toBe(0);
    expect(host.archiveCount()).toBe(0);
  });

  it("spawns replacement with durable prompt and teamReplacement metadata", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await replaceSession(host.bb, baseInput(host));

    const spawnCalls = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]![0] as {
      input: Array<{ type: string; text: string; mentions: unknown[] }>;
      environment: { type: string; environmentId: string };
      pluginMetadata: Record<string, unknown>;
      prompt?: string;
    };
    expect(args.input).toEqual([
      { type: "text", text: "Continue the work.", mentions: [] },
    ]);
    expect(args.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(args.pluginMetadata).toEqual({
      teamReplacement: true,
      teamReplacementRole: "developer",
      teamReplacementTeam: "team-a",
    });
    expect(args.prompt).toBeUndefined();

    // One recheck to release the queued prompt.
    expect(host.releaseCount()).toBe(1);
  });

  it("reparents direct children including helpers", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_child1",
        parentThreadId: "thr_old",
        metadata: { teamHelperOf: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_child2",
        parentThreadId: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_unrelated",
        parentThreadId: "thr_other",
      } as FakeThread,
    ]);

    const result = await replaceSession(host.bb, baseInput(host));

    expect(result.reparented).toBe(2);
    expect(host.threads.get("thr_child1")!.parentThreadId).toMatch(/^thr_new/);
    expect(host.threads.get("thr_child2")!.parentThreadId).toMatch(/^thr_new/);
    expect(host.threads.get("thr_unrelated")!.parentThreadId).toBe("thr_other");
  });

  it("refuses replacement when a descendant has old as lifecycle owner", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_owned",
        parentThreadId: "thr_old",
        lifecycleOwnerThreadId: "thr_old",
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_has_lifecycle_owned_descendants" });

    expect(host.spawnCount()).toBe(0);
  });

  it("resumes after partial failures with exactly one spawn and one release", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_child",
        parentThreadId: "thr_old",
      } as FakeThread,
    ]);

    host.setArchiveFailOnce("archive down");

    await expect(replaceSession(host.bb, baseInput(host))).rejects.toThrow(
      "archive down",
    );

    expect(host.spawnCount()).toBe(1);
    expect(host.threads.get("thr_old")!.archivedAt).toBeNull();

    // Retry continues on the already-spawned idle fresh thread.
    const result = await replaceSession(host.bb, baseInput(host));

    expect(host.spawnCount()).toBe(1);
    expect(result.resumed).toBe(true);
    expect(host.threads.get("thr_old")!.archivedAt).not.toBeNull();
    expect(host.threads.get("thr_child")!.parentThreadId).toBe(
      result.newThreadId,
    );
    expect(host.releaseCount()).toBe(1);
  });

  it("does not recheck again on early complete retry", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    const first = await replaceSession(host.bb, baseInput(host));
    expect(host.releaseCount()).toBe(1);

    // Early complete retry is a no-op that does not recheck again.
    const second = await replaceSession(host.bb, baseInput(host));
    expect(second.newThreadId).toBe(first.newThreadId);
    expect(second.resumed).toBe(true);
    expect(host.spawnCount()).toBe(1);
    expect(host.releaseCount()).toBe(1);
  });

  it("keeps the old thread unbound but bound to the new canonical", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    const result = await replaceSession(
      host.bb,
      baseInput(host, { keep: true }),
    );

    const oldMeta = host.threads.get("thr_old")!.metadata;
    expect(oldMeta.teamRole).toBeUndefined();
    expect(oldMeta.teamName).toBeUndefined();
    expect(oldMeta.teamNotifyOn).toBeUndefined();
    expect(oldMeta.teamRetired).toBe(true);
    expect(host.threads.get("thr_old")!.archivedAt).toBeNull();

    const freshMeta = host.threads.get(result.newThreadId)!.metadata;
    expect(freshMeta.teamRole).toBe("developer");
    expect(freshMeta.teamRetired).toBe(false);
    expect(freshMeta.teamReplacement).toBe(false);

    expect(
      await host.bb.storage.kv.get(
        activeSessionKey("proj_1", "team-a", "developer"),
      ),
    ).toBe(result.newThreadId);
    expect(host.releaseCount()).toBe(1);
  });

  it("keeps canonical pointer and complete intent if recheck fails", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    // Temporarily swap bb.experimental_hooks.recheck with one that throws once.
    const originalRecheck = host.bb.experimental_hooks.recheck;
    let thrown = false;
    (
      host.bb.experimental_hooks as { recheck: (hook: string) => Promise<void> }
    ).recheck = async () => {
      if (!thrown) {
        thrown = true;
        throw new Error("recheck down");
      }
      return originalRecheck("message.dispatch");
    };

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "release_failed" });

    const intent = await readReplacementIntent(
      host.bb,
      "proj_1",
      "team-a",
      "developer",
    );
    expect(intent?.stage).toBe("complete");
    expect(intent?.delivery).toBe("sent");

    const canonical = await host.bb.storage.kv.get(
      activeSessionKey("proj_1", "team-a", "developer"),
    );
    expect(typeof canonical).toBe("string");
    expect(host.threads.get("thr_old")!.archivedAt).not.toBeNull();
  });

  it("records spawn uncertainty and refuses auto-respawn on retry", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    host.setSpawnError("timeout");

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "spawn_uncertain" });

    expect(host.spawnCount()).toBe(1);

    const intent = await readReplacementIntent(
      host.bb,
      "proj_1",
      "team-a",
      "developer",
    );
    expect(intent?.stage).toBe("spawn_uncertain");
    expect(intent?.newThreadId).toBeNull();

    // Retry must not attempt another spawn until the intent is reset.
    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "spawn_uncertain" });
    expect(host.spawnCount()).toBe(1);
  });

  it("accepts an already-archived old thread when resuming at prompting", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        archivedAt: Date.now(),
        metadata: { teamRetired: true },
      } as FakeThread,
    ]);

    const freshId = "thr_fresh";
    host.queuePrompt(freshId, baseInput(host).prompt);
    host.threads.set(freshId, {
      ...threadDefaults(),
      id: freshId,
      status: "idle",
      metadata: {
        teamRole: "developer",
        teamName: "team-a",
        teamRetired: false,
      },
    });
    await host.bb.storage.kv.set(
      activeSessionKey("proj_1", "team-a", "developer"),
      freshId,
    );
    await host.bb.storage.kv.set(
      replacementKey("proj_1", "team-a", "developer"),
      {
        oldThreadId: "thr_old",
        newThreadId: freshId,
        environmentId: "env_1",
        keep: false,
        stage: "prompting",
        delivery: "pending",
        reparented: 0,
        resumed: true,
        startedAt: Date.now(),
      },
    );

    const result = await replaceSession(host.bb, baseInput(host));

    expect(result.newThreadId).toBe(freshId);
    expect(result.resumed).toBe(true);
    expect(host.releaseCount()).toBe(1);
    expect(host.archiveCount()).toBe(0); // already archived
  });

  it("recovers old thread id from intent when canonical is already fresh", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    const freshId = "thr_fresh";
    host.queuePrompt(freshId, baseInput(host).prompt);
    host.threads.set(freshId, {
      ...threadDefaults(),
      id: freshId,
      status: "idle",
      metadata: { teamReplacement: true },
    });
    await host.bb.storage.kv.set(
      activeSessionKey("proj_1", "team-a", "developer"),
      freshId,
    );
    await host.bb.storage.kv.set(
      replacementKey("proj_1", "team-a", "developer"),
      {
        oldThreadId: "thr_old",
        newThreadId: freshId,
        environmentId: "env_1",
        keep: false,
        stage: "spawning",
        delivery: "pending",
        reparented: 0,
        resumed: true,
        startedAt: Date.now(),
      },
    );

    const result = await replaceSession(host.bb, baseInput(host));

    expect(result.newThreadId).toBe(freshId);
    expect(result.oldThreadId).toBe("thr_old");
    expect(result.resumed).toBe(true);
    expect(host.spawnCount()).toBe(0);
    expect(host.releaseCount()).toBe(1);
  });

  it("treats replacing the current fresh idle thread as a new operation", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    const first = await replaceSession(host.bb, baseInput(host));

    const freshThread = host.threads.get(first.newThreadId)!;
    freshThread.status = "idle";

    const second = await replaceSession(
      host.bb,
      baseInput(host, { oldThreadId: first.newThreadId }),
    );

    expect(second.newThreadId).not.toBe(first.newThreadId);
    expect(second.oldThreadId).toBe(first.newThreadId);
    expect(second.resumed).toBe(false);
    expect(host.spawnCount()).toBe(2);
    expect(host.releaseCount()).toBe(2);
  });

  it("refuses when the old thread environment does not match or is missing", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        environmentId: "env_2",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_environment_mismatch" });

    host.threads.get("thr_old")!.environmentId = null;
    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_environment_missing" });
  });

  it("refuses an idle old thread with active background commands", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        status: "idle",
        activeBackgroundCommandCount: 1,
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_has_background_activity" });
    expect(host.spawnCount()).toBe(0);
  });

  it("refuses an idle old thread with a pending interaction", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        status: "idle",
        hasPendingInteraction: true,
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_has_pending_interaction" });
    expect(host.spawnCount()).toBe(0);
  });

  it("lifecycle-owned descendants block replacement with keep=true too", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
      {
        id: "thr_owned",
        parentThreadId: "thr_old",
        lifecycleOwnerThreadId: "thr_old",
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host, { keep: true })),
    ).rejects.toMatchObject({ code: "old_has_lifecycle_owned_descendants" });

    expect(host.spawnCount()).toBe(0);
  });

  it("refuses old threads with active background agents or queued messages", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        activeBackgroundAgentCount: 1,
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_has_background_agents" });

    host.threads.get("thr_old")!.activeBackgroundAgentCount = 0;
    host.threads.get("thr_old")!.queuedMessageCount = 1;

    await expect(
      replaceSession(host.bb, baseInput(host)),
    ).rejects.toMatchObject({ code: "old_has_queued_messages" });
  });

  it("refuses to archive an old thread that became active before archive", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    await expect(
      replaceSession(
        host.bb,
        baseInput(host, {
          afterSwitch: async () => {
            host.threads.get("thr_old")!.status = "active";
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "old_active_before_archive" });

    expect(host.spawnCount()).toBe(1);
    const canonical = await host.bb.storage.kv.get(
      activeSessionKey("proj_1", "team-a", "developer"),
    );
    expect(typeof canonical).toBe("string");
    expect(host.threads.get("thr_old")!.archivedAt).toBeNull();
  });

  it("afterSwitch failure then retry resumes without respawn", async () => {
    const host = makeHost([
      {
        id: "thr_old",
        metadata: { teamRole: "developer", teamName: "team-a" },
      } as FakeThread,
    ]);

    host.setAfterSwitchFailOnce("history store down");

    await expect(replaceSession(host.bb, baseInput(host))).rejects.toThrow(
      "history store down",
    );

    expect(host.spawnCount()).toBe(1);
    expect(host.afterSwitchCalls).toHaveLength(0);

    const result = await replaceSession(host.bb, baseInput(host));

    expect(host.spawnCount()).toBe(1);
    expect(result.resumed).toBe(true);
    expect(host.afterSwitchCalls).toContain(result.newThreadId);
    expect(host.releaseCount()).toBe(1);
  });
});

describe("live pending handoff contract", () => {
  for (const own of [true, false])
    it(`${own ? "accepts" : "refuses"} pending session held by ${own ? "Team" : "another plugin"}`, async () => {
      const host = makeHost([{ id: "thr_old", ...threadDefaults() }]);
      const input = baseInput(host, {
        beforeSwitch: async () => {
          host.threads.get("thr_new1")!.status = "pending";
          host.threads.get("thr_new1")!.queuedMessageCount = 1;
        },
      });
      host.harness.sdk.stub("threads.queuedMessages.list", async () => [
        {
          state: "waiting",
          originPluginId: "team",
          waitingOn: { kind: "plugin", pluginId: own ? "team" : "other" },
          content: [{ type: "text", text: input.prompt, mentions: [] }],
        },
      ]);
      if (own) {
        const result = await replaceSession(host.bb, input);
        expect(result.newThreadId).toBe("thr_new1");
        expect(host.threads.get("thr_old")!.archivedAt).not.toBeNull();
        expect(host.releaseCount()).toBe(1);
      } else {
        await expect(replaceSession(host.bb, input)).rejects.toMatchObject({
          code: "fresh_not_idle",
        });
        expect(host.archiveCount()).toBe(0);
        expect(host.releaseCount()).toBe(0);
      }
    });
});

describe("core dispatcher preparation race", () => {
  it("waits for its existing claimed request to become Team-held without respawning", async () => {
    const host = makeHost([{ id: "thr_old", ...threadDefaults() }]);
    const input = baseInput(host);
    let reads = 0;
    host.harness.sdk.stub("threads.queuedMessages.list", async () => [
      {
        state: ++reads === 1 ? "claimed" : "waiting",
        originPluginId: "team",
        waitingOn: reads === 1 ? null : { kind: "plugin", pluginId: "team" },
        content: [{ type: "text", text: input.prompt, mentions: [] }],
      },
    ]);
    await replaceSession(host.bb, input);
    expect(reads).toBe(2);
    expect(host.spawnCount()).toBe(1);
    expect(host.releaseCount()).toBe(1);
  });
});
