import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type ReplacementInput = {
  projectId: string;
  team: string;
  role: string;
  oldThreadId: string;
  environmentId: string;
  /**
   * Base spawn arguments supplied by the parent. The module strips any `input`,
   * `prompt` and `pluginMetadata`, then creates the replacement with its
   * initial prompt held by Team in the core queue. Full role metadata (including
   * `teamRetired: false`) is applied only at the switch step.
   */
  spawnArgs: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
  /** Initial prompt queued once at spawn and released only after the switch. */
  prompt: string;
  /** Keep the old thread (unbound) instead of archiving it. */
  keep: boolean;
  /**
   * Parent-supplied revalidation right before the switch (checkpoint, git
   * fingerprint, workspace). Called under the existing scope lock.
   */
  beforeSwitch?: () => Promise<void>;
  /**
   * Parent-supplied idempotent post-switch hook: record execution history and
   * pause state. Re-invoked on retries after partial failures.
   */
  afterSwitch?: (newThreadId: string) => Promise<void>;
};

export type ReplacementResult = {
  oldThreadId: string;
  newThreadId: string;
  reparented: number;
  resumed: boolean;
};

export type ReplacementStage =
  | "spawning"
  | "switching"
  | "prompting"
  | "complete"
  | "spawn_uncertain";

export type ReplacementDelivery = "pending" | "sent" | "uncertain";

export type ReplacementIntent = {
  oldThreadId: string;
  newThreadId: string | null;
  environmentId: string;
  keep: boolean;
  /** Parent-visible lifecycle stage. Terminal value is `"complete"`. */
  stage: ReplacementStage;
  /** Whether the queued prompt has been released via recheck. */
  delivery: ReplacementDelivery;
  reparented: number;
  resumed: boolean;
  startedAt: number;
  completedAt?: number;
};

export class ReplacementError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Canonical pointer KV key: fresh thread id for a team role. */
export function activeSessionKey(
  projectId: string,
  team: string,
  role: string,
): string {
  return `active-session:${projectId}:${team}:${role}`;
}

/** In-progress replacement intent KV key (technical fields only). */
export function replacementKey(
  projectId: string,
  team: string,
  role: string,
): string {
  return `replacement:${projectId}:${team}:${role}`;
}

/** Read a persisted replacement intent from KV. */
export async function readReplacementIntent(
  bb: BbPluginApi,
  projectId: string,
  team: string,
  role: string,
): Promise<ReplacementIntent | null> {
  const raw = await bb.storage.kv.get(replacementKey(projectId, team, role));
  return parseIntent(raw);
}

const ROLE_METADATA_KEYS = ["teamRole", "teamName", "teamNotifyOn"];
const ROLE_RETIRED_KEY = "teamRetired";

export async function replaceSession(
  bb: BbPluginApi,
  input: ReplacementInput,
): Promise<ReplacementResult> {
  const canonicalKey = activeSessionKey(
    input.projectId,
    input.team,
    input.role,
  );
  const intentKey = replacementKey(input.projectId, input.team, input.role);

  const canonicalThreadId = await kvGetString(bb.storage.kv, canonicalKey);
  const storedIntent = await bb.storage.kv.get(intentKey);
  const parsedIntent = parseIntent(storedIntent);

  const { oldThreadId, intent, isRetry } = resolveState(
    input.oldThreadId,
    canonicalThreadId,
    parsedIntent,
  );

  // A previous spawn attempt is unresolved: never auto-respawn.
  if (intent?.stage === "spawn_uncertain") {
    throw new ReplacementError(
      `Spawn attempt for role ${input.role} is unresolved; inspect BB for a possibly-created thread and reset the intent manually`,
      "spawn_uncertain",
    );
  }

  // Completed replacement: surface result or legacy delivery uncertainty.
  if (intent?.stage === "complete") {
    if (intent.delivery === "uncertain") {
      throw new ReplacementError(
        `Prompt delivery to ${intent.newThreadId} is uncertain; run bb team resume`,
        "delivery_uncertain",
      );
    }
    return {
      oldThreadId: intent.oldThreadId,
      newThreadId: intent.newThreadId!,
      reparented: intent.reparented,
      resumed: true,
    };
  }

  if (intent?.stage === "prompting" && intent.delivery === "uncertain") {
    throw new ReplacementError(
      `Prompt delivery to ${intent.newThreadId} is uncertain; run bb team resume`,
      "delivery_uncertain",
    );
  }

  // ── Preflight ──
  const oldThread = await bb.sdk.threads.get({ threadId: oldThreadId });

  // Retries that already archived the old thread (or were asked to keep it)
  // may find it archived; accept that and only enforce constraints on live old.
  if (!oldThread.archivedAt) {
    if (oldThread.status !== "idle" && oldThread.status !== "error") {
      throw new ReplacementError(
        `Old thread ${oldThreadId} is ${oldThread.status}; replacement requires idle or error`,
        "old_not_idle_or_error",
      );
    }
    if (oldThread.activeBackgroundAgentCount > 0) {
      throw new ReplacementError(
        `Old thread ${oldThreadId} has ${oldThread.activeBackgroundAgentCount} active background agent(s)`,
        "old_has_background_agents",
      );
    }
    if (oldThread.queuedMessageCount > 0) {
      throw new ReplacementError(
        `Old thread ${oldThreadId} has queued messages`,
        "old_has_queued_messages",
      );
    }
  }
  if (!oldThread.environmentId) {
    throw new ReplacementError(
      `Old thread ${oldThreadId} has no environment`,
      "old_environment_missing",
    );
  }
  if (oldThread.environmentId !== input.environmentId) {
    throw new ReplacementError(
      `Old thread environment ${oldThread.environmentId} does not match requested ${input.environmentId}`,
      "old_environment_mismatch",
    );
  }

  // Activity and pending interactions come from threads.list, which survives
  // idle status; archived threads are excluded from the list.
  if (!oldThread.archivedAt) {
    const list = await bb.sdk.threads.list({
      threadIds: [oldThreadId],
      projectId: input.projectId,
    });
    const row = list.find((t) => t.id === oldThreadId);
    if (row) {
      const activity = row.activity as
        | Record<string, number | boolean>
        | undefined;
      if (row.hasPendingInteraction) {
        throw new ReplacementError(
          `Old thread ${oldThreadId} has a pending interaction`,
          "old_has_pending_interaction",
        );
      }
      const activityFields = [
        "activeBackgroundAgentCount",
        "activeBackgroundCommandCount",
        "activeGoalCount",
        "activePlanModeCount",
        "activeWorkflowCount",
      ] as const;
      for (const field of activityFields) {
        const value = activity?.[field];
        if (typeof value === "number" && value > 0) {
          throw new ReplacementError(
            `Old thread ${oldThreadId} has ${field}=${value}`,
            "old_has_background_activity",
          );
        }
      }
    }
  }

  const descendants = await bb.sdk.threads.experimental_listDescendants({
    threadIds: [oldThreadId],
  });
  const row = descendants.threads.find((t) => t.threadId === oldThreadId);
  const descendantIds = row?.descendantIds ?? [];
  if (descendantIds.length > 0) {
    const descDetails = await Promise.all(
      descendantIds.map((id) => bb.sdk.threads.get({ threadId: id })),
    );
    const owned = descDetails.filter(
      (t) => t.lifecycleOwnerThreadId === oldThreadId,
    );
    if (owned.length > 0) {
      throw new ReplacementError(
        `Cannot replace ${oldThreadId}: ${owned.length} descendant(s) have it as lifecycle owner (immutable SDK owner; archiving would lose work)`,
        "old_has_lifecycle_owned_descendants",
      );
    }
  }

  // ── Persist intent ──
  const now = Date.now();
  let currentIntent: ReplacementIntent = intent ?? {
    oldThreadId,
    newThreadId: null,
    environmentId: input.environmentId,
    keep: input.keep,
    stage: "spawning",
    delivery: "pending",
    reparented: 0,
    resumed: isRetry,
    startedAt: now,
  };
  if (!intent) {
    await bb.storage.kv.set(intentKey, currentIntent);
  } else if (isRetry) {
    currentIntent.resumed = true;
  }

  // ── Idle spawn ──
  let newThreadId = currentIntent.newThreadId;
  if (!newThreadId) {
    const spawnBase = input.spawnArgs as unknown as Record<string, unknown>;
    const {
      input: _input,
      prompt: _prompt,
      pluginMetadata: _pluginMetadata,
      ...base
    } = spawnBase;
    const spawnArgs: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0] = {
      ...(base as Omit<
        Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
        "input" | "prompt" | "pluginMetadata"
      >),
      input: [{ type: "text", text: input.prompt, mentions: [] }],
      environment: { type: "reuse", environmentId: input.environmentId },
      pluginMetadata: {
        teamReplacement: true,
        teamReplacementRole: input.role,
        teamReplacementTeam: input.team,
      },
    };

    // Write ahead: a process exit during spawn must not create a second session.
    currentIntent.stage = "spawn_uncertain";
    await bb.storage.kv.set(intentKey, currentIntent);
    try {
      const fresh = await bb.sdk.threads.spawn(spawnArgs);
      newThreadId = fresh.id;
      currentIntent.newThreadId = newThreadId;
      currentIntent.stage = "spawning";
      await bb.storage.kv.set(intentKey, currentIntent);
    } catch (error) {
      currentIntent.stage = "spawn_uncertain";
      await bb.storage.kv.set(intentKey, currentIntent);
      throw new ReplacementError(
        `Spawn attempt for role ${input.role} is uncertain; a thread may have been created in BB. Cause: ${(error as Error).message}`,
        "spawn_uncertain",
        { cause: error },
      );
    }
  }

  // ── Revalidate ──
  if (input.beforeSwitch) {
    await input.beforeSwitch();
  }

  const oldBeforeSwitch = await bb.sdk.threads.get({ threadId: oldThreadId });
  if (!oldBeforeSwitch.archivedAt) {
    if (
      oldBeforeSwitch.status !== "idle" &&
      oldBeforeSwitch.status !== "error"
    ) {
      throw new ReplacementError(
        `Old thread ${oldThreadId} became ${oldBeforeSwitch.status} before switch; refusing`,
        "old_became_active",
      );
    }
  }

  // ── Switch ──
  const fresh = await bb.sdk.threads.get({ threadId: newThreadId });
  if (fresh.environmentId !== input.environmentId) {
    throw new ReplacementError(
      "Fresh session has not attached to the original environment",
      "fresh_environment_mismatch",
    );
  }
  if (!(await isPreparedReplacement(bb, fresh, input.prompt, 5000))) {
    throw new ReplacementError(
      `Fresh thread ${newThreadId} must be waiting on its single Team-held handoff prompt`,
      "fresh_not_idle",
    );
  }

  if (currentIntent.stage === "spawning") {
    const descendants2 = await bb.sdk.threads.experimental_listDescendants({
      threadIds: [oldThreadId],
    });
    const row2 = descendants2.threads.find((t) => t.threadId === oldThreadId);
    const childIds = row2?.descendantIds ?? [];

    let reparented = 0;
    if (childIds.length > 0) {
      const children = await Promise.all(
        childIds.map((id) => bb.sdk.threads.get({ threadId: id })),
      );
      for (const child of children) {
        if (child.parentThreadId === oldThreadId && child.id !== newThreadId) {
          await bb.sdk.threads.update({
            threadId: child.id,
            parentThreadId: newThreadId,
          });
          reparented += 1;
        }
      }
    }
    currentIntent.reparented = reparented;

    await bb.sdk.threads.updatePluginMetadata({
      threadId: newThreadId,
      set: {
        ...(input.spawnArgs.pluginMetadata ?? {}),
        [ROLE_RETIRED_KEY]: false,
        teamReplacement: false,
      } as NonNullable<
        Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["pluginMetadata"]
      >,
    });

    await bb.storage.kv.set(canonicalKey, newThreadId);

    await bb.sdk.threads.updatePluginMetadata({
      threadId: oldThreadId,
      set: { [ROLE_RETIRED_KEY]: true },
      remove: ROLE_METADATA_KEYS,
    });

    if (input.afterSwitch) {
      await input.afterSwitch(newThreadId);
    }

    currentIntent.stage = "switching";
    await bb.storage.kv.set(intentKey, currentIntent);
  }

  // ── Archive old ──
  if (currentIntent.stage === "switching") {
    if (!input.keep) {
      const oldBeforeArchive = await bb.sdk.threads.get({
        threadId: oldThreadId,
      });
      if (oldBeforeArchive.archivedAt) {
        // already archived, idempotent
      } else if (
        oldBeforeArchive.status !== "idle" &&
        oldBeforeArchive.status !== "error"
      ) {
        throw new ReplacementError(
          `Old thread ${oldThreadId} is ${oldBeforeArchive.status} before archive; refusing to archive a working thread`,
          "old_active_before_archive",
        );
      } else {
        await bb.sdk.threads.archive({ threadId: oldThreadId });
      }
    }

    currentIntent.stage = "prompting";
    await bb.storage.kv.set(intentKey, currentIntent);
  }

  // ── Release the queued prompt via recheck ──
  if (
    currentIntent.stage === "prompting" &&
    currentIntent.delivery === "pending"
  ) {
    currentIntent.delivery = "sent";
    currentIntent.stage = "complete";
    currentIntent.completedAt = Date.now();
    await bb.storage.kv.set(intentKey, currentIntent);
    try {
      await bb.experimental_hooks.recheck("message.dispatch");
    } catch (error) {
      throw new ReplacementError(
        `Role switched, but the queued prompt on ${newThreadId} could not be released; run bb team resume`,
        "release_failed",
        { cause: error },
      );
    }
  }

  return {
    oldThreadId,
    newThreadId,
    reparented: currentIntent.reparented,
    resumed: currentIntent.resumed,
  };
}

/** A pending status is safe only when the core queue proves Team holds its sole request. */
export async function isPreparedReplacement(
  bb: BbPluginApi,
  thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
  expectedPrompt?: string,
  waitMs = 0,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let current = thread;
  for (;;) {
    if (
      (current.status !== "idle" && current.status !== "pending") ||
      current.activeBackgroundAgentCount > 0
    )
      return false;
    const queue = await bb.sdk.threads.queuedMessages.list({
      threadId: current.id,
    });
    const item = queue[0];
    if (queue.length > 1 || (item && item.originPluginId !== bb.pluginId))
      return false;
    const textMatches =
      !!item &&
      item.content.length === 1 &&
      item.content[0]!.type === "text" &&
      (expectedPrompt === undefined ||
        item.content[0]!.text === expectedPrompt);
    if (item?.state === "waiting" && item.waitingOn?.kind === "plugin") {
      return item.waitingOn.pluginId === bb.pluginId && textMatches;
    }
    // The core can return spawn before its dispatcher has recorded the wait.
    // Wait only for this existing request; never create or resend anything.
    if (Date.now() >= deadline || (item && !textMatches)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await bb.sdk.threads.get({ threadId: current.id });
  }
}

async function kvGetString(
  kv: BbPluginApi["storage"]["kv"],
  key: string,
): Promise<string | null> {
  const value = await kv.get(key);
  return typeof value === "string" ? value : null;
}

function parseIntent(raw: unknown): ReplacementIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<ReplacementIntent>;
  if (typeof obj.oldThreadId !== "string") return null;
  if (typeof obj.environmentId !== "string") return null;
  if (typeof obj.keep !== "boolean") return null;
  if (typeof obj.startedAt !== "number") return null;
  return {
    oldThreadId: obj.oldThreadId,
    newThreadId: typeof obj.newThreadId === "string" ? obj.newThreadId : null,
    environmentId: obj.environmentId,
    keep: obj.keep,
    stage: isReplacementStage(obj.stage) ? obj.stage : "spawning",
    delivery: isReplacementDelivery(obj.delivery) ? obj.delivery : "pending",
    reparented: typeof obj.reparented === "number" ? obj.reparented : 0,
    resumed: typeof obj.resumed === "boolean" ? obj.resumed : false,
    startedAt: obj.startedAt,
    completedAt:
      typeof obj.completedAt === "number" ? obj.completedAt : undefined,
  };
}

function isReplacementStage(v: unknown): v is ReplacementStage {
  return (
    v === "spawning" ||
    v === "switching" ||
    v === "prompting" ||
    v === "complete" ||
    v === "spawn_uncertain"
  );
}

function isReplacementDelivery(v: unknown): v is ReplacementDelivery {
  return v === "pending" || v === "sent" || v === "uncertain";
}

function resolveState(
  inputOldThreadId: string,
  canonicalThreadId: string | null,
  intent: ReplacementIntent | null,
): { oldThreadId: string; intent: ReplacementIntent | null; isRetry: boolean } {
  // Role already bound to a fresh thread: recover the original old id from
  // the intent so retries continue the same operation.
  if (canonicalThreadId && canonicalThreadId !== inputOldThreadId) {
    if (!intent) {
      throw new ReplacementError(
        `Canonical pointer ${canonicalThreadId} does not match requested old thread ${inputOldThreadId} and no replacement intent exists`,
        "canonical_intent_missing",
      );
    }
    if (intent.newThreadId !== canonicalThreadId) {
      throw new ReplacementError(
        `Canonical pointer ${canonicalThreadId} does not match intent new thread ${intent.newThreadId}`,
        "canonical_intent_mismatch",
      );
    }
    return {
      oldThreadId: intent.oldThreadId,
      intent,
      isRetry: true,
    };
  }

  // Canonical matches the requested old thread (or is absent): start a new
  // operation unless an in-progress intent for the same old thread exists.
  if (!intent || intent.stage === "complete") {
    return { oldThreadId: inputOldThreadId, intent: null, isRetry: false };
  }

  if (intent.oldThreadId !== inputOldThreadId) {
    throw new ReplacementError(
      `In-progress replacement intent belongs to ${intent.oldThreadId}, not ${inputOldThreadId}`,
      "intent_old_thread_mismatch",
    );
  }

  return {
    oldThreadId: inputOldThreadId,
    intent,
    isRetry: true,
  };
}
