import { inspectBindings, repairBinding } from "./bindings";
import { executionDiagnostic } from "../shared/execution-diagnostic";
import {executionEventSchema} from "../shared/execution-event";
import {resourceQueueExplanation,packageResourceBlock} from "../shared/resource-explanation";
import {sessionRecoverySchema,sessionRecoveryActionSchema,type SessionRecovery} from "../shared/session-recovery";
import {executionJournal, JOURNAL_RETENTION_DAYS, JOURNAL_MAX_EVENTS} from "./execution-journal";
import {openRouterUsageSchema,emptyOpenRouter,openRouterHeadroom,isOpenRouterModel,quotaSourceSchema,type OpenRouterUsage,type QuotaSource} from "../shared/openrouter-usage";
import { queuedFingerprint, deferredKey, deferredContinuationSchema, readDeferred, scheduleDeferred, cancelDeferred } from "./deferred-continuation";
import { recoveryViewSchema, manualExecutionApprovalSchema, type RecoveryView, type RecoveryBlocker } from "../shared/recovery-view";
import { hostContract } from "../shared/host-contract";
import { ollamaUsageSchema, isOllamaCloud, exhaustedOllama, quotaHeadroom, quotaPolicySchema, DEFAULT_QUOTA_POLICY, type OllamaUsage } from "../shared/ollama-usage";
import { verifyQuotaBoundary } from "./checkpoint";
import { ResourceControl, epicBudgetChangeSchema, type EpicBudgetChange, resourcePolicySchema, withResourceResults, confirmedQuota, independentQuotaSelection, type ResourceOwner, type ResourceSummary } from "./resource-control";
import { executionPolicySchema, withExecutionProfile, type ExecutionFallbackSelection } from "../shared/execution-policy";
// bb-plugin-team — role-based agent teams for a project.
//
// A project may hold several teams; each team is a lead plus executors,
// configured in .bb/teams/<team>.yaml (the v0.1 file .bb/team.yaml is read as
// team "main"). Team configs stay out of git until versioning is turned on.
//
// Commands (bb team --help): init, create, list, add-role, version, tell,
// task add|list|update|done|remove, report, doctor, replace, stop, pause,
// resume, status, retitle, template list|show|save|delete.
//
// UI: the Team panel (create teams from templates, add executors, live
// hierarchy, packages, pause), the template editor in Settings → Team, and
// the "Team roles" section of the @ menu.
//
// Plugin settings: language (en | ru), teamSection, roster, titleFormat.

import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type PluginMentionItem,
} from "@get-bb/plugin-sdk";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { z } from "zod";
import { createHash } from "node:crypto";
import { contextView, sessionViewSchema, type SessionView } from "../shared/session-view";
import * as core from "./core";
import {
  ensureSection,
  excerptSafe,
  gitIgnoresBB,
  helpersOf,
  inferLeadRole,
  joinPath,
  listConfiguredTeams,
  loadRolePrompt,
  providerState,
  readFileOrNull,
  readTeamConfig,
  readTeamMark,
  resolveEnvironment,
  resolveWorkspace,
  roleEnvironmentSpec,
  roleThreadsOf,
  scanTeamThreads,
  teamSectionName,
  teamsWithThreads,
  unknownVars,
  validateProviders,
  writeWorkspaceFile,
  type LoadedConfig,
  type NotifyEvent,
  type Role,
  type SpawnEnvironment,
  type TeamConfig,
  type TeamThreadRow,
  type ThreadScan,
  type Workspace,
} from "./core";
import { messages, type Messages } from "../shared/messages";
import {
  GENERATOR_SELECTION_KV_KEY,
  generalSettingDescriptors,
  generatorSelectionSchema,
  languageSettingDescriptor,
  parseGeneratorSelection,
  settingsMessages,
  type GeneratorSelection,
} from "../shared/settings-localization";
import { renderReportHtml, renderReportMarkdown } from "../shared/report";
import {
  TASK_STATUSES,
  currentTask,
  deriveExecutionState,
  relativeAgo,
  type AutoContinueStage,
  type Language,
  type SnapshotRole,
  type SnapshotThread,
  type TaskId,
  type TaskStatus,
  type TeamSnapshot,
  type TeamTask,
} from "../shared/snapshot";
import { strings, type Strings } from "../shared/strings";
import { createTaskTracker, isTrackerAbsentError } from "./tracker";
import { captureCheckpoint, environmentState, verifyCheckpoint, workCheckpointSchema } from "./checkpoint";
import { acceptanceGate, latestDecision, type AcceptanceCaller, type AcceptanceDecision } from "../shared/review";
import { replaceSession, readReplacementIntent, isPreparedReplacement, activeSessionKey, type ReplacementIntent, type ReplacementResult } from "./sessions";
import {
  TaskError,
  addTask,
  busyTasks,
  listTasks,
  normalizeTaskStore,
  parseTaskStatus,
  removeTask,
  taskKey,
  updateTask,
  type TaskStore,
} from "./tasks";
import {
  DEFAULT_TEAM,
  DEFAULT_TITLE_FORMAT,
  ROLE_KINDS,
  appendRoleToYaml,
  builtinPrompt,
  builtinTemplates,
  findTemplate,
  formatThreadTitle,
  isVersioned,
  kindTitle,
  newTemplateFromKinds,
  roleKindOf,
  setVersionedContent,
  teamFilesFromTemplate,
  teamLayout,
  templateRoleSchema,
  templateSchema,
  type TeamFile,
  type TeamTemplate,
  type TemplateRole,
} from "../shared/templates";

export { relativeAgo, strings };
export type { Language, TeamSnapshot };
export {
  NOTIFY_EVENTS,
  applyVars,
  findSourceByPath,
  gitIgnoresBB,
  joinPath,
  requireInsideWorkspace,
  teamConfigSchema,
  unknownVars,
} from "./core";
export type { Role, TeamThreadRow } from "./core";

export function semanticChecks(config: TeamConfig, t: Strings = strings("en")) {
  return core.semanticChecks(config, t);
}
export function parseEnvironmentSpec(spec: string, t: Strings = strings("en")) {
  return core.parseEnvironmentSpec(spec, t);
}
export function applyPlaceholders(
  text: string,
  vars: Parameters<typeof core.applyPlaceholders>[1],
  t: Strings = strings("en"),
): string {
  return core.applyPlaceholders(text, vars, t);
}

/* ──────────────────────── Small pure helpers ──────────────────────── */

interface Scope extends Workspace {
  team: string;
}

/** Thread plugin metadata that marks a team role thread. */
export function teamMetadata(
  role: Role,
  team: string,
): { teamRole: string; teamName: string; teamNotifyOn: string[] } {
  return { teamRole: role.name, teamName: team, teamNotifyOn: [...(role.notifyOn ?? [])] };
}

/**
 * The pause hook decision. Held while the thread is paused: agent and system
 * traffic, and every message this plugin relays (bb team tell / task --send /
 * the panel). A human typing straight into the thread is never held.
 */
export function pauseDecision(
  threadId: string,
  dispatch: { initiator: string; originPluginId: string | null },
  ownPluginId: string,
  paused: ReadonlySet<string>,
  reason: string,
): { action: "proceed" } | { action: "wait"; reason: string } {
  if (!paused.has(threadId)) return { action: "proceed" };
  if (dispatch.initiator === "user" && dispatch.originPluginId !== ownPluginId) {
    return { action: "proceed" };
  }
  return { action: "wait", reason };
}

/** First lines of an agent reply, bounded for a notification. */
export function excerpt(text: string | null, max = 600): string | null {
  return excerptSafe(text, max);
}

/** Drop `threadId:` bindings from a team.yaml text; returns the count. */
export function stripThreadIds(yamlText: string): { text: string; stripped: number } {
  let stripped = 0;
  const text = yamlText
    .split("\n")
    .filter((raw) => {
      if (/^\s*threadId\s*:/.test(raw)) {
        stripped += 1;
        return false;
      }
      return true;
    })
    .join("\n");
  return { text, stripped };
}

export function parseTaskId(value: string): TaskId {
  const raw = value.replace(/^#/, "");
  if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  if (/^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(raw)) return raw;
  throw new PluginCliError(`invalid task id: "${value}"`, { code: "invalid_value" });
}

export type DoctorLevel = "ok" | "warn" | "fail";
export interface DoctorCheck {
  check: string;
  level: DoctorLevel;
  detail: string;
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(18)} ${value}`;
}

const PROJECT_OPTION = {
  type: "string",
  description: "Project by ID or name; defaults to the thread's project or the current directory",
  placeholder: "<id|name>",
} as const;

const TEAM_OPTION = {
  type: "string",
  description: "Team name; defaults to the caller thread's team or the only team",
  placeholder: "<team>",
} as const;

const JSON_OPTION = { type: "boolean", description: "Machine-readable output" } as const;

const RUNNING = ["active", "starting", "pending"];

/* ──────────────────────── Panel RPC contract ──────────────────────── */

const snapshotSchema = z.custom<TeamSnapshot>(
  (value) => typeof value === "object" && value !== null && "roles" in value,
);
const taskSchema = z.custom<TeamTask>(
  (value) => typeof value === "object" && value !== null && "id" in value,
);
const templateOutSchema = z.custom<TeamTemplate>(
  (value) => typeof value === "object" && value !== null && "roles" in value,
);
const projectIdSchema = z.string().min(1).max(200);
const teamSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/** The Team panel's and template editor's data plane (app.tsx imports the type). */
export const rpcContract = defineRpcContract({
  trackerConfig: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({kind: z.enum(["beads", "builtin"]), override: z.enum(["beads", "builtin"]).nullable()}),
  },
  trackerSet: {
    input: z.object({ projectId: projectIdSchema, kind: z.enum(["beads", "builtin"]).nullable() }).strict(),
    output: z.object({ok: z.boolean()}),
  },
  /** Create the selected tracker's missing storage (Beads: the one bd init). */
  trackerPrepare: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema }).strict(),
    output: z.object({ status: z.enum(["ready", "created"]) }),
  },
  projects: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  teams: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({ teams: z.array(z.string()), language: z.enum(["en", "ru"]) }),
  },
  snapshot: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema.optional() }).strict(),
    output: z.object({ snapshot: snapshotSchema, language: z.enum(["en", "ru"]) }),
  },
  /** All projects, grouped by the panel: with teams / can create / blocked (+ reason). */
  overview: {
    input: z.null(),
    output: z.object({
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          path: z.string().nullable(),
          teams: z.array(z.string()),
          threads: z.number(),
          running: z.number(),
          errors: z.number(),
          state: z.enum(["teams", "ready", "blocked"]),
          reason: z.string().nullable(),
        }),
      ),
      language: z.enum(["en", "ru"]),
    }),
  },
  /** Every team of a project in one call: the panel's tree. */
  tree: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({
      projectName: z.string(),
      snapshots: z.array(snapshotSchema),
      language: z.enum(["en", "ru"]),
    }),
  },
  /** Spawn the team's missing roles (bb team create). */
  teamSpawn: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema }).strict(),
    output: z.object({ spawned: z.number() }),
  },
  bindingRepair: {
    input: z.object({projectId: projectIdSchema, team: teamSchema, role: z.string().min(1).max(100), currentThreadId: z.string().min(1), candidateThreadId: z.string().min(1)}).strict(),
    output: z.object({repaired: z.boolean()}),
  },
  sessionView: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, role: z.string().min(1).max(100) }).strict(),
    output: sessionViewSchema,
  },
  executionHistory: {
    input: z.object({projectId:projectIdSchema,team:teamSchema,role:z.string().min(1).max(100).optional()}).strict(),
    output: z.object({events:z.array(executionEventSchema).max(2000),retentionDays:z.number(),maxEvents:z.number()}),
  },
  sessionRecovery: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string().min(1).max(100),action:sessionRecoveryActionSchema.optional(),expectedRevision:z.string().optional(),confirmed:z.boolean().optional(),candidateThreadId:z.string().optional()}).strict(),
    output:sessionRecoverySchema,
  },
  sessionRotate: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, role: z.string().min(1).max(100), expectedThreadId: z.string().min(1).max(200) }).strict(),
    output: sessionViewSchema,
  },
  /** Stop a role's running threads (bb team stop <role>). */
  stop: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, role: z.string().min(1).max(100) }).strict(),
    output: z.object({ stopped: z.number() }),
  },
  providers: {
    input: z.null(),
    output: z.object({ enabled: z.array(z.string()), disabled: z.array(z.string()) }),
  },
  freeThreads: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({
      threads: z.array(
        z.object({ id: z.string(), title: z.string(), status: z.string(), provider: z.string() }),
      ),
    }),
  },
  templates: {
    input: z.null(),
    output: z.object({
      templates: z.array(templateOutSchema),
      kinds: z.array(z.object({ kind: z.string(), title: z.string() })),
      language: z.enum(["en", "ru"]),
      defaultTemplate: z.string(),
    }),
  },
  templateSave: {
    input: z.object({ template: templateSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  /** Delete one of your templates. */
  templateDelete: {
    input: z.object({ id: teamSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * General Team settings for the Settings → Team editor UI. `language` and
   * `defaultTemplate` live in the plugin settings handle (single source);
   * `generatorSelection` is a standalone setting in one kv key.
   */
  editorSettings: {
    input: z.null(),
    output: z.object({
      language: z.enum(["en", "ru"]),
      defaultTemplate: z.string(),
      defaultTemplateExists: z.boolean(),
      generatorSelection: generatorSelectionSchema.nullable(),
      reloadHint: z.string(),
    }),
  },
  /** Persist a partial update; returns the effective values after the write. */
  editorSettingsSet: {
    input: z
      .object({
        language: z.enum(["en", "ru"]).optional(),
        defaultTemplate: z.string().min(1).max(200).optional(),
        generatorSelection: generatorSelectionSchema.nullable().optional(),
      })
      .strict(),
    output: z.object({
      language: z.enum(["en", "ru"]),
      defaultTemplate: z.string(),
      defaultTemplateExists: z.boolean(),
      generatorSelection: generatorSelectionSchema.nullable(),
      reloadHint: z.string(),
    }),
  },
  templateNew: {
    input: z
      .object({ id: teamSchema, title: z.string().min(1).max(120), kinds: z.array(z.string()).min(1).max(30) })
      .strict(),
    output: z.object({ template: templateOutSchema }),
  },
  templateFromTeam: {
    input: z
      .object({ projectId: projectIdSchema, team: teamSchema, id: teamSchema, title: z.string().min(1).max(120) })
      .strict(),
    output: z.object({ template: templateOutSchema }),
  },
  teamCreate: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        title: z.string().min(1).max(120),
        roles: z.array(templateRoleSchema).min(1).max(30),
        versioned: z.boolean(),
      })
      .strict(),
    output: z.object({ team: z.string(), spawned: z.number(), leadThreadId: z.string().nullable() }),
  },
  roleAdd: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        role: templateRoleSchema,
        threadId: z.string().regex(/^thr_/).optional(),
      })
      .strict(),
    output: z.object({ role: z.string(), threadId: z.string().nullable() }),
  },
  rolePolicy: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),primary:templateRoleSchema.pick({provider:true,model:true,reasoningLevel:true,serviceTier:true}).strict().optional(),policy:executionPolicySchema.nullable().optional(),quotaSource:quotaSourceSchema.nullable().optional(),expectedRevision:z.string().optional(),futureOnly:z.boolean().optional(),expectedThreadId:z.string().optional()}).strict(),
    output:z.object({role:templateRoleSchema,source:z.string(),revision:z.string()}),
  },
  ollamaUsage: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,refresh:z.boolean().optional(),role:z.string().optional()}).strict(),output:ollamaUsageSchema,
  },
  openrouterUsage:{input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),refresh:z.boolean().optional()}).strict(),output:openRouterUsageSchema},
  quotaPolicy: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,policy:quotaPolicySchema.optional()}).strict(),output:quotaPolicySchema,
  },
  deferredContinuation: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),action:z.enum(["status","schedule","cancel","check"]),expectedThreadId:z.string().optional(),sendAt:z.number().finite().optional(),resumePaused:z.boolean().optional()}).strict(),
    output:z.object({record:deferredContinuationSchema.nullable()}),
  },
  roleRecovery: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),selection:executionPolicySchema.shape.fallbacks.element.optional()}).strict(),output:recoveryViewSchema,
  },
  continueCoordination: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,taskId:z.union([z.string(),z.number()]),expectedStarts:z.number().int().nonnegative(),expectedUsed:z.number().int().nonnegative()}).strict(),output:z.custom<ResourceSummary>(),
  },
  roleControl: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),action:z.enum(["status","pause","resume","switch"]),expectedThreadId:z.string().optional(),selection:executionPolicySchema.shape.fallbacks.element.optional(),approveSelection:z.boolean().optional(),recoverFromWorkspace:z.boolean().optional(),expectedRecoveryRevision:z.string().optional()}).strict(),
    output:z.object({paused:z.boolean(),threadId:z.string().nullable(),fallbacks:z.array(executionPolicySchema.shape.fallbacks.element),actual:executionPolicySchema.shape.fallbacks.element.nullable().optional()}),
  },
  epicBudget: {
    input:epicBudgetChangeSchema.extend({projectId:projectIdSchema,team:teamSchema}).strict(),
    output:z.custom<ResourceSummary>(),
  },
  packageBudget: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,taskId:z.union([z.string().min(1).max(200),z.number().int().positive()]),limit:z.number().int().min(1).max(1000),expectedLimit:z.number().int().min(1).max(1000),expectedUsed:z.number().int().nonnegative(),reason:z.string().trim().min(1).max(4000)}).strict(),
    output:z.custom<ResourceSummary>(),
  },
  resources: {
    input:z.object({projectId:projectIdSchema,team:teamSchema,reason:z.string().trim().min(1).max(4000).optional(),role:z.string().optional(),policy:resourcePolicySchema.optional(),taskId:z.union([z.number().int().positive(),z.string().min(1).max(200)]).optional()}).strict(),
    output:z.custom<ResourceSummary>(),
  },
  setVersioned: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, versioned: z.boolean() }).strict(),
    output: z.object({ versioned: z.boolean(), blocked: z.boolean() }),
  },
  tell: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        role: z.string().min(1).max(100),
        text: z.string().min(1).max(20000),
      })
      .strict(),
    output: z.object({ sent: z.number(), failed: z.number(), paused: z.boolean() }),
  },
  taskAdd: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        role: z.string().min(1).max(100),
        title: z.string().min(1).max(300),
        note: z.string().max(2000).optional(),
        send: z.boolean(),
        parentId:z.string().min(1).max(200).optional(),
      })
      .strict(),
    output: z.object({ task: taskSchema, sentTo: z.string().nullable(), sendError: z.string().nullable() }),
  },
  taskUpdate: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        id: z.union([z.number().int().positive(), z.string().min(1).max(200)]),
        status: z.enum(TASK_STATUSES),
        /** bbt-iwi.2: review submission / acceptance grounds (manual path from the panel). */
        review: z.unknown().optional(),
        acceptReason: z.string().max(4000).optional(),
        returnReason: z.string().max(4000).optional(),
        /** bbt-iwi.2 fix: the id of the submission the caller reviewed; a mismatch is a conflict with no writes. */
        expectedSubmissionId: z.string().min(1).max(100).nullable().optional(),
      })
      .strict(),
    output: z.object({ task: taskSchema }),
  },
  pause: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, paused: z.boolean() }).strict(),
    output: z.object({ paused: z.boolean(), count: z.number() }),
  },
});

/* ──────────────────────── Plugin ──────────────────────── */

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  /*
   * Settings, two-phase: `language` is defined first and read from the same
   * settings store (load-safe inside the factory), then the rest register with
   * RU-only or EN-only labels. The SDK has no runtime metadata update and
   * `bb.sdk.plugins.getSettings` 404s until the factory has run, so the label
   * language is fixed at load; switching language shows new native labels
   * after `bb plugin reload team` (surfaced as reloadHint in editorSettings).
   */
  const languageSettings = bb.settings.define({
    language: languageSettingDescriptor(),
  });
  let nativeLang = "en" as "en" | "ru";
  try {
    nativeLang = (await languageSettings.get()).language === "ru" ? "ru" : "en";
  } catch {
    // settings unavailable at load — English until the first command
  }
  const generalSettings = bb.settings.define(generalSettingDescriptors(nativeLang));

  /** Combined view of both handles — the same settings store, split only by key. */
  type SettingsValues = {
    defaultTracker: string;
    defaultTemplate: string;
    language: string;
    teamSection: boolean;
    roster: boolean;
    titleFormat: string;
  };
  const settings = {
    async get(): Promise<SettingsValues> {
      const [languageValues, generalValues] = await Promise.all([
        languageSettings.get(),
        generalSettings.get(),
      ]);
      return { ...languageValues, ...generalValues } as SettingsValues;
    },
    async experimental_set(
      values: Partial<{
        language: "en" | "ru" | null;
        defaultTracker: "beads" | "builtin" | null;
        defaultTemplate: string | null;
        teamSection: boolean | null;
        roster: boolean | null;
        titleFormat: string | null;
      }>,
    ) {
      const { language, ...general } = values;
      const merged: Record<string, string | number | boolean> = {};
      if (language !== undefined) {
        Object.assign(merged, await languageSettings.experimental_set({ language }));
      }
      const generalPatch = Object.fromEntries(
        Object.entries(general).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(generalPatch).length > 0) {
        Object.assign(merged, await generalSettings.experimental_set(generalPatch));
      }
      return merged;
    },
  };

  let currentLang: Language = "en";
  const loadLang = async (): Promise<{ lang: Language; t: Strings; m: Messages }> => {
    const values = await settings.get();
    const lang: Language = values.language === "ru" ? "ru" : "en";
    currentLang = lang;
    return { lang, t: strings(lang), m: messages(lang) };
  };
  try {
    await loadLang();
  } catch {
    // settings unavailable at load — English until the first command
  }

  const publishChange = (projectId: string): void => {
    try {
      bb.realtime.publish("team-changed", { projectId });
    } catch {
      // no connected clients / server not bound yet
    }
  };

  /* ── Scope: project + team ── */

  const allTeams = async (workspace: Workspace, scan?: ThreadScan): Promise<string[]> => {
    const configured = await listConfiguredTeams(bb, workspace);
    const fromThreads = teamsWithThreads(scan ?? (await scanTeamThreads(bb, workspace.projectId)));
    return [...new Set([...configured, ...fromThreads])].sort();
  };

  const pickTeam = async (
    workspace: Workspace,
    explicit: string | undefined,
    threadId: string | undefined,
    t: Strings,
  ): Promise<string> => {
    if (explicit) {
      core.assertTeamName(explicit);
      return explicit;
    }
    if (threadId) {
      try {
        const mark = readTeamMark(
          (await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown>,
        );
        if (mark) return mark.team;
      } catch {
        // not a team thread
      }
    }
    const teams = await allTeams(workspace);
    if (teams.length <= 1) return teams[0] ?? DEFAULT_TEAM;
    const err = t.teamAmbiguous(teams.join(", "));
    throw new PluginCliError(err.message, { code: "team_ambiguous", hint: err.hint });
  };

  const resolveScope = async (
    options: { project?: string; team?: string },
    ctx: { projectId?: string; cwd?: string; threadId?: string },
    t: Strings,
  ): Promise<Scope> => {
    const workspace = await resolveWorkspace(bb, options.project, ctx.projectId, t, ctx);
    const team = await pickTeam(workspace, options.team, ctx.threadId, t);
    return { ...workspace, team };
  };

  const scopeFor = async (projectId: string, team: string, t: Strings): Promise<Scope> => {
    core.assertTeamName(team);
    const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
    return { ...workspace, team };
  };

  const threadTitle = async (scope: Scope, roleTitle: string, scan?: ThreadScan) => {
    const values = await settings.get();
    const teams = await allTeams(scope, scan);
    const count = new Set([...teams, scope.team]).size;
    return formatThreadTitle(String(values.titleFormat ?? DEFAULT_TITLE_FORMAT), {
      team: scope.team,
      role: roleTitle,
      showTeam: count > 1,
    });
  };

  /* ── Versioning (team configs stay out of git by default) ── */

  const versionState = async (scope: Scope, legacy: boolean) => {
    const layout = teamLayout(scope.team, legacy);
    const ignore = await readFileOrNull(bb, scope, layout.ignoreFile);
    const root = await readFileOrNull(bb, scope, ".gitignore");
    const blocked = root !== null && gitIgnoresBB(root);
    return { layout, blocked, versioned: !blocked && isVersioned(ignore, layout.ignoreEntries) };
  };

  const setVersioned = async (scope: Scope, legacy: boolean, versioned: boolean) => {
    const layout = teamLayout(scope.team, legacy);
    const ignore = await readFileOrNull(bb, scope, layout.ignoreFile);
    await writeWorkspaceFile(
      bb,
      scope,
      layout.ignoreFile,
      setVersionedContent(ignore, layout.ignoreEntries, versioned),
    );
    publishChange(scope.projectId);
    return versionState(scope, legacy);
  };

  /* ── Templates (server-wide, in plugin storage) ── */

  const TEMPLATES_KEY = "templates";

  /* Generator selection: one standalone kv setting, separate from role models. */
  const readGeneratorSelection = async (): Promise<GeneratorSelection | null> =>
    parseGeneratorSelection(await bb.storage.kv.get(GENERATOR_SELECTION_KV_KEY));
  const writeGeneratorSelection = async (
    selection: GeneratorSelection | null,
  ): Promise<void> => {
    if (selection === null) {
      await bb.storage.kv.delete(GENERATOR_SELECTION_KV_KEY);
      return;
    }
    await bb.storage.kv.set(GENERATOR_SELECTION_KV_KEY, selection);
  };

  const readUserTemplates = async (): Promise<TeamTemplate[]> => {
    const raw = await bb.storage.kv.get<unknown[]>(TEMPLATES_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = templateSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  };
  const saveUserTemplate = async (template: TeamTemplate, m: Messages): Promise<void> => {
    if (builtinTemplates("en").some((tpl) => tpl.id === template.id)) {
      const err = m.templateBuiltin(template.id);
      throw new PluginCliError(err.message, { code: "template_builtin", hint: err.hint });
    }
    const clean = templateSchema.parse(template);
    const list = (await readUserTemplates()).filter((tpl) => tpl.id !== clean.id);
    await bb.storage.kv.set(TEMPLATES_KEY, [...list, clean]);
  };
  const deleteUserTemplate = async (id: string, m: Messages): Promise<void> => {
    if (builtinTemplates("en").some((tpl) => tpl.id === id)) {
      const err = m.templateBuiltin(id);
      throw new PluginCliError(err.message, { code: "template_builtin", hint: err.hint });
    }
    // The saved default template must not disappear behind the user's back:
    // refuse with a clear, localized error instead of a silent fallback.
    if ((await settings.get()).defaultTemplate === id) {
      const { lang } = await loadLang();
      const err = settingsMessages(lang).templateIsDefault(id);
      throw new PluginCliError(err.message, { code: "template_is_default", hint: err.hint });
    }
    const list = await readUserTemplates();
    if (!list.some((tpl) => tpl.id === id)) {
      const err = m.templateNotFound(id);
      throw new PluginCliError(err.message, { code: "template_not_found", hint: err.hint });
    }
    await bb.storage.kv.set(
      TEMPLATES_KEY,
      list.filter((tpl) => tpl.id !== id),
    );
  };
  const allTemplates = async (lang: Language): Promise<TeamTemplate[]> => {
    const user = await readUserTemplates();
    const builtin = builtinTemplates(lang).filter((tpl) => !user.some((u) => u.id === tpl.id));
    return [...builtin, ...user];
  };
  const getTemplate = async (id: string, lang: Language, m: Messages): Promise<TeamTemplate> => {
    const found = findTemplate(id, lang, await readUserTemplates());
    if (!found) {
      const err = m.templateNotFound(id);
      throw new PluginCliError(err.message, { code: "template_not_found", hint: err.hint });
    }
    return found;
  };

  /** A team config as a template: roles with their prompt text inlined. */
  const templateFromConfig = async (
    workspace: Workspace,
    loaded: LoadedConfig,
    lang: Language,
    t: Strings,
    id: string,
    title: string,
  ): Promise<{ template: TeamTemplate; stripped: number }> => {
    const { lead } = core.semanticChecks(loaded.config, t);
    let stripped = 0;
    const roles: TemplateRole[] = [];
    for (const role of loaded.config.roles) {
      if (role.threadId) stripped += 1;
      let prompt: string | undefined;
      if (role.prompt || role.promptFile) {
        try {
          prompt = await loadRolePrompt(bb, workspace, role, role.name === lead.name, lang, t);
        } catch {
          prompt = undefined;
        }
      }
      roles.push(
        templateRoleSchema.parse({
          name: role.name,
          ...(role.kind ? { kind: role.kind } : {}),
          ...(role.title ? { title: role.title } : {}),
          ...(role.provider ? { provider: role.provider } : {}),
          ...(role.model ? { model: role.model } : {}),
          ...(role.reasoningLevel ? { reasoningLevel: role.reasoningLevel } : {}),
          ...(role.serviceTier ? { serviceTier: role.serviceTier } : {}),
          ...(role.executionPolicy ? { executionPolicy: role.executionPolicy } : {}),
          ...(role.quotaSource ? { quotaSource:role.quotaSource } : {}),
          ...(role.environment ? { environment: role.environment } : {}),
          ...(role.name === lead.name ? { lead: true } : {}),
          ...(role.enabled === false ? { enabled: false } : {}),
          ...(role.notifyOn?.length ? { notifyOn: role.notifyOn } : {}),
          ...(prompt ? { prompt } : {}),
        }),
      );
    }
    return { template: { id, title, roles }, stripped };
  };

  /** Write team files; refuse to overwrite existing ones unless forced. */
  const writeTeamFiles = async (
    scope: Scope,
    files: readonly TeamFile[],
    force: boolean,
    t: Strings,
  ): Promise<string[]> => {
    const existing: string[] = [];
    for (const file of files) {
      if ((await readFileOrNull(bb, scope, file.rel)) !== null) existing.push(file.rel);
    }
    if (existing.length > 0 && !force) {
      const err = t.scaffoldExists(existing.join(", "));
      throw new PluginCliError(err.message, { code: "scaffold_exists", hint: err.hint });
    }
    for (const file of files) await writeWorkspaceFile(bb, scope, file.rel, file.content);
    return files.map((file) => file.rel);
  };

  /* ── Work packages: one kv store per project team ── */

  const tracker = createTaskTracker(bb, {
    defaultTracker: async () => (await settings.get()).defaultTracker === "builtin" ? "builtin" : "beads",
    publish: publishChange,
  });
  const readTasks = (scope: Scope) => tracker.read(scope);

  // Serialize read-modify-write cycles per project/team. Two concurrent
  // taskAdd/taskUpdate calls must not read the same snapshot and then have the
  // last write clobber the first (issue #1); a single kv.set is not atomic
  // across a read-modify-write. The same lock also guards team config
  // mutations (addRole, create) and pause state.
  const scopeLocks = new Map<string, Promise<void>>();
  const withScopeLock = async <T>(scope: Scope, fn: () => Promise<T>): Promise<T> => {
    const key = scope.projectId;
    const previous = scopeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chain = previous.then(() => gate);
    scopeLocks.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (scopeLocks.get(key) === chain) scopeLocks.delete(key);
    }
  };
  const asCliError = (error: unknown): never => {
    if (error instanceof TaskError) throw new PluginCliError(error.message, { code: error.code });
    throw error;
  };

  const setProjectTracker = async (workspace: Workspace, kind: "beads" | "builtin" | null) =>
    withScopeLock({...workspace, team: DEFAULT_TEAM}, async () => {
      const current=await tracker.getConfig(workspace);
      const effective=kind ?? ((await settings.get()).defaultTracker==="builtin"?"builtin":"beads");
      if(current.kind===effective){await tracker.setConfig(workspace,kind);publishChange(workspace.projectId);return;}
      const scan = await scanTeamThreads(bb, workspace.projectId);
      if (scan.rows.some(row => RUNNING.includes(row.status))) throw new PluginCliError("Stop or finish active team work before changing the project tracker", {code: "role_busy"});
      for(const row of scan.rows.filter(row=>!row.helper)) {
        if(await bb.storage.kv.get(sessionTaskKey({...workspace,team:row.team},row.threadId))!==undefined) throw new PluginCliError("Save final checkpoints and replace completed role sessions before changing trackers; old execution references stay in their original tracker",{code:"session_consumed"});
      }
      for (const team of await allTeams(workspace, scan)) {
        const scope = {...workspace, team};
        if((await resources.inspect(scope)).epic)throw new PluginCliError("Active epic requires Beads; changing tracker cannot bypass its budget",{code:"epic_scope"});
        // Missing database is still an explicit error on reads, but it must not
        // prevent the human from explicitly selecting the built-in tracker.
        let tasks: TaskStore;
        try { tasks = await readTasks(scope); }
        catch (error) {
          if (kind === "builtin") continue;
          throw error;
        }
        if (tasks.tasks.some(task => task.status === "in-progress" || task.status === "review")) throw new PluginCliError("Accept or drop active packages before switching trackers", {code: "role_busy"});
      }
      await tracker.setConfig(workspace, kind);
      publishChange(workspace.projectId);
    });

  /* ── Pause: executor threads whose agent messages wait in their queues ── */

  interface PauseState {
    threadIds: string[];
    atMs: number;
  }
  const pauseKey = (scope: Scope) => `paused:${scope.projectId}:${scope.team}`;
  const pausedThreads = new Set<string>();
  const readPause = async (scope: Scope): Promise<PauseState | null> =>
    (await bb.storage.kv.get<PauseState>(pauseKey(scope))) ?? null;
  try {
    for (const key of await bb.storage.kv.list("paused:")) {
      const state = await bb.storage.kv.get<PauseState>(key);
      for (const id of state?.threadIds ?? []) pausedThreads.add(id);
    }
  } catch (error) {
    bb.log.warn(`pause state not restored: ${(error as Error).message}`);
  }

  const resourceOwner = async (threadId:string):Promise<ResourceOwner|null> => {
    let id=threadId;const seen=new Set<string>();let first:Awaited<ReturnType<typeof bb.sdk.threads.get>>|null=null;
    let mark:ReturnType<typeof readTeamMark>=null;let bound:TaskId|undefined;let ownerThreadId=threadId;
    for(let depth=0;depth<20&&!seen.has(id);depth++){
      seen.add(id);const thread=await bb.sdk.threads.get({threadId:id});first??=thread;
      const meta=await bb.sdk.threads.getPluginMetadata({threadId:id}) as Record<string,unknown>;
      mark??=readTeamMark(meta);
      if(mark){bound=await bb.storage.kv.get<TaskId>(`session-task:${thread.projectId}:${mark.team}:${id}`);if(bound!==undefined){ownerThreadId=id;break;}if(!mark.helper){ownerThreadId=id;break;}}
      if(!thread.parentThreadId)break;id=thread.parentThreadId;
    }
    if(!mark||!first)return null;
    let hostId:string|null=null;
    if(first.environmentId)hostId=(await bb.sdk.environments.get({environmentId:first.environmentId})).hostId;
    const {t}=await loadLang();
    const scope=await scopeFor(first.projectId,mark.team,t);
    const loaded=await readTeamConfig(bb,scope,scope.team,t);
    const isLead=core.semanticChecks(loaded.config,t).lead.name===mark.role;
    return {projectId:first.projectId,team:mark.team,role:mark.role,taskId:bound??null,ownerThreadId,hostId,isLead};
  };
  const resources=new ResourceControl(bb,resourceOwner,publishChange,Date.now,async(owner,epicId)=>{
    const {t}=await loadLang();const scope=await scopeFor(owner.projectId,owner.team,t);
    const epic=await tracker.validateEpic(scope,epicId,owner.taskId,owner.isLead);
    return {title:epic.title,...(epic.criteria?{criteria:epic.criteria}:{})};
  });
  const quotaHost=bb.hosts.experimental_client({contract:hostContract});
  const quotaPending=new Map<string,Promise<OllamaUsage>>();
  const cloudUsage=async(hostId:string,refresh=false):Promise<OllamaUsage>=>{
    const key=`ollama-usage:${hostId}`;
    const prior=ollamaUsageSchema.safeParse(await bb.storage.kv.get(key));
    if(!refresh&&prior.success&&Date.now()-prior.data.checkedAtMs<180_000)return prior.data;
    if(quotaPending.has(hostId))return quotaPending.get(hostId)!;
    const pending=(async()=>{
      let data:OllamaUsage;
      try {data=await quotaHost.call("ollamaUsage",{},{hostId,timeoutMs:12_000});}
      catch {data={status:"unavailable",checkedAtMs:Date.now(),windows:[],reason:"host_unavailable"};}
      // A failed refresh cannot silently release a previously exhausted account.
      if(data.status!=="ready"&&prior.success&&quotaHeadroom(prior.data,{pauseBelowPercent:50}).held)data={...prior.data,status:"unavailable",reason:data.reason,checkedAtMs:data.checkedAtMs,observedAtMs:prior.data.observedAtMs??prior.data.checkedAtMs};
      await bb.storage.kv.set(key,data);return data;
    })();quotaPending.set(hostId,pending);
    try{return await pending;}finally{quotaPending.delete(hostId);}
  };
  const routerPending=new Map<string,Promise<OpenRouterUsage>>();
  const routerKeyLocks=new Map<string,Promise<void>>();
  const sharedRouterReceipt=async(data:OpenRouterUsage,write=false):Promise<OpenRouterUsage>=>{
    if(!data.keyId)return data;
    const key=`openrouter-key:${data.keyId}`;
    const previous=routerKeyLocks.get(key)??Promise.resolve();
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const tail=previous.catch(()=>{}).then(()=>gate);routerKeyLocks.set(key,tail);await previous.catch(()=>{});
    try{
      const parsed=openRouterUsageSchema.safeParse(await bb.storage.kv.get(key));
      let latest=parsed.success?parsed.data:null;
      if(write&&data.status==="ready"&&(!latest||data.checkedAtMs>=latest.checkedAtMs)){await bb.storage.kv.set(key,data);latest=data;}
      // Account counters are shared across launchers/projects/hosts. Retain the
      // local credential source and any local failure: a healthy other host
      // cannot turn a failed current-host check into confirmed recovery.
      const observed=data.observedAtMs??data.checkedAtMs;
      return latest&&latest.checkedAtMs>=observed?{...latest,source:data.source,...(data.status==="unavailable"?{status:"unavailable" as const,reason:data.reason,checkedAtMs:data.checkedAtMs,observedAtMs:latest.checkedAtMs}:{})}:data;
    }finally{release();if(routerKeyLocks.get(key)===tail)routerKeyLocks.delete(key);}
  };
  const routerUsage=async(threadId:string,selection?:{provider:string;model:string},refresh=false):Promise<OpenRouterUsage>=>{
    const owner=await resourceOwner(threadId);if(!owner?.hostId)return emptyOpenRouter("host_unavailable","unknown");
    const {t}=await loadLang();const scope=await scopeFor(owner.projectId,owner.team,t);
    const role=(await readTeamConfig(bb,scope,scope.team,t)).config.roles.find(r=>r.name===owner.role);
    const thread=await bb.sdk.threads.get({threadId});
    const meta=await bb.sdk.threads.getPluginMetadata({threadId}) as {teamExecution?:ExecutionFallbackSelection};
    const actual=selection??meta.teamExecution??{provider:thread.providerId,model:role?.model??""};
    // Explicit source describes this launcher. Different fallback launchers must
    // resolve their own credentials; a role's primary key is never substituted.
    const declared=actual.provider===(role?.provider??thread.providerId)?role?.quotaSource:undefined;
    const binding=isOpenRouterModel(actual.model)&&declared?.service==="ollama-cloud"?undefined:declared;
    if(isOllamaCloud(actual.provider,actual.model)||binding?.service==="ollama-cloud")return emptyOpenRouter("route_unknown","unknown");
    if(!isOpenRouterModel(actual.model)&&actual.provider!=="acp-qwen-code"&&binding?.service!=="openrouter")return emptyOpenRouter("route_unknown","unknown");
    if(actual.provider.startsWith("acp-")&&!binding?.credentialEnv){
      try{
        const settings=await bb.sdk.plugins.getSettings({pluginId:"provider-acp"});
        const values=(settings as unknown as {values?:{customAgents?:string}}).values;
        const agents=JSON.parse(values?.customAgents??"[]") as Array<{id:string;command?:string;args?:string[];env?:Record<string,string>}>;
        const custom=agents.find(a=>`acp-${a.id}`===actual.provider);
        if(!custom||custom.command!=="qwen"||custom.args?.some(a=>!["--acp","--experimental-acp"].includes(a))||Object.keys(custom.env??{}).length)return emptyOpenRouter("auth_unsupported",isOpenRouterModel(actual.model)?"openrouter":"unknown");
      }catch{return emptyOpenRouter("auth_unsupported",isOpenRouterModel(actual.model)?"openrouter":"unknown");}
    }
    if(!thread.environmentId)return emptyOpenRouter("host_unavailable");
    const env=await bb.sdk.environments.get({environmentId:thread.environmentId});
    if(!env.path)return emptyOpenRouter("host_unavailable");
    const input={provider:actual.provider,model:actual.model,cwd:env.path,...(binding?{binding}:{})};
    const key=`openrouter-usage:${env.hostId}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
    const prior=openRouterUsageSchema.safeParse(await bb.storage.kv.get(key));
    if(!refresh&&prior.success&&Date.now()-prior.data.checkedAtMs<180_000)return sharedRouterReceipt(prior.data);
    if(routerPending.has(key))return routerPending.get(key)!;
    const pending=(async()=>{
      let data:OpenRouterUsage;
      try{data=await quotaHost.call("openrouterUsage",input,{hostId:env.hostId,timeoutMs:22_000});data={...data,checkedAtMs:Date.now()};}catch{data=emptyOpenRouter("host_unavailable");}
      if(data.status!=="ready"&&prior.success&&openRouterHeadroom(prior.data,actual.model,50).held&&(!data.keyId||data.keyId===prior.data.keyId))data={...prior.data,status:"unavailable",reason:data.reason,checkedAtMs:data.checkedAtMs,observedAtMs:prior.data.observedAtMs??prior.data.checkedAtMs};
      await bb.storage.kv.set(key,data);return sharedRouterReceipt(data,true);
    })();routerPending.set(key,pending);try{return await pending;}finally{routerPending.delete(key);}
  };
  const routerWaitKey=(owner:Pick<ResourceOwner,"projectId"|"team"|"role">)=>`openrouter-wait:${owner.projectId}:${owner.team}:${owner.role}`;
  const rolePauseKey=(scope:Pick<Scope,"projectId"|"team">,role:string)=>`role-paused:${scope.projectId}:${scope.team}:${role}`;
  const quotaWaitKey=(scope:Pick<Scope,"projectId"|"team">,role:string)=>`quota-wait:${scope.projectId}:${scope.team}:${role}`;
  const isRolePaused=async(scope:Pick<Scope,"projectId"|"team">,role:string)=>await bb.storage.kv.get<boolean>(rolePauseKey(scope,role))===true;

  const readQuotaPolicy=async(scope:Pick<Scope,"projectId"|"team">)=>{
    const parsed=quotaPolicySchema.safeParse(await bb.storage.kv.get(`quota-policy:${scope.projectId}:${scope.team}`));
    return parsed.success?parsed.data:DEFAULT_QUOTA_POLICY;
  };

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const meta = await bb.sdk.threads.getPluginMetadata({threadId:ctx.thread.id}) as Record<string,unknown>;
    if (meta.teamReplacement === true) return {action:"wait" as const,reason:"Team is preparing this replacement session; the initial prompt stays queued until the role switch completes."};
    const mark=readTeamMark(meta);
    if (mark && !mark.helper) {
      const replacement=await readReplacementIntent(bb,ctx.thread.projectId,mark.team,mark.role);
      if (replacement && replacement.newThreadId===ctx.thread.id && replacement.stage!=="complete") return {action:"wait" as const,reason:"Team is finishing the role switch before releasing this session."};
    }
    const canonical=mark&&!mark.helper?await bb.storage.kv.get<string>(`active-session:${ctx.thread.projectId}:${mark.team}:${mark.role}`):null;
    if (meta.teamRetired === true || (canonical && canonical!==ctx.thread.id)) return {action:"wait" as const,reason:"This session was replaced. Address the current role using bb team tell <role>."};
    const paused=pauseDecision(ctx.thread.id,{initiator:ctx.initiator,originPluginId:ctx.originPluginId},bb.pluginId,pausedThreads,messages(currentLang).pauseWaitReason);
    if(paused.action!=="proceed")return paused;
    if(mark && await isRolePaused({projectId:ctx.thread.projectId,team:mark.team},mark.role))return {action:"wait" as const,reason:currentLang==="ru"?"Сотрудник на паузе: новые ходы удерживаются. Продолжите его в Team.":"Employee is paused; resume the role in Team."};
    const scope=mark?{projectId:ctx.thread.projectId,team:mark.team}:null;
    const key=scope&&mark?deferredKey(scope.projectId,scope.team,mark.role):null;
    const deferred=key?await readDeferred(bb,key):null;
    const scheduled=deferred&&deferred.stage!=="released"?deferred:null;
    const wait=async(reason:string)=>{
      if(scheduled&&key&&Date.now()>=scheduled.sendAt){await bb.storage.kv.set(key,{...scheduled,stage:"needs-decision",reason});publishChange(ctx.thread.projectId);}
      return {action:"wait" as const,reason};
    };
    if(scheduled){
      if(scheduled.stage!=="scheduled")return {action:"wait" as const,reason:scheduled.reason??"Inspect the scheduled continuation in Team before retrying"};
      if(Date.now()<scheduled.sendAt)return {action:"wait" as const,reason:"Team: continuation scheduled for "+new Date(scheduled.sendAt).toISOString()};
      if(scheduled.threadId!==ctx.thread.id||ctx.queuedMessages?.length!==1||ctx.queuedMessages[0]?.id!==scheduled.queuedMessageId||ctx.queuedMessages[0]?.sendAt!==scheduled.sendAt||queuedFingerprint(ctx.queuedMessages[0] as unknown as Record<string,unknown>)!==scheduled.fingerprint)return wait("Scheduled session or queued work changed; inspect the thread queue");
      const owner=await resourceOwner(ctx.thread.id);
      if(!owner||owner.taskId!==scheduled.taskId)return wait("The task binding changed; inspect the current work before continuing");
      if(owner.taskId!==null){
        const {t}=await loadLang();const task=(await readTasks(await scopeFor(owner.projectId,owner.team,t))).tasks.find(task=>task.id===owner.taskId);
        if(!task||task.role!==owner.role||task.status!=="in-progress")return wait("The task was finished, reassigned or submitted for review; inspect it before continuing");
      }
    }
    const owner=await resourceOwner(ctx.thread.id);
    let routerVerified=false;
    if(owner&&ctx.requestedExecution?.providerId){
      const usage=await routerUsage(ctx.thread.id,{provider:ctx.requestedExecution.providerId,model:ctx.requestedExecution.model??""},!!scheduled);
      if(usage.service==="openrouter"){
        const quota=openRouterHeadroom(usage,ctx.requestedExecution.model,(await readQuotaPolicy(owner)).pauseBelowPercent);
        const latch=routerWaitKey(owner);
        if(quota.held||scheduled&&quota.unknown){
          const reason=currentLang==="ru"?"OpenRouter: квота у порога остановки или свежий остаток не подтверждён. Назначьте продолжение позже либо выберите независимый сервис.":"OpenRouter quota at/below threshold or fresh capacity unknown; choose when/how to continue.";
          if(await bb.storage.kv.get(latch)!==reason){await bb.storage.kv.set(latch,reason);publishChange(owner.projectId);}return wait(reason);
        }
        if(!scheduled&&await bb.storage.kv.get(latch))return wait("OpenRouter: quota recovered; an explicit continuation decision is still required in Team");
        routerVerified=!quota.unknown;
        if(scheduled&&routerVerified){await resources.confirmOpenRouterCapacity(owner,ctx.requestedExecution.providerId,ctx.requestedExecution.model??"");await bb.storage.kv.delete(latch);}
      }
    }
    if(owner&&isOllamaCloud(ctx.requestedExecution?.providerId,ctx.requestedExecution?.model)){
      const policy=await readQuotaPolicy(owner);
      const usage=owner.hostId?await cloudUsage(owner.hostId,!!scheduled):undefined;
      const quota=quotaHeadroom(usage,policy);
      const quotaKey=quotaWaitKey(owner,owner.role);
      if(quota.held||scheduled&&quota.unknown){
        const reason=currentLang==="ru"?`Ollama Cloud: ${quota.unknown?"свежая квота не подтверждена":`осталось ${quota.remainingPercent}% при пороге ${policy.pauseBelowPercent}%`}. Новые ходы удерживаются. Выберите время продолжения или независимую модель в Team.`:`Ollama Cloud: quota headroom unavailable or at/below ${policy.pauseBelowPercent}%. Choose a continuation time or independent model in Team.`;
        if(await bb.storage.kv.get(quotaKey)!==reason){await bb.storage.kv.set(quotaKey,reason);publishChange(owner.projectId);}
        return wait(reason);
      }
      if(!scheduled&&await bb.storage.kv.get(quotaKey))return wait(currentLang==="ru"?"Квота восстановилась, но сотрудник ждёт вашего решения. Нажмите «Продолжить очередь» или назначьте время в Team.":"Quota recovered; waiting for your decision. Continue queued work or schedule it in Team.");
      if(scheduled&&owner.hostId){await resources.confirmOllamaCapacity(owner.hostId);await bb.storage.kv.delete(quotaKey);}
    }
    if(scheduled&&owner){
      const summary=await resources.inspect(owner);
      const held=summary.holds[owner.taskId===null?`role:${owner.role}`:`task:${owner.taskId}`];
      if(held){
        if((!isOllamaCloud(ctx.requestedExecution?.providerId,ctx.requestedExecution?.model)&&!routerVerified)||!["rate-limit","budget-exceeded"].includes(held))return wait("A provider or execution error still needs a manual decision: "+held);
        await resources.decide(owner,"User scheduled continuation; fresh upstream quota verified",undefined,owner.taskId??undefined,owner.role,"capacity");
      }
    }
    const admission=await resources.admit(ctx);
    if(scheduled&&key){
      if(admission.action!=="proceed")return wait(admission.action==="wait"?resourceQueueExplanation(admission.reason,currentLang):"Team/task budget or another execution guard still holds this continuation");
      await bb.storage.kv.set(key,{...scheduled,stage:"released",reason:null});publishChange(ctx.thread.projectId);
    }
    return admission.action==="wait"?{...admission,reason:resourceQueueExplanation(admission.reason,currentLang)}:admission;
  });

  /** Team context: config (if any), lead, role threads and helpers. */
  const teamContext = async (scope: Scope, t: Strings) => {
    let loaded: LoadedConfig | null = null;
    let configError: string | null = null;
    let configLead: string | null = null;
    try {
      loaded = await readTeamConfig(bb, scope, scope.team, t);
      configLead = core.semanticChecks(loaded.config, t).lead.name;
    } catch (error) {
      if ((error as PluginCliError).code !== "config_missing") {
        configError = (error as Error).message;
      }
    }
    const scan = await scanTeamThreads(bb, scope.projectId);
    const rows = roleThreadsOf(scan, scope.team);
    const helpers = helpersOf(scan, scope.team);
    const lead = configLead ?? inferLeadRole(rows);
    return { loaded, configError, lead, scan, rows, helpers };
  };

  const notifyResource = async (scope:Scope,role:string,reason:string) => {
    // A global hold also holds the lead: do not wake a model to explain its own hold.
    if((await resources.inspect(scope)).blocked)return;
    if(!await resources.notice(scope,`${role}:${reason}`))return;
    const {t}=await loadLang();const {rows,lead}=await teamContext(scope,t);
    const target=lead&&lead!==role?rows.get(lead)?.[0]:null;if(!target)return;
    const text=currentLang==="ru"?`[team] Ресурсы/продолжение ${role} требуют решения: ${reason}. Смотри ресурсы Team или bb team report; не обходи блокировку новой задачей/тредом.`:`[team] ${role} needs a resource/continuation decision: ${reason}. Inspect Team resources or bb team report; do not bypass the hold with another task/thread.`;
    try{await bb.sdk.threads.send({originPluginId:bb.pluginId,threadId:target.threadId,mode:"queue-if-active",input:[{type:"text",text,mentions:[]}]});}catch{bb.log.warn("Team resource notice could not be delivered; it remains visible in the resource panel");}
  };

  const pause = async (scope: Scope, t: Strings): Promise<{ count: number; already: boolean }> => {
    const existing = await readPause(scope);
    if (existing) return { count: existing.threadIds.length, already: true };
    const { rows, helpers, lead } = await teamContext(scope, t);
    const threadIds = [
      ...[...rows.entries()].filter(([role]) => role !== lead).flatMap(([, list]) => list),
      ...[...helpers.entries()].filter(([role]) => role !== lead).flatMap(([, list]) => list),
    ].map((row) => row.threadId);
    await bb.storage.kv.set(pauseKey(scope), { threadIds, atMs: Date.now() } satisfies PauseState);
    for (const id of threadIds) pausedThreads.add(id);
    publishChange(scope.projectId);
    return { count: threadIds.length, already: false };
  };

  const resume = async (scope: Scope): Promise<number | null> => withScopeLock(scope, async () => {
    const existing = await readPause(scope);
    if (existing) {
      await bb.storage.kv.delete(pauseKey(scope));
      for (const id of existing.threadIds) pausedThreads.delete(id);
    }
    await bb.experimental_hooks.recheck("message.dispatch");
    const {t} = await loadLang();
    const {rows} = await teamContext(scope,t);
    for (const role of rows.keys()) {
      if (await readAutoContinue(scope, role)) await runAutoContinue(scope, role, t);
      else await dispatchNextPackage(scope,role,t);
    }
    publishChange(scope.projectId);
    return existing?.threadIds.length ?? null;
  });

  /* ── Messages to roles ── */

  const tellRole = async (
    scope: Scope,
    wantedRole: string,
    text: string,
    t: Strings,
    senderThreadId?: string,
  ) => withScopeLock(scope, async () => {
    const { rows, lead } = await teamContext(scope, t);
    if (wantedRole === "lead" && lead) wantedRole = lead;
    if (wantedRole !== "all") await assertRoleAvailable(scope, wantedRole);
    else for (const role of rows.keys()) await assertRoleAvailable(scope, role);
    const targets: Array<[string, TeamThreadRow]> = [];
    if (wantedRole === "all") {
      // "all" never echoes the message back into the sender's own thread.
      for (const [role, list] of rows) {
        for (const row of list) if (row.threadId !== senderThreadId) targets.push([role, row]);
      }
    } else {
      const list = rows.get(wantedRole);
      if (!list || list.length === 0) {
        const err = t.tellRoleNotFound(wantedRole);
        throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
      }
      if (list.length !== 1) throw new PluginCliError("Role has several sessions; select its canonical session with bb team replace --thread", {code:"thread_ambiguous"});
      for (const row of list) targets.push([wantedRole, row]);
    }
    const sent: Array<{ role: string; threadId: string }> = [];
    const failed: Array<{ role: string; error: string }> = [];
    for (const [role, row] of targets) {
      try {
        await bb.sdk.threads.send({
          originPluginId: bb.pluginId,
          ...(senderThreadId && senderThreadId !== row.threadId ? { senderThreadId } : {}),
          threadId: row.threadId,
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        });
        sent.push({ role, threadId: row.threadId });
      } catch (error) {
        failed.push({ role, error: (error as Error).message });
      }
    }
    return { sent, failed };
  });

  /* ── Work package operations (CLI + panel) ── */

  const executionKey = (scope: Scope, id: TaskId) => `execution:${scope.projectId}:${scope.team}:${id}`;
  const sessionTaskKey = (scope: Scope, threadId: string) => `session-task:${scope.projectId}:${scope.team}:${threadId}`;
  const checkpointRefKey = (scope: Scope, role: string) => `checkpoint-ref:${scope.projectId}:${scope.team}:${role}`;
  const assertRoleAvailable = async (scope: Scope, role: string) => {
    const pending = await bb.storage.kv.get<{stage?: string}>(`replacement:${scope.projectId}:${scope.team}:${role}`);
    if (pending && pending.stage !== "complete") {
      throw new PluginCliError(`Role ${role} has an unfinished session replacement; repeat bb team replace ${role} before sending work`, { code: "replacement_pending" });
    }
  };
  const deliverPackage = async (scope: Scope, task: TeamTask, target: TeamThreadRow, lead: string | null, senderThreadId?: string) => {
    await assertRoleAvailable(scope, task.role);
    await resources.assertDispatch({...scope,role:task.role,taskId:task.id,ownerThreadId:target.threadId,isLead:task.role===lead});
    const key = executionKey(scope, task.id);
    const prior = await bb.storage.kv.get<{ delivery: string }>(key);
    if (prior) throw new PluginCliError(`Task ${task.id} already has a delivery record (${prior.delivery}); inspect its thread before sending another message`, { code: "delivery_exists" });
    const assigned = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,target.threadId));
    if (assigned !== undefined && assigned !== null && assigned !== task.id) throw new PluginCliError("This session already executed another package; replace it before starting the next",{code:"session_consumed"});
    await bb.storage.kv.set(sessionTaskKey(scope,target.threadId),task.id);
    const record = { taskId: task.id, role: task.role, threadId: target.threadId, environmentId: target.environmentId, atMs: Date.now(), delivery: "sending" };
    await bb.storage.kv.set(key, record);
    try {
      const { m } = await loadLang();
      await bb.sdk.threads.send({
        originPluginId: bb.pluginId,
        ...(senderThreadId && senderThreadId !== target.threadId ? { senderThreadId } : {}),
        threadId: target.threadId, mode: "auto",
        input: [{type: "text", text: m.taskBody(task.id, task.title, [task.note,task.criteria && `Acceptance criteria: ${task.criteria}`,task.priority !== undefined && `Priority: ${task.priority}`,task.dependencies?.length && `Dependencies: ${task.dependencies.join(", ")}`,task.decisions && `Decisions: ${task.decisions}`,task.result && `Result: ${task.result}`].filter(Boolean).join("\n\n") || null, lead), mentions: []}],
      });
    } catch (error) {
      await bb.storage.kv.set(key, {...record, delivery: "uncertain", error: (error as Error).message});
      throw error;
    }
    await bb.storage.kv.set(key, {...record, delivery: "sent"});
  };
  const notifyRework = async (scope: Scope, task: TeamTask, target: TeamThreadRow, decision: AcceptanceDecision) => {
    const ref = createHash("sha256").update(JSON.stringify(decision)).digest("hex");
    const key = `review-feedback:${scope.projectId}:${scope.team}:${task.id}:${ref}`;
    const previous = await bb.storage.kv.get<{delivery: string}>(key);
    if (previous) {
      if (previous.delivery !== "sent") throw new PluginCliError("Rework is recorded, but earlier delivery is uncertain; inspect the employee thread before sending another message", {code:"review_delivery_uncertain"});
      return;
    }
    const record = {taskId:task.id, threadId:target.threadId, delivery:"uncertain"};
    await bb.storage.kv.set(key, record);
    const {lang} = await loadLang();
    const text = lang === "ru"
      ? `[team] Задача #${task.id} возвращена на доработку. Замечание: ${decision.reason}\nПродолжай эту же задачу в текущем окружении; не создавай новый пакет или worktree. После исправления сохрани checkpoint и подай новый --review отчёт.`
      : `[team] Task #${task.id} needs rework. Remark: ${decision.reason}\nContinue this same task in the current environment; do not create another package or worktree. Save a checkpoint and submit a new --review report after fixing it.`;
    try {
      await bb.sdk.threads.send({originPluginId:bb.pluginId,threadId:target.threadId,mode:"queue-if-active",input:[{type:"text",text,mentions:[]}]});
    } catch {
      throw new PluginCliError(lang === "ru" ? "Возврат сохранён, но доставка замечания не подтверждена. Проверьте тред сотрудника; автоматического повтора нет." : "Rework is recorded, but remark delivery is uncertain. Inspect the employee thread; it will not be resent automatically.", {code:"review_delivery_uncertain"});
    }
    await bb.storage.kv.set(key, {...record, delivery:"sent"});
  };

  // Called with the project lock held. Task readiness belongs to the tracker.
  const dispatchNextPackage = async (scope: Scope, role: string, t: Strings): Promise<void> => {
    if (await readPause(scope) || await isRolePaused(scope,role)) return;
    await assertRoleAvailable(scope, role);
    const store = await readTasks(scope);
    if (busyTasks(store, role).length) return;
    const ready = new Set(await tracker.ready(scope));
    const next = listTasks(store, {role}).find(task => task.status === "todo" && ready.has(task.id));
    if (!next) return;
    const {rows, lead} = await teamContext(scope, t);
    if ((rows.get(role)?.length ?? 0)>1) throw new PluginCliError("Role has several sessions",{code:"thread_ambiguous"});
    const target = rows.get(role)?.[0];
    if (!target || RUNNING.includes(target.status)) return;
    if (await bb.storage.kv.get(sessionTaskKey(scope,target.threadId)) !== undefined) return;
    await resources.assertDispatch({...scope,role,taskId:next.id,ownerThreadId:target.threadId,isLead:role===lead});
    const {task} = await tracker.update(scope, next.id, {status: "in-progress"});
    await deliverPackage(scope, task, target, lead);
  };

  const addPackage = async (
    scope: Scope,
    input: { role: string; title: string; note: string | null; send: boolean; parentId?:string },
    t: Strings, m: Messages, senderThreadId?: string,
  ): Promise<{ task: TeamTask; sentTo: string | null; busy: TeamTask[]; sendError: string | null }> =>
    withScopeLock(scope, async () => {
      await assertRoleAvailable(scope, input.role);
      const {loaded, rows, lead} = await teamContext(scope, t);
      const roles = new Set([...rows.keys(), ...(loaded?.config.roles.map(r => r.name) ?? [])]);
      if (!roles.has(input.role)) throw new PluginCliError(m.taskRoleUnknown(input.role).message, {code: "role_not_found"});
      if (input.send && (rows.get(input.role)?.length ?? 0)>1) throw new PluginCliError("Role has several sessions",{code:"thread_ambiguous"});
      const target = rows.get(input.role)?.[0];
      if (input.send && !target) {const err=m.taskNoThread(input.role);throw new PluginCliError(err.message, {code: "role_not_found",hint:err.hint});}
      const busy = busyTasks(await readTasks(scope), input.role);
      const consumed = target ? await bb.storage.kv.get(sessionTaskKey(scope,target.threadId)) : undefined;
      const send = input.send && target && consumed === undefined && busy.length === 0 && !RUNNING.includes(target.status) && !(await readPause(scope));
      const task = await tracker.add(scope, {...input, status: "todo"});
      await resources.pinPackages(scope,[task],lead);
      let sentTo: string | null = null, sendError: string | null = null;
      if (send && target) {
        try {
          await resources.assertDispatch({...scope,role:task.role,taskId:task.id,ownerThreadId:target.threadId,isLead:task.role===lead});
          Object.assign(task,(await tracker.update(scope,task.id,{status:"in-progress"})).task);
          await deliverPackage(scope, task, target, lead, senderThreadId); sentTo = target.threadId; }
        catch (error) { sendError = (error as Error).message; }
      }
      // A new package can make replacing a consumed session worthwhile;
      // no record → no-op.
      if (await readAutoContinue(scope, input.role)) {
        await runAutoContinue(scope, input.role, t);
        const fresh = (await readTasks(scope)).tasks.find((x) => x.id === task.id);
        if (fresh) return {task: fresh, busy, sentTo, sendError};
      }
      return {task, busy, sentTo, sendError};
    });

  /**
   * Who is changing the task, from the caller thread's real team mark and
   * project:
   * "lead" — this team's lead role in THIS project (a lead's helper is NOT
   * the lead; a same-named team in another project is a foreign agent);
   * "executor" — any other team-marked thread, including helpers and threads
   * marked for another team or project (an agent, never the user);
   * "manual" — no team thread at all: the explicit manual path (the user's
   * interface — not a proof that a human acted, so records say "manual").
   * A failing mark/thread read never degrades a known caller to "manual":
   * it is an explicit error and nothing is written.
   */
  const classifyCaller = async (
    scope: Scope,
    callerThreadId: string | undefined,
    t: Strings,
  ): Promise<{ caller: AcceptanceCaller; callerRole: string | null }> => {
    if (!callerThreadId) return { caller: "manual", callerRole: null };
    const refuseUnverified = (error: unknown): never => {
      throw new PluginCliError(
        `could not verify the calling team thread (${callerThreadId}): ${(error as Error).message}`,
        { code: "caller_unverified", hint: "Nothing was changed; re-run the command" },
      );
    };
    let mark: ReturnType<typeof readTeamMark> = null;
    try {
      mark = readTeamMark(
        (await bb.sdk.threads.getPluginMetadata({ threadId: callerThreadId })) as Record<string, unknown>,
      );
    } catch (error) {
      refuseUnverified(error);
    }
    if (!mark) return { caller: "manual", callerRole: null };
    if (mark.helper) return { caller: "executor", callerRole: mark.role };
    if (mark.team !== scope.team) return { caller: "executor", callerRole: null };
    let threadProjectId: string | undefined;
    try {
      threadProjectId = (await bb.sdk.threads.get({ threadId: callerThreadId })).projectId;
    } catch (error) {
      refuseUnverified(error);
    }
    if (threadProjectId !== scope.projectId) return { caller: "executor", callerRole: null };
    const { lead } = await teamContext(scope, t);
    if (lead !== null && mark.role === lead) return { caller: "lead", callerRole: mark.role };
    return { caller: "executor", callerRole: mark.role };
  };

  const notifyBudgetIncrease=async(scope:Scope,task:TeamTask,oldLimit:number,limit:number,used:number,reason:string,t:Strings,epic?:ResourceSummary["epic"])=>{
    try{
      const {rows,lead}=await teamContext(scope,t);const targets=lead?rows.get(lead)??[]:[];
      if(targets.length!==1)return "unavailable" as const;
      if(targets[0]!.status!=="idle")return "busy" as const;
      const threadId=targets[0]!.threadId;
      if((await bb.sdk.threads.queuedMessages.list({threadId})).length)return "queued" as const;
      const text=currentLang==="ru"?`Пользователь изменил лимит пакета «${task.title}» (${task.id}): ${oldLimit} → ${limit}, учтено ${used}. Основание: ${reason}. ${epic?`Общий бюджет эпика «${epic.id}»: ${epic.used}/${epic.limit}; он продолжает действовать.`:"Общего лимита запусков команды нет; прежнее 100/100 больше не ограничивает работу."} Сначала проверь актуальный bb team report, затем продолжи только разрешённую работу в пределах пакетов и квот. В ответе называй работы по названию, а не только ID.`:`The user changed "${task.title}" (${task.id}) allowance: ${oldLimit} → ${limit}, ${used} used. Grounds: ${reason}. ${epic?`Shared epic budget ${epic.id}: ${epic.used}/${epic.limit}; it still applies.`:"There is no team-wide start cap."} Check current bb team report, then continue authorized work within package budgets and quotas. Use work titles in replies, not bare IDs.`;
      await bb.sdk.threads.send({threadId,originPluginId:bb.pluginId,mode:"auto",input:[{type:"text",text,mentions:[]}]});return "sent" as const;
    }catch{bb.log.warn("Budget saved; lead notification could not be delivered");return "unavailable" as const;}
  };

  const changeEpicBudget=async(scope:Scope,input:EpicBudgetChange,t:Strings,callerThreadId?:string)=>withScopeLock(scope,async()=>{
    // This deterministic control is for humans. A model cannot raise its own cap.
    if(callerThreadId)throw new PluginCliError("Epic budgets require a manual UI or terminal decision outside an agent thread",{code:"user_approval_required"});
    const change=epicBudgetChangeSchema.parse(input);
    const result=await resources.setEpicBudget(scope,change,async()=>{
      await tracker.validateEpic(scope,change.epicId);
      const scan=await scanTeamThreads(bb,scope.projectId);
      if(scan.rows.some(row=>row.team===scope.team&&RUNNING.includes(row.status)))
        throw new PluginCliError("Finish active team turns before changing the epic budget",{code:"role_busy"});
    },async()=>{
      const epic=await tracker.validateEpic(scope,change.epicId);
      const decisions=[epic.decisions,`Epic budget: limit ${change.limit}; revision ${change.expectedRevision} → ${change.expectedRevision+1}; ${change.expectedUsed} already used; manual decision. ${change.reason}`].filter(Boolean).join("\n\n");
      if(decisions.length>24000)throw new Error("Decision history is full");
      await tracker.update(scope,change.epicId,{decisions});
    });
    publishChange(scope.projectId);
    // Deliberately no new message, dispatch or recheck here: saving starts no model.
    return withResourceResults(result,(await readTasks(scope)).tasks);
  });

  const changePackageBudget=async(scope:Scope,input:{taskId:TaskId;limit:number;expectedLimit:number;expectedUsed:number;reason:string},t:Strings,callerThreadId?:string)=>withScopeLock(scope,async()=>{
    const {taskId,limit,expectedLimit,expectedUsed}=input;
    const reason=input.reason.trim();if(!reason||reason.length>4000)throw new PluginCliError("State the user's concrete budget decision",{code:"invalid_value"});
    const task=(await readTasks(scope)).tasks.find(task=>task.id===taskId&&["todo","in-progress","review"].includes(task.status));
    const {loaded,lead}=await teamContext(scope,t);
    if(!task||!loaded?.config.roles.some(r=>r.name===task.role))throw new PluginCliError("Open package or assigned role changed; refresh",{code:"conflict"});
    const {caller}=await classifyCaller(scope,callerThreadId,t);
    if(caller==="executor")throw new PluginCliError("Only the user or lead can change a package budget",{code:"task_forbidden"});
    let approval="manual";
    if(caller==="lead"){
      const thread=await bb.sdk.threads.get({threadId:callerThreadId!});const attempt=await resources.userControlTurn(callerThreadId!);
      if(thread.status!=="active"||!attempt)throw new PluginCliError("Budget changes by the lead require a current direct user message; ask the user in chat",{code:"user_approval_required"});
      approval=`user chat, start ${attempt}`;
    }
    const decisions=[task.decisions,`Package start budget: ${expectedLimit} → ${limit}; already used ${expectedUsed}; ${approval}. ${reason}`].filter(Boolean).join("\n\n");
    if(decisions.length>24000)throw new PluginCliError("Decision history is full",{code:"conflict"});
    const result=await resources.setPackageLimit({projectId:scope.projectId,team:scope.team,role:task.role,taskId,ownerThreadId:"",hostId:scope.hostId,isLead:task.role===lead},limit,expectedLimit,expectedUsed,async()=>{await tracker.update(scope,taskId,{decisions});});
    publishChange(scope.projectId);await bb.experimental_hooks.recheck("message.dispatch");
    if(limit>expectedLimit&&caller!=="lead")result.budgetNotice=await notifyBudgetIncrease(scope,task,expectedLimit,limit,expectedUsed,reason,t,result.epic);
    return result;
  });

  const updatePackage = async (
    scope: Scope, id: TaskId,
    patch: { status?: TaskStatus; title?: string; note?: string | null; review?: unknown; acceptReason?: string | null; returnReason?: string | null; expectedSubmissionId?: string | null },
    callerThreadId?: string,
  ): Promise<{ task: TeamTask; previous: TeamTask; busy: TeamTask[] }> =>
    withScopeLock(scope, async () => {
      const { t, m } = await loadLang();
      const store = await readTasks(scope);
      const previous = store.tasks.find(task => task.id === id);
      if (!previous) throw new PluginCliError(`Task ${id} not found`, {code: "task_not_found"});
      await assertRoleAvailable(scope, previous.role);
      // Deterministic preflight first: every read-only refusal happens
      // BEFORE the first tracker write, so a rejected request never leaves
      // review/acceptance data behind (bbt-iwi.2 review fix).
      if ((patch.status === "in-progress" || patch.status === "review") && previous.status !== patch.status && busyTasks(store,previous.role,id).length) {
        throw new PluginCliError("Role already has an active package",{code:"role_busy"});
      }
      if (patch.status === "in-progress" && previous.status !== "in-progress" && previous.status !== "review") {
        if (busyTasks(store, previous.role, id).length) throw new PluginCliError("Role already has an active package", {code:"role_busy"});
        if (!(await tracker.ready(scope)).includes(id)) throw new PluginCliError("Task is not ready in the selected tracker", {code:"task_not_ready"});
      }
      if (patch.status === "in-progress" && previous.status === "todo") {
        const {rows}=await teamContext(scope,t);const target=rows.get(previous.role)?.[0];
        if (target) {
          const assigned = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,target.threadId));
          const rework = assigned === id && latestDecision(previous.review)?.decision === "changes-requested";
          if (assigned !== undefined && !rework) throw new PluginCliError("Replace the completed role session before starting another package",{code:"session_consumed"});
        }
        if (!target || RUNNING.includes(target.status) || await readPause(scope)) throw new PluginCliError("Role thread must be idle and unpaused to start the package",{code:"role_busy"});
      }
      // bbt-iwi.2: verifiable-acceptance gate in the existing update path.
      // The server stamps the actor and time; a rewritten report never
      // re-grounds an old accept. Team threads must ground every acceptance
      // step; the manual path always requires an explicit reason too.
      const { caller, callerRole } = await classifyCaller(scope, callerThreadId, t);
      if (caller === "executor" && callerRole !== previous.role && (patch.status !== undefined || patch.review !== undefined)) {
        const error = m.onlyLeadAccepts(callerRole ?? previous.role);
        throw new PluginCliError(error.message, {code:"only_lead_accepts",hint:error.hint});
      }
      const stamp = {
        id: `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        submittedBy: caller === "manual" ? null : callerRole,
      };
      const gate = acceptanceGate({
        caller,
        callerRole,
        from: previous.status,
        to: patch.status,
        record: previous.review,
        submission: patch.review,
        acceptReason: patch.acceptReason,
        returnReason: patch.returnReason,
        expectedSubmissionId: patch.expectedSubmissionId,
        stamp,
        nowMs: Date.now(),
      });
      if (!gate.ok) {
        const err = gate.code === "review_submission_required" ? m.reviewSubmissionRequired()
          : gate.code === "acceptance_reason_required" ? m.acceptanceReasonRequired()
          : gate.code === "return_reason_required" ? m.returnReasonRequired()
          : gate.code === "submission_conflict" ? m.submissionConflict(
              String(patch.expectedSubmissionId ?? ""),
              previous.review?.submission?.id ?? "none",
            )
          : m.onlyLeadAccepts(callerRole ?? previous.role);
        throw new PluginCliError(err.message, { code: gate.code, hint: err.hint });
      }
      let reworkTarget: TeamThreadRow | undefined;
      const returning = (previous.status === "review" || previous.status === "in-progress") && (patch.status === "todo" || patch.status === "in-progress") && !!patch.returnReason?.trim();
      if (returning) {
        const {rows} = await teamContext(scope,t);
        const candidates = rows.get(previous.role) ?? [];
        if (candidates.length > 1) throw new PluginCliError("Resolve the role current session before returning the task",{code:"thread_ambiguous"});
        reworkTarget = candidates[0];
        if (!reworkTarget && patch.status === "in-progress") throw new PluginCliError("The employee has no session for rework",{code:"role_not_found"});
        if (reworkTarget) {
          const assigned = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,reworkTarget.threadId));
          if (assigned != null && assigned !== id) throw new PluginCliError("This employee session belongs to another task; resolve its assignment before requesting rework",{code:"session_consumed"});
        }
      }
      if(patch.status==="in-progress"&&previous.status==="todo"){
        const {rows,lead}=await teamContext(scope,t);const target=rows.get(previous.role)?.[0];
        if(target)await resources.assertDispatch({...scope,role:previous.role,taskId:id,ownerThreadId:target.threadId,isLead:previous.role===lead});
      }
      if (gate.submission || gate.decision) {
        await tracker.review(scope, id, {
          ...(gate.submission ? { submission: gate.submission } : {}),
          ...(gate.decision ? { decision: gate.decision } : {}),
        });
      }
      const result = await (async () => {
        try {
          return await tracker.update(scope, id, { status: patch.status, title: patch.title, note: patch.note });
        } catch (error) {
          // Never show a successful acceptance when the tracker write failed:
          // report the real partial state (review data recorded, status not).
          if (gate.submission || gate.decision) {
            throw new PluginCliError(
              `review/acceptance data recorded, but the status update failed: ${(error as Error).message}`,
              { code: "task_update_failed", hint: `Re-run the same status update; the recorded review data is kept (task ${id})` },
            );
          }
          throw error;
        }
      })();
      publishChange(scope.projectId);
      const {rows, lead} = await teamContext(scope, t);
      if (patch.status === "review" || previous.status === "in-progress" || previous.status === "review") {
        const target=rows.get(previous.role)?.[0];
        if (target && await bb.storage.kv.get(sessionTaskKey(scope,target.threadId)) === undefined) await bb.storage.kv.set(sessionTaskKey(scope,target.threadId),id);
      }
      if (patch.status === "in-progress" && previous.status === "todo") {
        const target = rows.get(result.task.role)?.[0];
        if (!target || RUNNING.includes(target.status)) throw new PluginCliError("Task activated but role thread is not idle; inspect the task before retry", {code: "role_busy"});
        const assigned = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,target.threadId));
        const decision = latestDecision(result.task.review);
        if (assigned === id && decision?.decision === "changes-requested") await notifyRework(scope, result.task, target, decision);
        else await deliverPackage(scope, result.task, target, lead);
      }
      if(previous.status==="review"&&(patch.status==="todo"||patch.status==="in-progress")){
        const decision=gate.decision??latestDecision(result.task.review);
        if(decision?.decision==="changes-requested")await resources.returned(scope,id,result.task.role,decision);
      }
      if (returning && reworkTarget && patch.status === "in-progress") {
        const decision = gate.decision ?? latestDecision(result.task.review);
        if (decision?.decision === "changes-requested") await notifyRework(scope, result.task, reworkTarget, decision);
      }
      if (patch.status === "review" && previous.status !== "review" && lead && lead !== result.task.role) {
        const target = rows.get(lead)?.[0];
        if (target) await bb.sdk.threads.send({originPluginId: bb.pluginId, threadId: target.threadId, mode: "auto", input: [{type:"text", text:`[team] ${result.task.role}: task ${id} ready for acceptance. ${result.task.title}`, mentions:[]}]});
      }
      // A repeated close (done→done, dropped→done) is idempotent: no second
      // wake of the queue, no duplicate auto-continue.
      const closingOpenTask = (patch.status === "done" || patch.status === "dropped")
        && (previous.status === "todo" || previous.status === "in-progress" || previous.status === "review");
      if (closingOpenTask) {
        await resources.finished(scope,id,caller==="manual"&&!!patch.acceptReason?.trim());
        await dispatchNextPackage(scope, result.task.role, t);
        // Acceptance auto-continue (bbt-er6.4): arm the durable request for the
        // consumed executor session, then wake requests of other roles — a
        // closed package can make their dependencies ready.
        await scheduleAutoContinue(scope, result.task.role, result.task.id, t);
        for (const other of await autoContinueRoles(scope)) {
          if (other !== result.task.role) await runAutoContinue(scope, other, t);
        }
      }
      return {...result, busy: []};
    });

  /** Executors move packages to review; only the lead (or a human) marks them done. */
  const guardAccept = async (scope: Scope, status: TaskStatus | undefined, callerThreadId: string | undefined, t: Strings, m: Messages) => {
    if ((status !== "done" && status !== "dropped") || !callerThreadId) return;
    let mark: ReturnType<typeof readTeamMark> = null;
    try {
      mark = readTeamMark((await bb.sdk.threads.getPluginMetadata({ threadId: callerThreadId })) as Record<string, unknown>);
    } catch {
      return;
    }
    if (!mark || mark.team !== scope.team) return;
    const { lead } = await teamContext(scope, t);
    if (mark.role === lead) return;
    const err = m.onlyLeadAccepts(mark.role);
    throw new PluginCliError(err.message, { code: "only_lead_accepts", hint: err.hint });
  };

  /* ── Session continuation: shared handler (bbt-er6.4) ── */

  /**
   * Shared continuation handler for `bb team replace` and the acceptance
   * auto-continue: validates the agent-saved checkpoint, switches the role to
   * a fresh session in the same environment through the durable replacement
   * intent, records execution history, then dispatches the next ready
   * package. Must be called with the scope lock held. Checkpoints are always
   * agent-saved before review; this handler never fabricates one from output.
   */
  const continueRoleSession = async (
    scope: Scope,
    roleName: string,
    oldThreadId: string,
    options: { keep?: boolean; pending?: ReplacementIntent | null; execution?: ExecutionFallbackSelection; manualApproval?:boolean } = {},
  ): Promise<{ result: ReplacementResult; continuing: boolean; kept: boolean }> => {
    const { lang, t, m } = await loadLang();
    const pending = options.pending ?? null;
    const settingsValues = await settings.get();
    const { config } = await readTeamConfig(bb, scope, scope.team, t);
    const { lead, roles } = core.semanticChecks(config, t);
    const configuredRole = roles.find((r) => r.name === roleName);
    if (!configuredRole) {
      const err = m.taskRoleUnknown(roleName);
      throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
    }
    const oldMeta=await bb.sdk.threads.getPluginMetadata({threadId:oldThreadId}) as Record<string,unknown>;
    const configuredExecution=JSON.stringify([configuredRole.provider,configuredRole.model,configuredRole.reasoningLevel,configuredRole.serviceTier]);
    const savedSelection=oldMeta.teamExecution as ExecutionFallbackSelection|undefined;
    const manual=manualExecutionApprovalSchema.safeParse(oldMeta.teamExecutionApproval);
    const linkedTask=await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,oldThreadId));
    const manualTask=manual.success&&manual.data.taskId===linkedTask?(await readTasks(scope)).tasks.find(t=>t.id===linkedTask&&t.role===roleName&&["in-progress","review"].includes(t.status)):undefined;
    const manualApproved=!!manualTask&&manual.success&&manual.data.role===roleName&&JSON.stringify(manual.data.selection)===JSON.stringify(savedSelection);
    const stillApproved=savedSelection&&configuredRole.executionPolicy?.fallbacks.some(c=>JSON.stringify(c)===JSON.stringify(savedSelection));
    const pendingQuota=(await resources.inspect(scope)).fallbacks.find(f=>f.threadId===oldThreadId&&f.selection&&f.stage!=="complete");
    const quotaApproved=pendingQuota?.selection&&configuredRole.executionPolicy?.fallbacks.some(c=>JSON.stringify(c)===JSON.stringify(pendingQuota.selection));
    const execution=options.execution??(quotaApproved?pendingQuota!.selection!:(manualApproved||oldMeta.teamExecutionApproval===undefined&&oldMeta.teamConfiguredExecution===configuredExecution&&stillApproved)?savedSelection:undefined);
    const role=core.roleSchema.parse({...configuredRole,...(execution?{provider:execution.provider,model:execution.model,reasoningLevel:execution.reasoningLevel,serviceTier:execution.serviceTier}:{})});
    const old = await bb.sdk.threads.get({ threadId: oldThreadId });
    const ref = await bb.storage.kv.get<{taskId:TaskId}>(checkpointRefKey(scope, roleName));
    if (!ref) throw new PluginCliError(`Role ${roleName} needs a saved task checkpoint: bb team checkpoint <id> --file <json>`, {code: "checkpoint_missing"});
    const checkpoint = workCheckpointSchema.parse(await tracker.readCheckpoint(scope, ref.taskId));
    if (checkpoint.threadId !== old.id || checkpoint.role !== roleName || checkpoint.taskId !== ref.taskId) throw new PluginCliError("Checkpoint belongs to a different task session", {code: "checkpoint_stale"});
    const store = await readTasks(scope);
    const busy = busyTasks(store, roleName);
    if (busy.some(task => task.id !== checkpoint.taskId)) throw new PluginCliError("Checkpoint must describe the role current package", {code: "checkpoint_stale"});
    if (!pending && RUNNING.includes(old.status)) throw new PluginCliError("Finish the active operation before replacing the session", {code: "role_busy"});
    await verifyCheckpoint(bb, checkpoint);
    if(execution){
      const catalog=await bb.sdk.providers.models({environmentId:checkpoint.environmentId,providerId:execution.provider});
      const model=catalog.models.find(m=>m.model===execution.model||m.id===execution.model);
      if(catalog.modelLoadError||!catalog.providers.some(p=>p.id===execution.provider&&p.available)||!model||
        execution.reasoningLevel&&!model.supportedReasoningEfforts.some(r=>r.reasoningEffort===execution.reasoningLevel)||
        execution.serviceTier&&!model.supportedServiceTiers?.some(tier=>tier.id===execution.serviceTier))throw new PluginCliError("The approved backup selection is no longer available; no default substitution was made",{code:"backup_unavailable"});
    }

    await validateProviders(bb, [role], t);
    const scan = await scanTeamThreads(bb, scope.projectId);
    const rows = roleThreadsOf(scan, scope.team);
    const isLead = role.name === lead.name;
    const roleThreads = new Map<string,string>();
    for (const [name,list] of rows) if (list[0]) roleThreads.set(name,list[0].threadId);
    const leadThreadId = isLead ? null : roleThreads.get(lead.name) ?? null;
    const priorTask = store.tasks.find(task=>task.id===checkpoint.taskId);
    if (!priorTask) throw new PluginCliError("Checkpoint task is missing",{code:"task_not_found"});
    // An externally reassigned package must not continue under the old role
    // with the old checkpoint/session binding — refuse before any spawn.
    if (priorTask.role !== roleName) throw new PluginCliError(`Checkpoint task ${checkpoint.taskId} is assigned to role ${priorTask.role}, not ${roleName}; the package cannot continue in this session`,{code:"task_reassigned"});
    const continuing = priorTask.status === "in-progress" || priorTask.status === "review" || priorTask.status === "todo";
    const rawPrompt = withExecutionProfile(await loadRolePrompt(bb, scope, role, isLead, lang, t),isLead ? config.roles : [role],lang);
    const taskLines = listTasks(store, {role:roleName}).map(task=>`- #${task.id} ${task.title} [${task.status}]`).join("\n");
    const prompt = core.applyPlaceholders(rawPrompt, {workspace:scope,leadThreadId,roleThreads,teamVars:config.vars,teamName:scope.team}, t)
      + (execution?`\nActual execution uses the explicitly approved backup: ${JSON.stringify(execution)}. Configured primary remains unchanged.`:"")
      + m.replaceHandoff(`@thread:${old.id}`,JSON.stringify(checkpoint,null,2),taskLines)
      + `\nCurrent task instructions from the selected tracker (preserve its constraints and authorization):\n${JSON.stringify({id:priorTask.id,role:priorTask.role,title:priorTask.title,status:priorTask.status,note:priorTask.note,criteria:priorTask.criteria??null,decisions:priorTask.decisions??null,dependencies:priorTask.dependencies??[],result:priorTask.result??null})}`
      + (continuing ? `\nThis is a task handoff, not initial setup. Resume checkpoint nextAction for task ${checkpoint.taskId} within the task instructions above. If it is in review, wait for the acceptance required by those instructions. A handoff or a saved report is not an acceptance decision. Do not pick another package; other packages remain queued.` : "\nThe checkpoint task is already accepted or cancelled. Do not execute it again. Confirm readiness and wait for the next queued assignment.")
      + `\nRoute messages by role: bb team tell <role> --message-file -. The lead role is ${lead.name}. Earlier direct thread addresses are superseded.`;
    const defaults = config.defaults ?? {};
    const sectionId = settingsValues.teamSection ? await ensureSection(bb,teamSectionName(t,scope.team),[strings("en"),strings("ru")].map(x=>teamSectionName(x,scope.team))) : null;
    const result = await replaceSession(bb, {
      projectId:scope.projectId, team:scope.team, role:roleName, taskId:checkpoint.taskId,
      oldThreadId:old.id, environmentId:checkpoint.environmentId,
      keep: pending?.keep ?? options.keep ?? false,
      prompt,
      spawnArgs: {
        projectId:scope.projectId, title:await threadTitle(scope,role.title ?? role.name,scan),
        providerId:role.provider,model:role.model,reasoningLevel:role.reasoningLevel,serviceTier:role.serviceTier,
        permissionMode:role.permissionMode ?? defaults.permissionMode,
        environment:{type:"reuse",environmentId:checkpoint.environmentId},sectionId,
        parentThreadId:leadThreadId ?? undefined,
        parentNotifications:leadThreadId ? role.parentNotifications ?? defaults.parentNotifications : undefined,
        pluginMetadata:{...teamMetadata(role,scope.team),...(execution?{teamExecution:execution,teamConfiguredExecution:configuredExecution,...((options.manualApproval||manualApproved)&&continuing?{teamExecutionApproval:{taskId:checkpoint.taskId,role:roleName,selection:execution,manual:true}}:{})}:{})}, prompt,
      },
      beforeSwitch: async () => {
        const saved = workCheckpointSchema.parse(await tracker.readCheckpoint(scope,ref.taskId));
        if (JSON.stringify(saved) !== JSON.stringify(checkpoint)) throw new PluginCliError("Checkpoint changed during replacement",{code:"checkpoint_stale"});
        await verifyCheckpoint(bb,checkpoint);
      },
      afterSwitch: async (newThreadId) => {
        const key = executionKey(scope,checkpoint.taskId);
        const prior = await bb.storage.kv.get<Record<string,unknown>>(key);
        const base = {taskId:checkpoint.taskId,role:roleName,environmentId:checkpoint.environmentId,path:checkpoint.path,branch:checkpoint.branch,commit:checkpoint.commit,checkpointAtMs:checkpoint.atMs};
        const historyKey = `session:${scope.projectId}:${scope.team}:${checkpoint.taskId}:${old.id}`;
        if (!(await bb.storage.kv.get(historyKey))) await bb.storage.kv.set(historyKey,{...base,threadId:old.id,nextThreadId:newThreadId,atMs:Date.now()});
        if (continuing) {
          await bb.storage.kv.set(key,{...prior,...base,threadId:newThreadId,delivery:"continuation"});
          await bb.storage.kv.set(sessionTaskKey(scope,newThreadId),checkpoint.taskId);
        }
        await resources.bindSwitch(scope,old.id,newThreadId);
        const pauseState = await readPause(scope);
        if (pauseState?.threadIds.includes(old.id)) {
          const threadIds = pauseState.threadIds.map(id=>id===old.id?newThreadId:id);
          await bb.storage.kv.set(pauseKey(scope),{...pauseState,threadIds});
          pausedThreads.delete(old.id);pausedThreads.add(newThreadId);
        }
      },
    });
    publishChange(scope.projectId);
    await resources.recovered(scope,result.oldThreadId,result.newThreadId);
    if (!continuing) await dispatchNextPackage(scope,roleName,t);
    if (isLead) {
      for (const [name,list] of rows) {
        if (name===roleName) continue;
        for (const executor of list) {
          try {await bb.sdk.threads.send({originPluginId:bb.pluginId,threadId:executor.threadId,mode:"queue-if-active",input:[{type:"text",text:`Team routing changed: the lead is now ${result.newThreadId}. Disregard earlier direct lead thread addresses; report through bb team tell ${lead.name} --message-file -. Task results and decisions belong in the selected tracker.`,mentions:[]}]});}
          catch(error){bb.log.warn(`Lead replaced; routing notice to ${name} failed: ${(error as Error).message}`);}
        }
      }
    }
    if (!isLead && leadThreadId) {
      try { await bb.sdk.threads.send({originPluginId:bb.pluginId,threadId:leadThreadId,mode:"queue-if-active",input:[{type:"text",text:m.replaceLeadNotice(roleName,`@thread:${result.oldThreadId}`,`@thread:${result.newThreadId}`),mentions:[]}]}); }
      catch(error) {bb.log.warn(`Session replaced; lead notice failed: ${(error as Error).message}`);}
    }
    return { result, continuing, kept: Boolean(pending?.keep ?? options.keep) };
  };

  /* ── Acceptance auto-continue (bbt-er6.4) ── */

  // Only genuinely transient busy states retry on the next trigger; every
  // other error (missing host/environment, lifecycle ownership, provider,
  // tracker failures, unclear spawn/prompt-release, unknown codes) becomes
  // an explicit role error a human must resolve.
  const TRANSIENT_BUSY_CODES = new Set([
    "role_busy",
    "old_not_idle_or_error",
    "old_became_active",
    "old_active_before_archive",
    "old_has_background_agents",
    "old_has_background_activity",
    "old_has_queued_messages",
    "old_has_pending_interaction",
  ]);
  // Errors an agent can fix by saving a fresh checkpoint: explicit wait.
  const CHECKPOINT_WAIT_CODES = new Set(["checkpoint_missing", "checkpoint_stale", "checkpoint_invalid"]);

  /**
   * Durable, technical auto-continue request (KV): ids and stages only.
   * reason "context" marks an explicit or automatic context-rotation request
   * (the same open package continues in a fresh session); absence or
   * "accepted" keeps the acceptance policy (bbt-er6.4).
   */
  interface AutoContinueRecord {
    /** The package that consumed the session (accepted) or continues in it (context). */
    taskId: TaskId;
    reason?: "accepted" | "context";
    /** The session the request was armed for: stale records clear after a manual switch, even when the taskId continues (context). */
    originThreadId?: string | null;
    stage: AutoContinueStage;
    errorCode: string | null;
    /** Short technical failure message; checkpoint content is never copied. */
    error: string | null;
    /** Stage the executor was last notified about (notification dedup). */
    notifiedStage: AutoContinueStage | null;
    requestedAtMs: number;
    updatedAtMs: number;
  }
  const autoContinueKey = (scope: Scope, role: string) => `auto-continue:${scope.projectId}:${scope.team}:${role}`;
  const readAutoContinue = async (scope: Scope, role: string): Promise<AutoContinueRecord | null> =>
    (await bb.storage.kv.get<AutoContinueRecord>(autoContinueKey(scope, role))) ?? null;
  const writeAutoContinue = async (scope: Scope, role: string, record: AutoContinueRecord): Promise<void> => {
    await bb.storage.kv.set(autoContinueKey(scope, role), record);
  };
  const autoContinueRoles = async (scope: Scope): Promise<string[]> => {
    const prefix = `auto-continue:${scope.projectId}:${scope.team}:`;
    const roles: string[] = [];
    for (const key of await bb.storage.kv.list(prefix)) roles.push(key.slice(prefix.length));
    return roles;
  };

  /**
   * After a done/dropped package consumed an executor session: arm the
   * durable auto-continue and advance it once. Lead sessions are never
   * replaced automatically. Not armed on review transitions or plain idle.
   */
  const scheduleAutoContinue = async (scope: Scope, role: string, taskId: TaskId, t: Strings): Promise<void> => {
    const { rows, lead } = await teamContext(scope, t);
    if (role === lead) return;
    const list = rows.get(role);
    if (!list || list.length !== 1) return; // missing or ambiguous: a human decides
    const thread = list[0]!;
    if ((await bb.storage.kv.get<TaskId>(sessionTaskKey(scope, thread.threadId))) !== taskId) return; // session not consumed by this package
    const existing = await readAutoContinue(scope, role);
    if (existing?.stage === "failed" && existing.taskId === taskId) return; // no automatic restart after an unclear failure
    const now = Date.now();
    if (!existing || existing.taskId !== taskId) {
      await writeAutoContinue(scope, role, {
        taskId, reason: "accepted", originThreadId: thread.threadId, stage: "awaiting-safe-boundary",
        errorCode: null, error: null, notifiedStage: null,
        requestedAtMs: now, updatedAtMs: now,
      });
    }
    await runAutoContinue(scope, role, t);
  };

  const notifyAutoContinueCheckpoint = async (role: string, threadId: string, taskId: TaskId): Promise<void> => {
    try {
      await bb.sdk.threads.send({
        originPluginId: bb.pluginId, threadId, mode: "queue-if-active",
        input: [{type: "text", text: (await loadLang()).lang === "ru" ? `[team] Запрошена передача сессии. Сохрани содержательный checkpoint задачи ${taskId}: bb team checkpoint ${taskId} --file <абсолютный-json-путь>. JSON: goal, criteria[], progress, decisions[{what,why}], checks[{what,result}], blockers[], nextAction, files[]. Укажи только фактически сделанное и проверенное. Не начинай другую задачу. Заверши текущую операцию; Team дождётся безопасной границы, сохранит окружение и передаст состояние новой сессии.` : `[team] Session handoff requested. Save a fresh checkpoint now: bb team checkpoint ${taskId} --file <absolute-json-path>. JSON: goal, criteria[], progress, decisions[{what,why}], checks[{what,result}], blockers[], nextAction, files[]. Record only actual work and checks. Do not start another package. Finish the current operation; Team will wait for a safe boundary and preserve your environment for the next session.`, mentions: []}],
      });
    } catch (error) {
      bb.log.warn(`auto-continue: checkpoint request to ${role} failed: ${(error as Error).message}`);
      throw error;
    }
  };

  const notifyAutoContinueFailed = async (role: string, leadThreadId: string | null, taskId: TaskId, code: string, message: string): Promise<void> => {
    if (!leadThreadId) return; // the snapshot/doctor error state still surfaces it
    try {
      await bb.sdk.threads.send({
        originPluginId: bb.pluginId, threadId: leadThreadId, mode: "queue-if-active",
        input: [{type: "text", text: `[team] Auto-continue of role ${role} stopped after package #${taskId}: [${code}] ${message}. The completed session is kept. Inspect bb team doctor, then bb team replace ${role} --dry-run before retrying; nothing is respawned automatically.`, mentions: []}],
      });
    } catch (error) {
      bb.log.warn(`auto-continue: failure notice to the lead failed: ${(error as Error).message}`);
    }
  };

  /**
   * Advance one durable auto-continue request. Idempotent: recomputes the
   * state from tasks, the agent-saved checkpoint and live thread activity;
   * the KV record keeps only technical fields and notification dedup.
   * Retries are event-driven (idle, checkpoint saved, package added or
   * accepted, resume, plugin restart) — there is no second scheduler.
   */
  const runAutoContinue = async (scope: Scope, role: string, t: Strings): Promise<void> => {
    const record = await readAutoContinue(scope, role);
    if (!record) return;
    let current = record;
    const save = async (patch: Partial<AutoContinueRecord>) => {
      current = {...current, ...patch, updatedAtMs: Date.now()};
      await writeAutoContinue(scope, role, current);
      return current;
    };
    const notifyCheckpointWait = async (threadId?: string) => {
      const target = threadId ?? await bb.storage.kv.get<string>(activeSessionKey(scope.projectId, scope.team, role));
      if (target) await notifyAutoContinueCheckpoint(role, target, record.taskId);
    };
    const fail = async (code: string, message: string) => {
      await save({stage: "failed", errorCode: code, error: message});
      try {
        const { rows, lead } = await teamContext(scope, t);
        await notifyAutoContinueFailed(role, lead && lead !== role ? rows.get(lead)?.[0]?.threadId ?? null : null, record.taskId, code, message);
      } catch {
        // the failed KV record still surfaces in snapshot and doctor
      }
    };
    try {
      const { rows, lead } = await teamContext(scope, t);
      if (role === lead && record.reason !== "context") {
        // never replace the lead automatically on package acceptance
        await bb.storage.kv.delete(autoContinueKey(scope, role));
        return;
      }
      const list = rows.get(role);
      if (!list || list.length !== 1) return; // ambiguous or gone: wait for a human
      const thread = list[0]!;
      const intent = await readReplacementIntent(bb, scope.projectId, scope.team, role);
      if (
        (await bb.storage.kv.get<TaskId>(sessionTaskKey(scope, thread.threadId))) !== record.taskId ||
        (typeof record.originThreadId === "string" && record.originThreadId !== thread.threadId)
      ) {
        if (intent && intent.stage !== "complete") {
          if (record.stage !== "failed") await fail("replacement_unfinished", `Role binding changed before replacement finished (stage ${intent.stage}); resume bb team replace ${role} to finish the existing intent`);
          return;
        }
        // The session was already replaced or freed by hand — also clears a
        // failed record after manual recovery, even when a context rotation
        // continues the same taskId in the new session.
        await bb.storage.kv.delete(autoContinueKey(scope, role));
        return;
      }
      if (record.stage === "failed") return; // keep the explicit error; no auto-retry
      if (intent && intent.stage !== "complete") {
        // A previous switch attempt died mid-flight (only a crash leaves a
        // non-complete intent behind: runs are serialized by the scope lock).
        // Never respawn automatically: surface the durable-intent recovery.
        await fail(
          intent.stage === "spawn_uncertain" ? "spawn_uncertain" : "replacement_unfinished",
          `session replacement is unfinished (stage ${intent.stage}); retry bb team replace ${role} to resume the durable intent, or --abort before the switch`,
        );
        return;
      }
      const store = await readTasks(scope);
      // Context rotation continues the role's current open package in a new
      // session; acceptance policy waits instead. A package other than the
      // record's own still means the role is busy: wait.
      const recordTask = store.tasks.find(task => task.id === record.taskId);
      const contextFlow =
        record.reason === "context" &&
        !!recordTask &&
        (recordTask.status === "in-progress" || recordTask.status === "review");
      if (busyTasks(store, role).some(task => task.id !== record.taskId)) return; // another open package; wait
      // Replace the consumed session only when the next package is already
      // ready: idle sessions are not wasted on fresh threads. A context
      // rotation does not wait — it passes the current package along. If the
      // package was accepted meanwhile, the acceptance policy applies.
      if (!contextFlow) {
        const ready = new Set(await tracker.ready(scope));
        if (!listTasks(store, {role}).some(task => task.status === "todo" && ready.has(task.id))) {
          await save({stage: "awaiting-package"});
          return;
        }
      }
      if (await readPause(scope) || await isRolePaused(scope,role) || packageResourceBlock(await resources.inspect(scope),contextFlow?record.taskId:null)) return; // an explicit decision/resume retries
      const deferred=await readDeferred(bb,deferredKey(scope.projectId,scope.team,role));
      if(deferred&&deferred.stage!=="released")return; // core's scheduled message owns this continuation
      const router=await routerUsage(thread.threadId);
      if(router.service==="openrouter"){
        const model=(await bb.sdk.threads.getPluginMetadata({threadId:thread.threadId}) as {teamExecution?:ExecutionFallbackSelection}).teamExecution?.model??(await readTeamConfig(bb,scope,scope.team,t)).config.roles.find(r=>r.name===role)?.model;
        if(openRouterHeadroom(router,model,(await readQuotaPolicy(scope)).pauseBelowPercent).held){await bb.storage.kv.set(routerWaitKey({...scope,role}),"OpenRouter: shared quota below the safety threshold; choose when/how to continue");return;}
        if(await bb.storage.kv.get(routerWaitKey({...scope,role})))return;
      }
      const currentMeta=await bb.sdk.threads.getPluginMetadata({threadId:thread.threadId}) as {teamExecution?:ExecutionFallbackSelection};
      const currentRole=(await readTeamConfig(bb,scope,scope.team,t)).config.roles.find(r=>r.name===role);
      if(isOllamaCloud(thread.provider,currentMeta.teamExecution?.model??currentRole?.model)){
        const owner=await resourceOwner(thread.threadId);
        if(owner?.hostId){
          if(quotaHeadroom(await cloudUsage(owner.hostId),await readQuotaPolicy(scope)).held){await bb.storage.kv.set(quotaWaitKey(scope,role),"Ollama Cloud: account headroom is below the safety threshold; decide when/how to continue");return;}
          if(await bb.storage.kv.get(quotaWaitKey(scope,role)))return;
        }
      }
      // A substantive checkpoint must come from the agent. Missing or stale →
      // explicit wait plus a notification; never a fabricated checkpoint.
      const ref = await bb.storage.kv.get<{taskId: TaskId}>(checkpointRefKey(scope, role));
      let checkpointFresh = false;
      if (ref && ref.taskId === record.taskId) {
        try {
          const checkpoint = workCheckpointSchema.parse(await tracker.readCheckpoint(scope, ref.taskId));
          if (checkpoint.taskId === record.taskId && checkpoint.threadId === thread.threadId && checkpoint.role === role) {
            await verifyCheckpoint(bb, checkpoint);
            checkpointFresh = true;
          }
        } catch (error) {
          const code = (error as {code?: unknown}).code;
          // Environment-level failures are role errors, not a re-save fix.
          if (code === "environment_missing" || code === "environment_unavailable") throw error;
          // Unexpected (tracker/database) errors are role errors too; only
          // checkpoint-shaped problems (missing/stale/invalid) keep waiting.
          if (typeof code !== "string" && (error as Error).name !== "ZodError") throw error;
        }
      }
      if (!checkpointFresh) {
        await save({stage: "awaiting-checkpoint"});
        if (current.notifiedStage !== "awaiting-checkpoint") {
          await notifyCheckpointWait(thread.threadId);
          await save({notifiedStage: "awaiting-checkpoint"});
        }
        return;
      }
      // Safe boundary: never interrupt running work, queued messages,
      // pending interactions or background operations; thread.idle retries.
      const live = await bb.sdk.threads.get({threadId: thread.threadId});
      if (RUNNING.includes(live.status) || live.queuedMessageCount > 0 || live.activeBackgroundAgentCount > 0) {
        await save({stage: "awaiting-safe-boundary", notifiedStage: null});
        return;
      }
      await continueRoleSession(scope, role, thread.threadId, {keep: false});
      await bb.storage.kv.delete(autoContinueKey(scope, role));
      publishChange(scope.projectId);
    } catch (error) {
      // Everything the machine could not classify — including tracker, host,
      // environment, config and provider failures — becomes an explicit role
      // error, never a silent event-log line.
      const rawCode = (error as {code?: unknown}).code;
      const code = typeof rawCode === "string" ? rawCode : (error as Error).name === "ZodError" ? "checkpoint_invalid" : "auto_continue_failed";
      const message = (error as Error).message;
      if (TRANSIENT_BUSY_CODES.has(code)) {
        // busy, active, queued or interacting: retry on the next trigger
        await save({stage: "awaiting-safe-boundary", notifiedStage: null});
        return;
      }
      if (CHECKPOINT_WAIT_CODES.has(code)) {
        await save({stage: "awaiting-checkpoint"});
        if (current.notifiedStage !== "awaiting-checkpoint") {
          await notifyCheckpointWait();
          await save({notifiedStage: "awaiting-checkpoint"});
        }
        return;
      }
      // NO_AUTO_RETRY_CODES and every other failure stop automatically;
      // a human gets the concrete reason and a safe action.
      await fail(code, message);
    }
  };

  /* ── Context rotation (bbt-er6.8) ── */

  // Fill ratio at or above which an idle session asks for rotation.
  const CONTEXT_ROTATION_THRESHOLD = 0.8;

  /**
   * Arm an explicit context-rotation request (bb team checkpoint --rotate):
   * the current open package continues in a fresh session once the thread
   * reaches a safe boundary. Works for executors and for the lead. The
   * caller's own active turn is never stopped — the machine only replaces
   * idle sessions, so an agent gets "requested" back and a human on an idle
   * role gets "replaced".
   */
  const armContextRotation = async (scope: Scope, role: string, taskId: TaskId, originThreadId: string, t: Strings): Promise<"requested" | "replaced"> => {
    const intent = await readReplacementIntent(bb, scope.projectId, scope.team, role);
    if (intent && intent.stage !== "complete") {
      throw new PluginCliError("A session replacement is already in progress; the checkpoint is saved — retry --rotate after it completes", { code: "replacement_pending" });
    }
    const existing = await readAutoContinue(scope, role);
    if (existing?.stage === "failed") {
      throw new PluginCliError(`Auto-continue of role ${role} failed earlier (${existing.errorCode}); recover with bb team replace ${role} --dry-run before requesting rotation`, { code: "auto_continue_failed" });
    }
    const now = Date.now();
    await writeAutoContinue(scope, role, {
      taskId, reason: "context", originThreadId, stage: "awaiting-safe-boundary",
      errorCode: null, error: null, notifiedStage: null,
      requestedAtMs: now, updatedAtMs: now,
    });
    await runAutoContinue(scope, role, t);
    return (await readAutoContinue(scope, role)) ? "requested" : "replaced";
  };

  // The selected role card reads this on demand. Reading never advances the machine.
  const readSessionView = async (scope: Scope, role: string, t: Strings): Promise<SessionView> => {
    const { rows } = await teamContext(scope, t);
    const list = rows.get(role) ?? [];
    const view: SessionView = { threadId: null, taskId: null, context: contextView(null), checkpoint: "missing", phase: "idle", reason: null, blockedReason: null, errorCode: null };
    if (list.length !== 1) return { ...view, blockedReason: list.length ? "multiple_sessions" : "no_session" };
    const thread = list[0]!;
    view.threadId = thread.threadId;
    const canonical = await bb.storage.kv.get<string>(activeSessionKey(scope.projectId, scope.team, role));
    if (canonical && canonical !== thread.threadId) return { ...view, blockedReason: "session_changed" };
    try { view.context = contextView((await bb.sdk.threads.context({ threadId: thread.threadId })).usage); } catch { /* Unsupported provider is not a role failure. */ }
    const request = await readAutoContinue(scope, role);
    const intent = await readReplacementIntent(bb, scope.projectId, scope.team, role);
    if (request) {
      view.phase = request.stage === "failed" ? "error" : request.stage;
      view.reason = request.reason ?? "accepted";
      view.errorCode = request.errorCode;
    }
    if (intent && intent.stage !== "complete") {
      view.phase = intent.stage === "spawn_uncertain" || intent.stage === "invalid" ? "error" : "replacing";
      view.blockedReason = "replacement_pending";
    }
    if (intent?.stage === "complete" && intent.delivery === "uncertain") {view.phase="error";view.blockedReason="failed";view.errorCode="delivery_uncertain";}
    if (request?.stage === "failed") view.blockedReason = "failed";
    const linked = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope, thread.threadId));
    view.taskId = linked ?? null;
    if (linked == null) { view.blockedReason ??= "no_task"; return view; }
    let task: TeamTask | undefined;
    try { task = (await readTasks(scope)).tasks.find(task => task.id === linked); }
    catch { view.checkpoint = "unavailable"; view.blockedReason ??= "tracker_unavailable"; return view; }
    if (!task) { view.blockedReason ??= "no_task"; return view; }
    if (task.role !== role) { view.blockedReason ??= "task_reassigned"; return view; }
    if ((task.status === "done" || task.status === "dropped") && view.reason === "context") view.reason = "accepted";
    const ref = await bb.storage.kv.get<{ taskId: TaskId }>(checkpointRefKey(scope, role));
    if (ref) {
      view.checkpoint = "stale";
      if (ref.taskId === linked) {
        try {
          const checkpoint = workCheckpointSchema.parse(await tracker.readCheckpoint(scope, linked));
          if (checkpoint.threadId === thread.threadId && checkpoint.role === role && checkpoint.taskId === linked) {
            await verifyCheckpoint(bb, checkpoint);
            view.checkpoint = "ready";
          }
        } catch (error) {
          const code = (error as {code?: string}).code;
          if (code !== "checkpoint_stale" && code !== "checkpoint_invalid" && (error as Error).name !== "ZodError") view.checkpoint = "unavailable";
        }
      }
    }
    if (await readPause(scope)) view.blockedReason ??= "paused";
    return view;
  };

  /**
   * One context-usage measurement per thread.idle for a canonical non-helper
   * team role. threads.context reads counters only — it never calls the
   * model. Automation trusts only exact finite numbers (estimated===false,
   * limit>0, used>=0) and a consistent snapshot; an estimated value, a null
   * or unsupported API, or a contradiction is a silent no-op: no role error,
   * no spam — the explicit --rotate request remains available.
   */
  const maybeArmContextRotation = async (scope: Scope, role: string, meta: Record<string, unknown>, threadId: string, t: Strings): Promise<boolean> => {
    if (meta.teamRetired === true || meta.teamReplacement === true) return false;
    const linked = await bb.storage.kv.get<TaskId>(sessionTaskKey(scope, threadId));
    if (linked === undefined || linked === null) return false; // no linked package: never invent one
    const store = await readTasks(scope);
    const task = store.tasks.find(item => item.id === linked);
    if (!task || task.role !== role) return false; // reassigned or missing: never arm for the old role
    if (task.status !== "in-progress" && task.status !== "review") return false;
    const { rows } = await teamContext(scope, t);
    const list = rows.get(role);
    if (!list || list.length !== 1 || list[0]!.threadId !== threadId) return false; // not the canonical session
    let usage: { estimated: boolean; modelContextWindow: number; usedTokens: number; snapshot?: { estimated: boolean; contextWindowTokens: number; usedTokens: number } } | null = null;
    try {
      usage = (await bb.sdk.threads.context({ threadId })).usage;
    } catch {
      return false; // unsupported API: no automation, no error surfaced
    }
    if (!usage || usage.estimated !== false) return false;
    const limit = usage.modelContextWindow, used = usage.usedTokens;
    if (!Number.isFinite(limit) || !(limit > 0) || !Number.isFinite(used) || !(used >= 0)) return false;
    const snap = usage.snapshot;
    if (snap && (snap.estimated === true || snap.contextWindowTokens !== limit || snap.usedTokens !== used || !Number.isFinite(snap.contextWindowTokens) || !Number.isFinite(snap.usedTokens))) return false; // contradiction: do not trust the top-level numbers
    if (used / limit < CONTEXT_ROTATION_THRESHOLD) return false;
    const now = Date.now();
    await writeAutoContinue(scope, role, {
      taskId: linked, reason: "context", originThreadId: threadId, stage: "awaiting-safe-boundary",
      errorCode: null, error: null, notifiedStage: null,
      requestedAtMs: now, updatedAtMs: now,
    });
    return true;
  };

  // Host RPC is unavailable during factory registration. Restore once only
  // after startup; keep the SDK service alive until disposal (no polling).
  bb.background.service("restore-auto-continuation",{async start(signal){
    if(signal.aborted)return;
  try {
    const { t } = await loadLang();
    for (const key of await bb.storage.kv.list("auto-continue:")) {
      const parts = key.split(":");
      const projectId = parts[1]!, team = parts[2]!, role = parts.slice(3).join(":");
      if (!projectId || !team || !role) continue;
      try {
        const scope = await scopeFor(projectId, team, t);
        await withScopeLock(scope, async () => { await runAutoContinue(scope, role, t); });
      } catch (error) {
        bb.log.warn(`auto-continue restore for ${key} failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    bb.log.warn(`auto-continue restore failed: ${(error as Error).message}`);
  }

    if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
  }});

  const taskOutput = (
    result: { task: TeamTask; previous: TeamTask; busy: TeamTask[] },
    json: boolean,
    scope: Scope,
    m: Messages,
  ) => {
    if (json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          project: scope.projectId,
          team: scope.team,
          task: result.task,
          previousStatus: result.previous.status,
        }),
      };
    }
    const out = [m.taskUpdated(result.task.id, result.previous.status, result.task.status)];
    if (result.busy.length > 0) {
      out.push(`  ${m.taskBusy(result.task.role, result.busy.map((task) => `#${task.id}`).join(", "))}`);
    }
    return { exitCode: 0, stdout: out.join("\n") };
  };

  /* ── Spawning: create a team / add roles ── */

  interface SpawnedRole {
    role: string;
    kind: "created" | "adopted";
    title: string;
    threadId: string;
    provider: string;
  }

  /** Validate an adoptable thread: exists, same project, not archived, not in a team. */
  const adoptableThread = async (
    scope: Scope,
    roleName: string,
    threadId: string,
    scan: ThreadScan,
    t: Strings,
    m: Messages,
  ) => {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      throw new PluginCliError(t.threadNotFound(roleName, threadId), { code: "thread_not_found" });
    }
    if (thread.projectId !== scope.projectId) {
      throw new PluginCliError(t.threadWrongProject(roleName, threadId), {
        code: "thread_wrong_project",
      });
    }
    if (thread.archivedAt !== null) {
      const err = t.threadArchived(roleName, threadId);
      throw new PluginCliError(err.message, { code: "thread_archived", hint: err.hint });
    }
    const owner = scan.rows.find((row) => row.threadId === threadId && !row.helper);
    if (owner && (owner.team !== scope.team || owner.role !== roleName)) {
      const err = m.threadTaken(threadId, owner.team, owner.role);
      throw new PluginCliError(err.message, { code: "thread_taken", hint: err.hint });
    }
    return thread;
  };

  /**
   * Spawn (or adopt) every missing role of a team: the lead first, then the
   * executors as its child threads. `only` limits the run to some roles.
   */
  const spawnTeam = async (
    scope: Scope,
    lang: Language,
    t: Strings,
    m: Messages,
    options: { only?: string[] } = {},
  ) => withScopeLock(scope, async () => {
    const settingsValues = await settings.get();
    const loaded = await readTeamConfig(bb, scope, scope.team, t);
    const { config, source } = loaded;
    const { lead, roles } = core.semanticChecks(config, t);
    // The tracker database must exist before the team starts working: prepare
    // is idempotent and dry-run paths never reach here.
    await tracker.prepare(scope);
    const defaults = config.defaults ?? {};
    const wanted = (role: Role) => !options.only || options.only.includes(role.name) || role.name === lead.name;
    await validateProviders(bb, roles.filter((r) => !r.threadId && wanted(r)), t);
    const bindingIssues = await inspectBindings(bb, scope.projectId, scope.team, roles.filter(wanted).map(r => r.name));
    if (bindingIssues.some(issue => issue.state !== "missing")) throw new PluginCliError("Team session bindings need recovery. Open Team and restore the existing employee; do not create duplicate threads.", {code:"binding_recovery_required"});
    const scan = await scanTeamThreads(bb, scope.projectId);
    const existingRows = roleThreadsOf(scan, scope.team);
    const existing = new Map(
      [...existingRows.entries()].map(([role, list]) => [role, list.map((row) => row.threadId)]),
    );

    interface PlanEntry {
      role: Role;
      environment: SpawnEnvironment | null;
      prompt: string;
    }
    const plan: PlanEntry[] = [];
    for (const configuredRole of roles) {
      const role = {...configuredRole};
      const canonical = await bb.storage.kv.get<string>(`active-session:${scope.projectId}:${scope.team}:${role.name}`);
      if (canonical && existing.get(role.name)?.includes(canonical)) delete role.threadId;
      if (!wanted(role)) continue;
      const already = existing.get(role.name);
      if (role.threadId || (already && already.length > 0)) {
        plan.push({ role, environment: null, prompt: "" });
        continue;
      }
      plan.push({
        role,
        environment: await resolveEnvironment(bb, scope, roleEnvironmentSpec(role, config), t),
        prompt: withExecutionProfile(await loadRolePrompt(bb, scope, role, role.name === lead.name, lang, t),role.name===lead.name ? config.roles : [role],lang),
      });
    }

    const sectionId = settingsValues.teamSection
      ? await ensureSection(bb, teamSectionName(t, scope.team), [strings("en"), strings("ru")].map((x) => teamSectionName(x, scope.team)))
      : null;
    const roleThreads = new Map<string, string>();
    for (const [role, ids] of existing) if (ids[0]) roleThreads.set(role, ids[0]);
    const roleProviders = new Map<string, string>();
    const spawned: SpawnedRole[] = [];
    let leadThreadId: string | null = existing.get(lead.name)?.[0] ?? null;

    const spawnRole = async (entry: PlanEntry, parentThreadId: string | undefined) => {
      const prompt = core.applyPlaceholders(
        entry.prompt,
        { workspace: scope, leadThreadId, roleThreads, teamVars: config.vars, teamName: scope.team },
        t,
      );
      const spawnArgs = {
        projectId: scope.projectId,
        title: await threadTitle(scope, entry.role.title ?? entry.role.name, scan),
        providerId: entry.role.provider,
        model: entry.role.model,
        reasoningLevel: entry.role.reasoningLevel,
        serviceTier: entry.role.serviceTier,
        permissionMode: entry.role.permissionMode ?? defaults.permissionMode,
        environment: entry.environment!,
        sectionId,
        parentThreadId,
        parentNotifications: parentThreadId
          ? entry.role.parentNotifications ?? defaults.parentNotifications
          : undefined,
        pluginMetadata: {...teamMetadata(entry.role, scope.team), teamReplacement: true},
        prompt,
      };
      // A brand-new environment can fail its first spawn while provisioning;
      // one retry after a short delay clears it.
      for (let attempt = 1; ; attempt += 1) {
        try {
          const thread = await bb.sdk.threads.spawn(spawnArgs);
          return { threadId: thread.id, providerId: thread.providerId };
        } catch (error) {
          if (attempt >= 2) {
            const err = t.spawnFailed(entry.role.name, (error as Error).message);
            throw new PluginCliError(err.message, { code: "spawn_failed", hint: err.hint });
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    };

    const adoptRole = async (entry: PlanEntry, parentThreadId: string | undefined) => {
      const id = entry.role.threadId!;
      const thread = await adoptableThread(scope, entry.role.name, id, scan, t, m);
      await bb.sdk.threads.updatePluginMetadata({
        threadId: id,
        set: teamMetadata(entry.role, scope.team),
      });
      const title = await threadTitle(scope, entry.role.title ?? entry.role.name, scan);
      await bb.sdk.threads.update({
        threadId: id,
        title,
        ...(parentThreadId && thread.parentThreadId !== parentThreadId ? { parentThreadId } : {}),
        ...(sectionId && thread.sectionId !== sectionId ? { sectionId } : {}),
      });
      return { threadId: id, providerId: thread.providerId };
    };

    const upsert = async (entry: PlanEntry, parent: string | undefined) => {
      const result = entry.role.threadId ? await adoptRole(entry, parent) : await spawnRole(entry, parent);
      await bb.storage.kv.set(activeSessionKey(scope.projectId, scope.team, entry.role.name), result.threadId);
      await bb.sdk.threads.updatePluginMetadata({threadId: result.threadId, set:{teamReplacement:false, teamRetired:false}});
      await bb.experimental_hooks.recheck("message.dispatch");
      roleThreads.set(entry.role.name, result.threadId);
      roleProviders.set(entry.role.name, result.providerId);
      spawned.push({
        role: entry.role.name,
        kind: entry.role.threadId ? "adopted" : "created",
        title: entry.role.title ?? entry.role.name,
        threadId: result.threadId,
        provider: result.providerId,
      });
      return result.threadId;
    };

    const needsWork = (entry: PlanEntry) => {
      const already = existing.get(entry.role.name) ?? [];
      return entry.role.threadId ? !already.includes(entry.role.threadId) : already.length === 0;
    };

    const leadEntry = plan.find((p) => p.role.name === lead.name)!;
    if (needsWork(leadEntry)) leadThreadId = await upsert(leadEntry, undefined);
    for (const entry of plan) {
      if (entry.role.name === lead.name || !needsWork(entry)) continue;
      await upsert(entry, leadThreadId ?? undefined);
    }
    // Re-link existing executor threads that lost their lead (bb team doctor warns about them).
    let relinked = 0;
    if (leadThreadId && !options.only) {
      for (const [role, list] of existingRows) {
        if (role === lead.name) continue;
        for (const row of list) {
          if (row.parentThreadId === leadThreadId) continue;
          await bb.sdk.threads.update({ threadId: row.threadId, parentThreadId: leadThreadId });
          relinked += 1;
        }
      }
    }

    const children = spawned.filter((item) => item.role !== lead.name);
    let rosterQueued = false;
    if (settingsValues.roster && leadThreadId && children.length > 0) {
      const roster = [
        t.rosterLines.header(scope.team, source),
        "",
        t.rosterLines.executors,
        ...children.map(
          (c) => `- ${c.title} (${c.role}) — @thread:${c.threadId} (provider: ${c.provider})`,
        ),
        "",
        t.rosterLines.tell,
        t.rosterLines.notify,
        t.rosterLines.next,
      ].join("\n");
      await bb.sdk.threads.send({
        originPluginId: bb.pluginId,
        threadId: leadThreadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: roster, mentions: [] }],
      });
      rosterQueued = true;
    }
    publishChange(scope.projectId);
    return { source, leadThreadId, sectionId, spawned, existing, rosterQueued, relinked };
  });

  /** Add a role to a team config (append keeps comments), then spawn or adopt it. */
  const addRole = async (
    scope: Scope,
    input: TemplateRole & { threadId?: string },
    lang: Language,
    t: Strings,
    m: Messages,
    spawn: boolean,
  ) => {
    const loaded = await readTeamConfig(bb, scope, scope.team, t);
    const scan = await scanTeamThreads(bb, scope.projectId);
    if (input.threadId) await adoptableThread(scope, input.name, input.threadId, scan, t, m);
    if (input.provider && !input.threadId) await validateProviders(bb, [input], t);

    const layout = teamLayout(scope.team, loaded.legacy);
    const entry: Record<string, unknown> = { name: input.name };
    if (input.kind && input.kind !== input.name) entry.kind = input.kind;
    if (input.title) entry.title = input.title;
    if (input.provider) entry.provider = input.provider;
    if (input.model) entry.model = input.model;
    if (input.reasoningLevel) entry.reasoningLevel = input.reasoningLevel;
    if (input.serviceTier) entry.serviceTier = input.serviceTier;
    if (input.executionPolicy) entry.executionPolicy = input.executionPolicy;
    if (input.quotaSource) entry.quotaSource = input.quotaSource;
    if (input.environment) entry.environment = input.environment;
    if (input.notifyOn?.length) entry.notifyOn = input.notifyOn;
    if (input.threadId) {
      entry.threadId = input.threadId;
    } else if (input.prompt) {
      const rel = `${layout.promptDir}/${input.name}.md`;
      await writeWorkspaceFile(bb, scope, rel, `${input.prompt.trim()}\n`);
      entry.promptFile = rel;
    }

    // The exists-check and the append must be atomic: two concurrent roleAdd
    // calls would otherwise both pass the check and one role would be lost.
    const rewritten = await withScopeLock(scope, async () => {
      const current = await readTeamConfig(bb, scope, scope.team, t);
      if (current.config.roles.some((role) => role.name === input.name)) {
        const err = m.roleExists(input.name, scope.team);
        throw new PluginCliError(err.message, { code: "role_exists", hint: err.hint });
      }
      const raw = (await readFileOrNull(bb, scope, current.source)) ?? "";
      let rewritten = false;
      let next: string;
      if (current.source.endsWith(".json")) {
        const parsed = JSON.parse(raw) as { roles: unknown[] };
        parsed.roles.push(entry);
        next = `${JSON.stringify(parsed, null, 2)}\n`;
      } else {
        const appended = appendRoleToYaml(raw, entry);
        if (appended) {
          next = appended;
        } else {
          rewritten = true;
          next = dumpYaml({ ...current.config, roles: [...current.config.roles, entry] }, { lineWidth: 120 });
        }
      }
      core.parseTeamConfig(next, current.source, t); // never write a config that does not parse
      await writeWorkspaceFile(bb, scope, current.source, next);
      return rewritten;
    });
    let threadId: string | null = null;
    if (spawn) {
      const result = await spawnTeam(scope, lang, t, m, { only: [input.name] });
      threadId = result.spawned.find((item) => item.role === input.name)?.threadId ?? null;
    }
    publishChange(scope.projectId);
    return { role: input.name, threadId, rewritten };
  };

  /** Create a team from a template: files, versioning, threads. */
  const createTeamFromTemplate = async (
    scope: Scope,
    template: Pick<TeamTemplate, "title" | "roles">,
    options: { versioned: boolean; force: boolean; spawn: boolean },
    lang: Language,
    t: Strings,
    m: Messages,
  ) => {
    // The exists-check and the file writes must be atomic: two concurrent
    // creates would otherwise both pass the check and write/spawn twice.
    const written = await withScopeLock(scope, async () => {
      const teams = await listConfiguredTeams(bb, scope);
      if (teams.includes(scope.team) && !options.force) {
        const err = m.teamExists(scope.team);
        throw new PluginCliError(err.message, { code: "team_exists", hint: err.hint });
      }
      await validateProviders(bb, template.roles.filter((r) => r.enabled !== false), t);
      // Prepare the tracker storage before any files are written or threads
      // spawned, so a fresh team never starts against a missing database.
      await tracker.prepare(scope);
      // Without a checkout environment the roles start in the project default one.
      const checkouts = await bb.sdk.environments
        .list({ projectId: scope.projectId, environmentProviderId: "project-checkout" })
        .catch(() => []);
      const files = teamFilesFromTemplate(lang, template, scope.team, {
        environment: checkouts.length > 0 ? "checkout" : "default",
      });
      const written = await writeTeamFiles(scope, files, options.force, t);
      await setVersioned(scope, false, options.versioned);
      return written;
    });
    const result = options.spawn ? await spawnTeam(scope, lang, t, m) : null;
    return { written, result };
  };

  const abortRoleReplacement = async (scope:Scope, roleName:string, pending:ReplacementIntent|null) => {
    if (!pending || pending.stage === "invalid") throw new PluginCliError("No unfinished replacement to abort",{code:"replacement_missing"});
    const canonical=await bb.storage.kv.get<string>(`active-session:${scope.projectId}:${scope.team}:${roleName}`);
    if (canonical && canonical!==pending.oldThreadId) throw new PluginCliError("The role already switched; repeat replace to finish recovery",{code:"replacement_switched"});
    const candidates=await core.listProjectThreads(bb,scope.projectId);
    for (const candidate of candidates) {
      const meta=await bb.sdk.threads.getPluginMetadata({threadId:candidate.id}) as Record<string,unknown>;
      if (candidate.id!==pending.newThreadId && !(meta.teamReplacement===true && meta.teamReplacementRole===roleName && meta.teamReplacementTeam===scope.team)) continue;
      if (!(await isPreparedReplacement(bb,await bb.sdk.threads.get({threadId:candidate.id}))) || candidate.environmentId!==pending.environmentId) throw new PluginCliError("A replacement candidate is active or changed environment; inspect it before aborting",{code:"replacement_candidate_invalid"});
      const descendants=await bb.sdk.threads.experimental_listDescendants({threadIds:[candidate.id]});
      for (const id of descendants.threads.find(x=>x.threadId===candidate.id)?.descendantIds ?? []) {
        const child=await bb.sdk.threads.get({threadId:id});
        if (child.parentThreadId===candidate.id) await bb.sdk.threads.update({threadId:id,parentThreadId:pending.oldThreadId});
      }
      await bb.sdk.threads.updatePluginMetadata({threadId:candidate.id,set:{teamRetired:true},remove:["teamRole","teamName","teamNotifyOn"]});
      await bb.sdk.threads.archive({threadId:candidate.id});
    }
    await bb.storage.kv.delete(`replacement:${scope.projectId}:${scope.team}:${roleName}`);
  };

  /* ── Snapshot (status, report, panel) ── */

  const readSessionRecovery = async (scope:Scope,role:string,t:Strings):Promise<SessionRecovery> => {
    const {config}=await readTeamConfig(bb,scope,scope.team,t);
    if(!config.roles.some(r=>r.name===role))throw new experimental_PluginRpcRefusal({code:"not_found",message:"Role not found"});
    const intent=await readReplacementIntent(bb,scope.projectId,scope.team,role);
    const canonical=await bb.storage.kv.get<string>(activeSessionKey(scope.projectId,scope.team,role));
    const view:SessionRecovery={revision:"",stage:intent?.stage??null,delivery:intent?.delivery??null,oldThreadId:intent?.oldThreadId??null,newThreadId:intent?.newThreadId??null,actions:[],candidates:[],reasonCode:null};
    if(intent?.stage==="invalid")view.reasonCode="replacement_invalid";
    else if(intent&&intent.stage!=="complete"){
      if(!canonical||canonical===intent.oldThreadId)view.actions.push("abort");
      if(intent.stage==="spawn_uncertain"){
        view.reasonCode="spawn_uncertain";
        for(const candidate of await core.listProjectThreads(bb,scope.projectId)){
          const meta=await bb.sdk.threads.getPluginMetadata({threadId:candidate.id}) as Record<string,unknown>;
          if(candidate.archivedAt===null&&candidate.environmentId===intent.environmentId&&meta.teamReplacement===true&&meta.teamReplacementRole===role&&meta.teamReplacementTeam===scope.team&&await isPreparedReplacement(bb,await bb.sdk.threads.get({threadId:candidate.id})))view.candidates.push(candidate.id);
        }
        if(view.candidates.length)view.actions.push("confirm");
      }else view.actions.push("continue");
    }else if(intent?.delivery==="uncertain"&&intent.newThreadId===canonical){
      view.reasonCode="delivery_uncertain";
      const thread=await bb.sdk.threads.get({threadId:canonical});
      if(await isPreparedReplacement(bb,thread))view.actions.push("release");
    }
    view.revision=createHash("sha256").update(JSON.stringify([intent,canonical,view.actions,view.candidates])).digest("hex");
    return view;
  };

  const buildSnapshot = async (scope: Scope, t: Strings): Promise<TeamSnapshot> => {
    const { loaded, configError, lead, scan, rows, helpers } = await teamContext(scope, t);
    // A missing tracker database is a state, not a crash: the panel still
    // renders (empty packages) and offers the tracker's prepare action.
    let trackerError: TeamSnapshot["trackerError"] = null;
    let store: TaskStore;
    try {
      store = await readTasks(scope);
    } catch (error) {
      if (!isTrackerAbsentError(error)) throw error;
      store = { nextId: 1, tasks: [] };
      trackerError = { code: "beads_absent", message: (error as Error).message };
    }
    const paused = (await readPause(scope)) !== null;
    const version = loaded ? await versionState(scope, loaded.legacy) : null;
    const toThreads = (list: TeamThreadRow[] | undefined): SnapshotThread[] =>
      (list ?? []).map((row) => ({
        threadId: row.threadId,
        status: row.status,
        provider: row.provider,
        title: row.title,
        updatedAtMs: row.updatedAtMs,
        parentThreadId: row.parentThreadId,
      }));
    const roles: SnapshotRole[] = [];
    const seen = new Set<string>();
    for (const role of loaded?.config.roles ?? []) {
      if (seen.has(role.name)) continue;
      seen.add(role.name);
      roles.push({
        name: role.name,
        title: role.title ?? role.name,
        lead: role.name === lead,
        inConfig: true,
        enabled: role.enabled !== false,
        provider: role.provider ?? null,
        model: role.model ?? null,
        threads: toThreads(rows.get(role.name)),
        helpers: toThreads(helpers.get(role.name)),
        tasks: listTasks(store, { role: role.name }),
      });
    }
    for (const name of [...rows.keys(), ...listTasks(store).map((task) => task.role)]) {
      if (seen.has(name)) continue;
      seen.add(name);
      const list = rows.get(name);
      roles.push({
        name,
        title: name,
        lead: name === lead,
        inConfig: false,
        enabled: true,
        provider: list?.[0]?.provider ?? null,
        model: null,
        threads: toThreads(list),
        helpers: toThreads(helpers.get(name)),
        tasks: listTasks(store, { role: name }),
      });
    }
    roles.sort((a, b) => Number(b.lead) - Number(a.lead));
    await resources.pinPackages(scope,store.tasks,roles.find(r=>r.lead)?.name??null);
    const resourceSummary=withResourceResults(await resources.inspect(scope),store.tasks);
    resourceSummary.quotaPolicy=await readQuotaPolicy(scope);
    if(roles.some(r=>isOllamaCloud(r.threads[0]?.provider??r.provider??"",r.threads[0]?.model??r.model))){resourceSummary.ollamaUsage=await cloudUsage(scope.hostId);resourceSummary.quotaPolicy=await readQuotaPolicy(scope);}
    const withExecutionState: SnapshotRole[] = [];
    for (const role of roles) {
      const intent = await readReplacementIntent(bb, scope.projectId, scope.team, role.name);
      const autoRaw = await bb.storage.kv.get<{taskId?: TaskId; stage?: AutoContinueStage; errorCode?: string | null; error?: string | null; reason?: string; updatedAtMs?: number}>(autoContinueKey(scope, role.name));
      let executionState = deriveExecutionState({
        role: role.name,
        tasks: role.tasks,
        replacement: intent ? {stage: intent.stage, delivery: intent.delivery, startedAtMs: intent.startedAt} : null,
        autoContinue: autoRaw?.stage && autoRaw.taskId !== undefined
          ? {taskId: autoRaw.taskId, stage: autoRaw.stage, errorCode: autoRaw.errorCode ?? null, error: typeof autoRaw.error === "string" ? autoRaw.error : null, reason: autoRaw.reason === "context" ? "context" : "accepted", updatedAtMs: typeof autoRaw.updatedAtMs === "number" ? autoRaw.updatedAtMs : 0}
          : null,
        threadStatus: role.threads[0]?.status ?? null,
        threadUpdatedAtMs: role.threads[0]?.updatedAtMs,
        paused: paused || await isRolePaused(scope, role.name),
      });
      const active=role.threads.some(thread=>thread.status==="active"||thread.status==="starting");
      const task=role.tasks.find(task=>task.status==="in-progress"||task.status==="review");
      const actualMeta=role.threads[0]?await bb.sdk.threads.getPluginMetadata({threadId:role.threads[0].threadId}) as {teamExecution?:ExecutionFallbackSelection}:{};
      const actualParsed=executionPolicySchema.shape.fallbacks.element.safeParse(actualMeta.teamExecution);
      const actual=actualParsed.success?actualParsed.data:undefined;
      const quotaOwner=isOllamaCloud(actual?.provider??role.provider??"",actual?.model??role.model)&&role.threads[0]?await resourceOwner(role.threads[0].threadId):null;
      const sharedHold=resourceSummary.blocked;
      const ownsSharedHold=!!sharedHold&&(role.tasks.some(t=>sharedHold.includes(`(task:${t.id}:`))||role.lead&&!sharedHold.includes("(task:"));
      if(role.threads.length===1){
        const usage=await routerUsage(role.threads[0]!.threadId);
        if(usage.service==="openrouter"||role.provider==="acp-qwen-code"){
          resourceSummary.openrouterUsage??={};resourceSummary.openrouterUsage[role.name]=usage;
        }
      }
      const routerData=resourceSummary.openrouterUsage?.[role.name];
      const routerWait=routerData?.service==="openrouter"?await bb.storage.kv.get<string>(routerWaitKey({...scope,role:role.name})):null;
      const routerLow=routerData?.service==="openrouter"&&openRouterHeadroom(routerData,actual?.model??role.model,resourceSummary.quotaPolicy?.pauseBelowPercent??10).held?"OpenRouter quota at/below the safety threshold; schedule later or choose an independent service":null;
      const quotaWait=await bb.storage.kv.get<string>(quotaWaitKey(scope,role.name));
      const resourceReason=routerWait??routerLow??(isOllamaCloud(role.threads[0]?.provider??role.provider??"",role.threads[0]?.model??role.model)?quotaWait:null)??resourceSummary.holds[task?`task:${task.id}`:`role:${role.name}`]??(task?resourceSummary.taskBlocks?.[`task:${task.id}`]:null)??(ownsSharedHold?sharedHold:null)??(quotaOwner?.hostId===scope.hostId&&quotaHeadroom(resourceSummary.ollamaUsage,resourceSummary.quotaPolicy).held?"Ollama Cloud account quota at/below the safety threshold; schedule continuation after reset or choose an independent model":null);
      if(!active&&resourceReason&&executionState?.kind!=="error"&&executionState?.kind!=="awaiting-acceptance")executionState={kind:"error",taskId:task?.id??null,errorCode:"resource_hold",errorMessage:resourceReason,safeAction:"Inspect Team resources and record a concrete decision; replacing the session cannot reset the budget",atMs:resourceSummary.blockedAtMs??resourceSummary.attempts.filter(a=>a.role===role.name).at(-1)?.endedAtMs??role.threads[0]?.updatedAtMs??0};
      if(!active&&sharedHold&&!ownsSharedHold&&!resourceReason&&executionState?.kind!=="error"&&executionState?.kind!=="awaiting-acceptance")executionState={kind:"awaiting-team-decision",taskId:task?.id??null,errorCode:null,safeAction:null,atMs:resourceSummary.blockedAtMs??0};
      const presented={...role,diagnostics:role.tasks.map(task=>executionDiagnostic(task,executionState)),threads:role.threads.map(thread=>({...thread,...(actual&&actual.provider===thread.provider?{model:actual.model}:{} )}))};
      withExecutionState.push(executionState ? {...presented, executionState} : presented);
    }
    return {
      projectId: scope.projectId,
      projectName: scope.projectName,
      team: scope.team,
      teamTitle: loaded?.config.title ?? null,
      resources:resourceSummary,
      teams: await allTeams(scope, scan),
      versioned: version ? version.versioned : null,
      versioningBlocked: version ? version.blocked : false,
      configSource: loaded?.source ?? null,
      configError,
      leadRole: lead,
      paused,
      roles: withExecutionState,
      executionEvents: executionJournal(bb).list(scope.projectId,scope.team).slice(0,100),
      generatedAtMs: Date.now(),
      tracker: (await tracker.getConfig(scope)).kind,
      trackerError,
      bindingIssues: loaded ? await inspectBindings(bb, scope.projectId, scope.team, loaded.config.roles.filter(r => r.enabled !== false).map(r => r.name)) : [],
    };
  };

  /* ── bb team doctor ── */

  const runDoctor = async (scope: Scope, lang: Language, t: Strings, m: Messages) => {
    const checks: DoctorCheck[] = [];
    const add = (check: string, level: DoctorLevel, detail: string) =>
      checks.push({ check, level, detail });
    const describe = (error: unknown) => {
      const hint = (error as PluginCliError).hint;
      return `${(error as Error).message}${hint ? ` (${hint})` : ""}`;
    };
    const { loaded, configError, rows } = await teamContext(scope, t);
    if (!loaded) {
      add(m.check.config, "fail", configError ?? m.check.configMissing);
    } else {
      const { config } = loaded;
      let lead: Role | null = null;
      let roles: Role[] = [];
      try {
        ({ lead, roles } = core.semanticChecks(config, t));
        add(m.check.config, "ok", loaded.source);
      } catch (error) {
        add(m.check.config, "fail", describe(error));
      }
      const version = await versionState(scope, loaded.legacy);
      add(
        m.check.gitignore,
        version.blocked ? "warn" : "ok",
        version.blocked ? m.versionBlocked : version.versioned ? m.versionedYes : m.versionedNo,
      );
      if (lead) {
        const spawned = roles.filter((role) => !role.threadId);
        try {
          await validateProviders(bb, spawned, t);
          add(
            m.check.providers,
            "ok",
            [...new Set(spawned.map((role) => role.provider ?? "default"))].join(", ") || m.doctorOk,
          );
        } catch (error) {
          add(m.check.providers, "fail", describe(error));
        }
        let envFailures = 0;
        for (const role of spawned) {
          try {
            await resolveEnvironment(bb, scope, roleEnvironmentSpec(role, config), t);
          } catch (error) {
            envFailures += 1;
            add(m.check.environments, "fail", `${role.name}: ${describe(error)}`);
          }
        }
        if (envFailures === 0) add(m.check.environments, "ok", m.doctorOk);
        let promptFailures = 0;
        let varWarnings = 0;
        for (const role of spawned) {
          try {
            const text = await loadRolePrompt(bb, scope, role, role.name === lead.name, lang, t);
            for (const name of unknownVars(text, config.vars)) {
              varWarnings += 1;
              add(m.check.vars, "warn", m.doctorUnknownVar(role.name, name));
            }
          } catch (error) {
            promptFailures += 1;
            add(m.check.prompts, "fail", describe(error));
          }
        }
        if (promptFailures === 0) add(m.check.prompts, "ok", m.doctorOk);
        if (varWarnings === 0 && config.vars) add(m.check.vars, "ok", Object.keys(config.vars).join(", "));
        for (const role of roles.filter((r) => r.threadId)) {
          const canonical=await bb.storage.kv.get<string>(`active-session:${scope.projectId}:${scope.team}:${role.name}`);
          if (canonical && rows.get(role.name)?.some(row=>row.threadId===canonical)) {
            add(m.check.adopted,"ok",`${role.name}: ${canonical} (current session overrides initial threadId)`);
            continue;
          }
          try {
            const thread = await bb.sdk.threads.get({ threadId: role.threadId! });
            if (thread.projectId !== scope.projectId) {
              add(m.check.adopted, "fail", t.threadWrongProject(role.name, role.threadId!));
            } else if (thread.archivedAt !== null) {
              add(m.check.adopted, "fail", t.threadArchived(role.name, role.threadId!).message);
            } else {
              add(m.check.adopted, "ok", `${role.name}: ${role.threadId}`);
            }
          } catch {
            add(m.check.adopted, "fail", t.threadNotFound(role.name, role.threadId!));
          }
        }
        const leadThread = rows.get(lead.name)?.[0]?.threadId ?? null;
        let threadWarnings = 0;
        const warnThread = (detail: string) => {
          threadWarnings += 1;
          add(m.check.threads, "warn", detail);
        };
        const bindingIssues = await inspectBindings(bb, scope.projectId, scope.team, roles.map(r => r.name));
        for (const role of roles) {
          const binding = bindingIssues.find(issue => issue.role === role.name);
          if (binding && binding.state !== "missing") {
            threadWarnings += 1;
            add("session binding", "fail", `${role.name}: ${binding.state}; ${lang === "ru" ? "Откройте Team → восстановление сессий. Не создавайте повторный тред." : "Open Team → session recovery. Do not create a duplicate thread."}`);
            continue;
          }
          const list = rows.get(role.name) ?? [];
          if (list.length === 0) {
            warnThread(m.doctorMissingThread(role.name));
            continue;
          }
          if (list.length > 1) {
            warnThread(m.doctorDuplicate(role.name, list.map((row) => row.threadId).join(", ")));
          }
          for (const row of list) {
            if (row.status === "error") warnThread(m.doctorThreadError(role.name, row.threadId));
            if (role.name !== lead.name && leadThread && row.parentThreadId !== leadThread) {
              warnThread(m.doctorWrongParent(role.name, row.threadId));
            }
          }
        }
        const configured = new Set(roles.map((role) => role.name));
        for (const [role, list] of rows) {
          if (configured.has(role)) continue;
          for (const row of list) warnThread(m.doctorOrphan(role, row.threadId));
        }
        if (threadWarnings === 0) add(m.check.threads, "ok", m.doctorOk);
      }
    }
    for (const key of await bb.storage.kv.list(`review-feedback:${scope.projectId}:${scope.team}:`)) {
      const delivery = await bb.storage.kv.get<{taskId:TaskId,threadId:string,delivery:string}>(key);
      if (delivery && delivery.delivery !== "sent") add("review feedback", "fail", `#${delivery.taskId}: remark delivery is uncertain; inspect ${delivery.threadId} before resending`);
    }
    for (const key of await bb.storage.kv.list(`replacement:${scope.projectId}:${scope.team}:`)) {
      const pending=await bb.storage.kv.get<{stage?:string;oldThreadId?:string;newThreadId?:string;delivery?:string}>(key);
      if (pending && (pending.stage!=="complete" || pending.delivery==="uncertain")) add("session replacement","fail",`${key.split(":").at(-1)}: ${JSON.stringify(pending)}; inspect replace --dry-run --json; retry after a partial switch, or --abort before switching`);
    }
    for (const role of await autoContinueRoles(scope)) {
      const record = await readAutoContinue(scope, role);
      if (record?.stage === "failed") add("auto-continue","fail",`${role}: package #${record.taskId} [${record.errorCode}] ${record.error ?? ""}; the completed session is kept; inspect, then bb team replace ${role} --dry-run`);
    }
    const doctorConfig=await readTeamConfig(bb,scope,scope.team,t).catch(()=>null);
    if(doctorConfig?.config.roles.some(r=>isOllamaCloud(r.provider??"",r.model))){
      const usage=await cloudUsage(scope.hostId);
      if(exhaustedOllama(usage))add("Ollama Cloud","fail",currentLang==="ru"?"Квота аккаунта исчерпана; проверьте сброс или утверждённую резервную модель":"Account quota exhausted; inspect reset or approved backups");
      else if(usage.status!=="ready")add("Ollama Cloud","warn",currentLang==="ru"?"Остаток квоты неизвестен":"Quota remaining is unknown");
    }
    const budget=await resources.inspect(scope);
    if(budget.blocked)add(currentLang==="ru"?"ресурсы":"resources","fail",budget.blocked);
    for(const [key,reason]of Object.entries(budget.taskBlocks??{}))add("resources","fail",`${key}: ${reason}`);
    for(const [key,reason]of Object.entries(budget.holds))add("resources","warn",`${key}: ${reason}`);
    for(const quota of budget.quotaBlocks)add("provider quota","warn",`${quota.provider}: capacity needs fresh confirmation; reset ${quota.resetAtMs===null?"unknown":new Date(quota.resetAtMs).toISOString()}`);
    for(const key of await bb.storage.kv.list(`role-paused:${scope.projectId}:${scope.team}:`))if(await bb.storage.kv.get(key)===true)add("pause","warn",key.split(":").at(-1)!);
    if ((await readPause(scope)) !== null) add(m.check.threads, "warn", m.doctorPaused);
    return checks;
  };

  const inspectRoleRecovery=async(scope:Scope,roleName:string,selection?:ExecutionFallbackSelection):Promise<RecoveryView>=>{
    const {t}=await loadLang();
    const view:RecoveryView={threadId:null,taskId:null,taskTitle:null,environmentId:null,actual:null,revision:"",blockers:[],quota:"unknown"};
    let checkpoint:unknown=null;let queueIds:string[]=[];let configRevision="";let workspaceFingerprint="";
    const add=(reason:RecoveryBlocker)=>{if(!view.blockers.includes(reason))view.blockers.push(reason);};
    try {
      const {rows,loaded}=await teamContext(scope,t);const list=rows.get(roleName)??[];
      configRevision=createHash("sha256").update(JSON.stringify(loaded?.config??null)).digest("hex");
      if(list.length!==1)add("no_session");
      else {
        view.threadId=list[0]!.threadId;
        const thread=await bb.sdk.threads.get({threadId:view.threadId});view.environmentId=thread.environmentId;
        if(RUNNING.includes(thread.status)||!["idle","error"].includes(thread.status))add("busy");
        const descendants=await bb.sdk.threads.experimental_listDescendants({threadIds:[view.threadId]});
        const childIds=descendants.threads.find(r=>r.threadId===view.threadId)?.descendantIds??[];
        for(const id of childIds){if((await bb.sdk.threads.get({threadId:id})).lifecycleOwnerThreadId===view.threadId)add("lifecycle_owner");}
        const meta=await bb.sdk.threads.getPluginMetadata({threadId:view.threadId}) as {teamExecution?:unknown};
        const configured=loaded?.config.roles.find(r=>r.name===roleName);
        const actual=executionPolicySchema.shape.fallbacks.element.safeParse(meta.teamExecution??{provider:configured?.provider,model:configured?.model,...(configured?.reasoningLevel?{reasoningLevel:configured.reasoningLevel}:{}),...(configured?.serviceTier?{serviceTier:configured.serviceTier}:{})});
        view.actual=actual.success?actual.data:null;
        const queue=await bb.sdk.threads.queuedMessages.list({threadId:view.threadId});queueIds=queue.map(q=>q.id);
        if(queue.length||thread.queuedMessageCount>0)add("queue");
        const row=(await bb.sdk.threads.list({projectId:scope.projectId})).find(r=>r.id===view.threadId);
        if(row?.hasPendingInteraction)add("interaction");
        const a=row?.activity as Record<string,number>|undefined;
        if(thread.activeBackgroundAgentCount>0||a&&[a.activeBackgroundAgentCount,a.activeBackgroundCommandCount,a.activeGoalCount,a.activePlanModeCount,a.activeWorkflowCount].some(n=>typeof n==="number"&&n>0))add("background");
        view.taskId=await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,view.threadId))??null;
        const task=view.taskId!==null?(await readTasks(scope)).tasks.find(task=>task.id===view.taskId):undefined;
        if(!task)add("no_task");
        else {
          view.taskTitle=task.title;if(task.role!==roleName)add("task_reassigned");
          if(!["in-progress","review"].includes(task.status))add("task_finished");
          const ref=await bb.storage.kv.get<{taskId:TaskId}>(checkpointRefKey(scope,roleName));
          if(!ref||ref.taskId!==task.id)add("checkpoint_missing");
          else {
            checkpoint=await tracker.readCheckpoint(scope,ref.taskId);
            const cp=workCheckpointSchema.safeParse(checkpoint);
            if(!cp.success)add("checkpoint_missing");
            else if(cp.data.threadId!==view.threadId||cp.data.role!==roleName||cp.data.taskId!==task.id)add("checkpoint_stale");
            else try{await verifyCheckpoint(bb,cp.data);}catch(error){add((error as {code?:string}).code==="checkpoint_stale"?"checkpoint_stale":"checkpoint_unavailable");}
          }
        }
        if(view.blockers.includes("checkpoint_missing")||view.blockers.includes("checkpoint_stale")){
          try{workspaceFingerprint=(await environmentState(bb,view.threadId)).state.fingerprint;}catch{add("checkpoint_unavailable");}
        }
        const intent=await readReplacementIntent(bb,scope.projectId,scope.team,roleName);
        if(intent&&(intent.stage!=="complete"||intent.delivery==="uncertain"))add("replacement_pending");
        if(selection&&view.environmentId){
          const selectionOwner=await resourceOwner(view.threadId);
          if(selectionOwner&&await resources.quotaExcluded(selectionOwner,selection))add("quota_exhausted");
          const catalog=await bb.sdk.providers.models({environmentId:view.environmentId,providerId:selection.provider});
          const model=catalog.models.find(m=>m.id===selection.model||m.model===selection.model);
          if(catalog.modelLoadError||!catalog.providers.some(p=>p.id===selection.provider&&p.available)||!model||selection.reasoningLevel&&!model.supportedReasoningEfforts.some(r=>r.reasoningEffort===selection.reasoningLevel)||selection.serviceTier&&!model.supportedServiceTiers?.some(tier=>tier.id===selection.serviceTier))add("model_unavailable");
          const router=await routerUsage(view.threadId,selection);
          if(router.service==="openrouter"){
            const quota=openRouterHeadroom(router,selection.model,(await readQuotaPolicy(scope)).pauseBelowPercent);
            view.quota=quota.unknown?"unknown":quota.held?"exhausted":"available";
            if(view.quota!=="available")add(view.quota==="exhausted"?"quota_exhausted":"quota_unknown");
          }
          if(isOllamaCloud(selection.provider,selection.model)){
            const owner=await resourceOwner(view.threadId);const usage=owner?.hostId?await cloudUsage(owner.hostId):undefined;
            view.quota=usage?.status==="ready"?quotaHeadroom(usage,await readQuotaPolicy(scope)).held?"exhausted":"available":"unknown";
            if(view.quota!=="available")add(view.quota==="exhausted"?"quota_exhausted":"quota_unknown");
          }
        }
      }
      if(await readPause(scope))add("team_paused");
      if(packageResourceBlock(await resources.inspect(scope),view.taskId))add("resource_limit");
    }catch{add("state_unavailable");}
    // No timestamps or token estimates: only state relevant to this task/choice.
    view.revision=createHash("sha256").update(JSON.stringify([view.threadId,view.taskId,view.taskTitle,view.environmentId,view.actual,view.blockers,checkpoint,queueIds,selection,configRevision,workspaceFingerprint])).digest("hex");
    return view;
  };

  /* ── Lifecycle: helpers, live panel, opt-in lead notifications ── */

  const onTeamThreadEvent = async (
    thread: { id: string; projectId: string; parentThreadId: string | null },
    kind: NotifyEvent | "other",
    detail: string | null,
  ): Promise<void> => {
    let meta: Record<string, unknown>;
    try {
      meta = (await bb.sdk.threads.getPluginMetadata({ threadId: thread.id })) as Record<string, unknown>;
    } catch {
      return;
    }
    const mark = readTeamMark(meta);
    if (!mark) return;
    if (kind === "idle" && !mark.helper) {
      const {t} = await loadLang();
      const scope = await scopeFor(thread.projectId, mark.team, t);
      await withScopeLock(scope, async () => {
        // Idle is a trigger for the durable auto-continue request, never its
        // source: records are armed by package acceptance or a rotation
        // request. Without a record, one cheap context measurement can arm
        // a context rotation (never calls the model).
        if (await readAutoContinue(scope, mark.role)) {
          await runAutoContinue(scope, mark.role, t);
          return;
        }
        if (await maybeArmContextRotation(scope, mark.role, meta, thread.id, t)) {
          await runAutoContinue(scope, mark.role, t);
          return;
        }
        const intent = await readReplacementIntent(bb, scope.projectId, scope.team, mark.role);
        if (!intent || intent.stage === "complete") await dispatchNextPackage(scope, mark.role, t);
      });
    }
    publishChange(thread.projectId);
    if (kind === "other" || mark.helper) return;
    const notifyOn = Array.isArray(meta.teamNotifyOn) ? meta.teamNotifyOn : [];
    if (kind === "idle" && !notifyOn.includes(kind)) return;
    const {t}=await loadLang();
    const scope=await scopeFor(thread.projectId,mark.team,t);
    const {rows,lead}=await teamContext(scope,t);
    const target=lead && lead!==mark.role ? rows.get(lead)?.[0] : null;
    if (!target) return;
    const m = messages(currentLang);
    const text =
      kind === "idle"
        ? m.notifyIdle(mark.role, thread.id, excerpt(detail))
        : m.notifyError(mark.role, thread.id, excerpt(detail, 300));
    await bb.sdk.threads.send({
      originPluginId: bb.pluginId,
      threadId: target.threadId,
      mode: kind === "error" ? "auto" : "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  };

  /** A thread spawned under a team thread becomes a helper of that role. */
  const onThreadCreated = async (thread: { id: string; projectId: string; parentThreadId: string | null }) => {
    if (!thread.parentThreadId) return;
    let parentMeta: Record<string, unknown>;
    try {
      parentMeta = (await bb.sdk.threads.getPluginMetadata({ threadId: thread.parentThreadId })) as Record<
        string,
        unknown
      >;
    } catch {
      return;
    }
    const mark = readTeamMark(parentMeta);
    if (!mark) return;
    const own = readTeamMark(
      (await bb.sdk.threads.getPluginMetadata({ threadId: thread.id })) as Record<string, unknown>,
    );
    if (own) return; // spawned by bb team itself
    const ownMeta = await bb.sdk.threads.getPluginMetadata({threadId:thread.id}) as Record<string,unknown>;
    if (ownMeta.teamReplacement === true) return;
    await bb.sdk.threads.updatePluginMetadata({
      threadId: thread.id,
      set: { teamName: mark.team, teamHelperOf: mark.role },
    });
    if (pausedThreads.has(thread.parentThreadId)) {
      const scope = { projectId: thread.projectId, team: mark.team } as Scope;
      const state = await readPause(scope);
      if (state) {
        await bb.storage.kv.set(pauseKey(scope), { ...state, threadIds: [...state.threadIds, thread.id] });
        pausedThreads.add(thread.id);
      }
    }
    publishChange(thread.projectId);
  };

  /**
   * Background command/goal/workflow completion does not always fire a new
   * thread.idle. The debounced experimental_thread.events is an additional
   * cheap trigger to re-check the safe boundary of an EXISTING durable
   * request: no context metrics, no LLM, and nothing at all without a
   * request. Helpers, retired and non-team threads never rotate.
   */
  const onThreadActivityEvent = async (thread: { id: string; projectId: string; status: string }): Promise<void> => {
    if (RUNNING.includes(thread.status)) return; // only idle candidates
    let meta: Record<string, unknown>;
    try {
      meta = (await bb.sdk.threads.getPluginMetadata({ threadId: thread.id })) as Record<string, unknown>;
    } catch {
      return;
    }
    const mark = readTeamMark(meta);
    if (!mark || mark.helper || meta.teamRetired === true || meta.teamReplacement === true) return;
    const { t } = await loadLang();
    const scope = await scopeFor(thread.projectId, mark.team, t);
    if (!(await readAutoContinue(scope, mark.role))) return; // no request: never wake anything
    await withScopeLock(scope, async () => {
      if (await readAutoContinue(scope, mark.role)) await runAutoContinue(scope, mark.role, t);
    });
  };

  bb.events.on("turn.failed",async failure=>{
    const owner=await resourceOwner(failure.threadId);if(!owner)return;
    const {t}=await loadLang();const scope=await scopeFor(owner.projectId,owner.team,t);
    const {config}=await readTeamConfig(bb,scope,scope.team,t);
    const role=config.roles.find(r=>r.name===owner.role);
    // Helpers count against their task but never replace the owner's session.
    const configuredCandidates=owner.ownerThreadId===failure.threadId?role?.executionPolicy?.fallbacks??[]:[];
    const failureMeta=await bb.sdk.threads.getPluginMetadata({threadId:failure.threadId}) as {teamExecution?:ExecutionFallbackSelection};
    const failedModel=failureMeta.teamExecution?.model??role?.model;
    const candidates:ExecutionFallbackSelection[]=[];
    if(confirmedQuota(failure)&&configuredCandidates.length){
      const old=await bb.sdk.threads.get({threadId:failure.threadId});
      const catalogs=new Map<string,Awaited<ReturnType<typeof bb.sdk.providers.models>>|null>();
      if(old.environmentId)for(const candidate of configuredCandidates){
        const fromRouter=await routerUsage(failure.threadId,{provider:old.providerId,model:failedModel??""});
        const toRouter=await routerUsage(failure.threadId,candidate);
        if(fromRouter.service==="openrouter"&&(toRouter.service==="openrouter"||toRouter.service==="unknown"&&!isOllamaCloud(candidate.provider,candidate.model)&&!["codex","claude-code"].includes(candidate.provider)))continue; // different keys do not prove different accounts
        if(!independentQuotaSelection(old.providerId,failedModel,candidate))continue; // Same upstream account cannot restore quota.
        if(!catalogs.has(candidate.provider)){
          try{catalogs.set(candidate.provider,await bb.sdk.providers.models({environmentId:old.environmentId,providerId:candidate.provider}));}catch{catalogs.set(candidate.provider,null);}
        }
        const catalog=catalogs.get(candidate.provider);const model=catalog?.models.find(m=>m.model===candidate.model||m.id===candidate.model);
        if(!catalog||catalog.modelLoadError||!catalog.providers.some(p=>p.id===candidate.provider&&p.available)||!model)continue;
        if(candidate.reasoningLevel&&!model.supportedReasoningEfforts.some(r=>r.reasoningEffort===candidate.reasoningLevel))continue;
        if(candidate.serviceTier&&!model.supportedServiceTiers?.some(t=>t.id===candidate.serviceTier))continue;
        candidates.push(candidate);
      }
    }
    const plan=await resources.failed(failure,candidates,failedModel);if(!plan)return;
    if(plan.stage!=="selected"||!plan.selection){await notifyResource(scope,owner.role,plan.reason);return;}
    await withScopeLock(scope,async()=>{
      try{
        const store=await readTasks(scope);const task=store.tasks.find(t=>t.id===plan.taskId);
        if(!task||task.role!==owner.role||!["todo","in-progress"].includes(task.status))throw new PluginCliError("Quota handoff needs the same unfinished assigned task",{code:"task_reassigned"});
        const unfinished=await readReplacementIntent(bb,scope.projectId,scope.team,owner.role);
        if(unfinished&&unfinished.stage!=="complete")throw new PluginCliError("Existing replacement is unfinished; inspect/resume it manually",{code:"replacement_pending"});
        const chosen=plan.selection!;
        const ref=await bb.storage.kv.get<{taskId:TaskId}>(checkpointRefKey(scope,owner.role));
        if(!ref)throw new PluginCliError("A saved task checkpoint is required for automatic quota handoff",{code:"checkpoint_missing"});
        const parsed=workCheckpointSchema.safeParse(await tracker.readCheckpoint(scope,ref.taskId));
        if(!parsed.success)throw new PluginCliError("The saved checkpoint is invalid",{code:"checkpoint_invalid"});
        if(parsed.data.threadId!==failure.threadId||parsed.data.taskId!==plan.taskId)throw new PluginCliError("Checkpoint belongs to another task/session",{code:"checkpoint_stale"});
        await verifyQuotaBoundary(bb,failure,parsed.data);
        // No call to the exhausted model: the existing handler verifies its
        // saved checkpoint and Git fingerprint, or refuses without spawning.
        await resources.authorizeFallback(scope,failure.requestId);
        const result=await continueRoleSession(scope,owner.role,failure.threadId,{execution:chosen});
        await resources.fallbackStage(scope,failure.requestId,"complete",undefined,result.result.newThreadId);
      }catch(error){
        const reason=`${(error as PluginCliError).code??"fallback_failed"}: ${(error as Error).message}`;
        await resources.fallbackStage(scope,failure.requestId,"error",reason);await notifyResource(scope,owner.role,reason);
      }
    });
  });
  bb.events.on("message.cancelled",({entry})=>resources.cancelled(entry.threadId,entry.id));
  bb.events.on("thread.active",({thread})=>resources.watch(thread.id));
  bb.events.on("message.queued",async({entry})=>{
    await resources.queued(entry.threadId,entry.id,entry.payload?.kind==="retry");
    if(entry.waitingOn?.kind==="plugin"&&entry.waitingOn.pluginId===bb.pluginId&&(entry.waitingOn.reason.startsWith("Team resources:")||entry.waitingOn.reason.startsWith("Ollama Cloud"))){
      const owner=await resourceOwner(entry.threadId);if(owner){const {t}=await loadLang();const scope=await scopeFor(owner.projectId,owner.team,t);await notifyResource(scope,owner.role,entry.waitingOn.reason);}
    }
  });
  bb.events.on("thread.idle",({thread})=>resources.settle(thread.id,"completed"));
  bb.events.on("thread.failed",({thread})=>resources.settle(thread.id,"failed"));
  bb.events.on("experimental_thread.events",async({thread})=>{
    const owner=await resourceOwner(thread.id);if(owner)await resources.inspect(owner);
  });
  bb.events.on("thread.created", ({ thread }) => onThreadCreated(thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    onTeamThreadEvent(thread, "idle", lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) => onTeamThreadEvent(thread, "error", error));
  bb.events.on("thread.active", ({ thread }) => onTeamThreadEvent(thread, "other", null));
  bb.events.on("thread.archived", ({ thread }) => onTeamThreadEvent(thread, "other", null));
  bb.events.on("experimental_thread.events", ({ thread }) => onThreadActivityEvent(thread));

  /* ── RPC ── */

  const kindsList = (lang: Language) =>
    ROLE_KINDS.map((kind) => ({ kind, title: kindTitle(lang, kind) }));

  bb.rpc.register(rpcContract, {
    async trackerConfig({projectId}) {
      const {t} = await loadLang();
      return tracker.getConfig(await resolveWorkspace(bb, projectId, undefined, t, {}));
    },
    async trackerSet({projectId, kind}) {
      const {t} = await loadLang();
      await setProjectTracker(await resolveWorkspace(bb, projectId, undefined, t, {}), kind);
      return {ok: true};
    },
    async trackerPrepare({projectId, team}) {
      const {t} = await loadLang();
      const result = await tracker.prepare({...await resolveWorkspace(bb, projectId, undefined, t, {}), team});
      publishChange(projectId);
      return result;
    },
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return { projects: projects.map((p) => ({ id: p.id, name: p.name })) };
    },
    async teams({ projectId }) {
      const { lang, t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      return { teams: await allTeams(workspace), language: lang };
    },
    async snapshot({ projectId, team }) {
      const { lang, t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      const teams = await allTeams(workspace);
      const chosen = team ?? teams[0] ?? DEFAULT_TEAM;
      return { snapshot: await buildSnapshot({ ...workspace, team: chosen }, t), language: lang };
    },
    async overview() {
      const { lang, m } = await loadLang();
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      let hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>> = [];
      try {
        hosts = await bb.sdk.hosts.list();
      } catch {
        // host states unknown — do not block projects on them
      }
      const hostById = new Map(hosts.map((host) => [host.id, host]));
      const rows = await Promise.all(
        projects.map(async (project) => {
          const base = { id: project.id, name: project.name, teams: [] as string[], threads: 0, running: 0, errors: 0 };
          const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
          if (!source) return { ...base, path: null, state: "blocked" as const, reason: m.overviewNoSource };
          const path = source.path.replace(/\/+$/, "");
          const host = hostById.get(source.hostId);
          if (host && host.status !== "connected") {
            return { ...base, path, state: "blocked" as const, reason: m.overviewHostOffline(host.name) };
          }
          const workspace: Workspace = { projectId: project.id, projectName: project.name, path, hostId: source.hostId };
          try {
            await bb.sdk.files.list({ hostId: source.hostId, path, limit: 1 });
          } catch (error) {
            return { ...base, path, state: "blocked" as const, reason: m.overviewUnreadable((error as Error).message.slice(0, 160)) };
          }
          const scan = await scanTeamThreads(bb, project.id).catch(() => ({ rows: [], free: [] }) as ThreadScan);
          const teams = await allTeams(workspace, scan).catch(() => [] as string[]);
          const teamRows = scan.rows.filter((row) => !row.helper);
          return {
            ...base,
            path,
            teams,
            threads: teamRows.length,
            running: teamRows.filter((row) => RUNNING.includes(row.status)).length,
            errors: teamRows.filter((row) => row.status === "error").length,
            state: teams.length > 0 ? ("teams" as const) : ("ready" as const),
            reason: null,
          };
        }),
      );
      return { projects: rows, language: lang };
    },
    async tree({ projectId }) {
      const { lang, t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      const snapshots: TeamSnapshot[] = [];
      for (const team of await allTeams(workspace)) {
        snapshots.push(await buildSnapshot({ ...workspace, team }, t));
      }
      return { projectName: workspace.projectName, snapshots, language: lang };
    },
    async teamSpawn({ projectId, team }) {
      const { lang, t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      return { spawned: (await spawnTeam(scope, lang, t, m)).spawned.length };
    },
    async bindingRepair({projectId, team, role, currentThreadId, candidateThreadId}) {
      const {t} = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      return withScopeLock(scope, async () => {
        const {config} = await readTeamConfig(bb, scope, scope.team, t);
        if (!config.roles.some(r => r.name === role && r.enabled !== false)) throw new experimental_PluginRpcRefusal({code:"not_found", message:"Role not found"});
        try { await repairBinding(bb, projectId, team, {role, currentThreadId, candidates:[candidateThreadId], state:"repairable"}); }
        catch(error) { throw new experimental_PluginRpcRefusal({code:"conflict", message:(error as Error).message}); }
        publishChange(projectId);
        return {repaired:true};
      });
    },
    async sessionView({ projectId, team, role }) {
      const { t } = await loadLang();
      return readSessionView(await scopeFor(projectId, team, t), role, t);
    },
    async executionHistory({projectId,team,role}) {
      const {t}=await loadLang();
      await scopeFor(projectId,team,t);
      return {events:executionJournal(bb).list(projectId,team,role),retentionDays:JOURNAL_RETENTION_DAYS,maxEvents:JOURNAL_MAX_EVENTS};
    },
    async sessionRecovery({projectId,team,role,action,expectedRevision,confirmed,candidateThreadId}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      return withScopeLock(scope,async()=>{
        const view=await readSessionRecovery(scope,role,t);
        if(!action)return view;
        if(!confirmed||view.revision!==expectedRevision||!view.actions.includes(action))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Recovery state changed or confirmation is missing; inspect again"});
        const intent=await readReplacementIntent(bb,projectId,team,role);
        if(!intent)throw new experimental_PluginRpcRefusal({code:"conflict",message:"No replacement to recover"});
        if(action==="abort")await abortRoleReplacement(scope,role,intent);
        else if(action==="release"){
          // Recheck the original core queue. Never create/send another input.
          await bb.experimental_hooks.recheck("message.dispatch");
          await bb.storage.kv.set(`replacement:${projectId}:${team}:${role}`,{...intent,delivery:"sent"});
          executionJournal(bb).record({projectId,team,role,taskId:null,threadId:intent.newThreadId,operationId:`replace:${intent.oldThreadId}:${intent.startedAt}`,eventType:"handoff",nextState:"complete:sent",reasonCode:"handoff_complete",provider:null,model:null});
        }else{
          const owner=await resourceOwner(intent.oldThreadId);
          if(await readPause(scope)||packageResourceBlock(await resources.inspect(scope),owner?.taskId))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Team is paused or package resource limited"});
          if(action==="confirm"){
            if(!candidateThreadId||!view.candidates.includes(candidateThreadId))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Inspect and select an existing prepared candidate"});
            intent.newThreadId=candidateThreadId;intent.stage="spawning";
            await bb.storage.kv.set(`replacement:${projectId}:${team}:${role}`,intent);
          }
          await continueRoleSession(scope,role,intent.oldThreadId,{pending:intent});
        }
        publishChange(projectId);
        return readSessionRecovery(scope,role,t);
      }).catch(error=>{
        if(error instanceof experimental_PluginRpcRefusal)throw error;
        const known=new Set(["checkpoint_stale","checkpoint_missing","spawn_uncertain","release_failed","delivery_uncertain","replacement_invalid","old_not_idle_or_error","old_active_before_archive","replacement_switched","replacement_candidate_invalid"]);
        const code=known.has((error as {code?:string}).code??"")?(error as {code:string}).code:"recovery_failed";
        throw new experimental_PluginRpcRefusal({code:"conflict",message:`Recovery stopped (${code}). Refresh and inspect the preserved session and queue before continuing.`});
      });
    },
    async sessionRotate({ projectId, team, role, expectedThreadId }) {
      const { t, lang } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      return withScopeLock(scope, async () => {
        const view = await readSessionView(scope, role, t);
        if (view.threadId !== expectedThreadId) throw new experimental_PluginRpcRefusal({ code: "conflict", message: lang === "ru" ? "Сессия уже изменилась. Обновите карточку сотрудника." : "The session changed. Refresh the employee card." });
        // Repeated clicks observe the same durable request; never resend or respawn.
        if (view.reason && view.phase !== "error" && view.blockedReason !== "replacement_pending") return view;
        if (view.blockedReason || view.taskId == null) throw new experimental_PluginRpcRefusal({ code: "conflict", message: lang === "ru" ? "Передача недоступна. Обновите карточку и проверьте причину ожидания." : "Handoff is unavailable. Refresh the card and inspect the reason." });
        await armContextRotation(scope, role, view.taskId, expectedThreadId, t);
        publishChange(projectId);
        return readSessionView(scope, role, t);
      });
    },
    async stop({ projectId, team, role }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const { rows, helpers } = await teamContext(scope, t);
      let stopped = 0;
      for (const row of [...(rows.get(role) ?? []), ...(helpers.get(role) ?? [])]) {
        if (!RUNNING.includes(row.status)) continue;
        await bb.sdk.threads.stop({ threadId: row.threadId });
        stopped += 1;
      }
      if (stopped > 0) publishChange(projectId);
      return { stopped };
    },
    async providers() {
      return providerState(bb);
    },
    async freeThreads({ projectId }) {
      const scan = await scanTeamThreads(bb, projectId);
      return {
        threads: scan.free.slice(0, 200).map((thread) => ({
          id: thread.id,
          title: thread.title ?? thread.titleFallback ?? thread.id,
          status: thread.status,
          provider: thread.providerId,
        })),
      };
    },
    async templates() {
      const { lang } = await loadLang();
      const settingsValues = await settings.get();
      return { templates: await allTemplates(lang), kinds: kindsList(lang), language: lang, defaultTemplate: settingsValues.defaultTemplate };
    },
    async editorSettings() {
      const { lang } = await loadLang();
      const settingsValues = await settings.get();
      const templates = await allTemplates(lang);
      return {
        language: lang,
        defaultTemplate: settingsValues.defaultTemplate,
        defaultTemplateExists: templates.some((tpl) => tpl.id === settingsValues.defaultTemplate),
        generatorSelection: await readGeneratorSelection(),
        reloadHint: settingsMessages(lang).reloadHint,
      };
    },
    async editorSettingsSet(input) {
      const { lang } = await loadLang();
      const sm = settingsMessages(lang);
      if (input.defaultTemplate !== undefined) {
        const templates = await allTemplates(lang);
        if (!templates.some((tpl) => tpl.id === input.defaultTemplate)) {
          const err = sm.defaultTemplateMissing(input.defaultTemplate);
          // Structured RPC refusal; codes are limited to
          // forbidden/not_found/conflict/invalid. Nothing is written.
          throw new experimental_PluginRpcRefusal({
            code: "not_found",
            message: `${err.message}. ${err.hint}`,
          });
        }
      }
      if (input.generatorSelection !== undefined) {
        await writeGeneratorSelection(input.generatorSelection);
      }
      if (input.language !== undefined || input.defaultTemplate !== undefined) {
        try {
          await settings.experimental_set({
            ...(input.language !== undefined ? { language: input.language } : {}),
            ...(input.defaultTemplate !== undefined ? { defaultTemplate: input.defaultTemplate } : {}),
          });
        } catch (error) {
          throw new experimental_PluginRpcRefusal({
            code: "invalid",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const { lang: nextLang } = await loadLang();
      const settingsValues = await settings.get();
      const templates = await allTemplates(nextLang);
      return {
        language: nextLang,
        defaultTemplate: settingsValues.defaultTemplate,
        defaultTemplateExists: templates.some((tpl) => tpl.id === settingsValues.defaultTemplate),
        generatorSelection: await readGeneratorSelection(),
        reloadHint: settingsMessages(nextLang).reloadHint,
      };
    },
    async templateSave({ template }) {
      const { m } = await loadLang();
      await saveUserTemplate(template, m);
      return { ok: true };
    },
    async templateDelete({ id }) {
      const { lang, m } = await loadLang();
      try {
        await deleteUserTemplate(id, m);
      } catch (error) {
        // A structured refusal for the UI: deleting the current default is
        // a conflict the user must resolve by choosing another default.
        if ((error as PluginCliError).code === "template_is_default") {
          const err = settingsMessages(lang).templateIsDefault(id);
          throw new experimental_PluginRpcRefusal({
            code: "conflict",
            message: `${err.message}. ${err.hint}`,
          });
        }
        throw error;
      }
      return { ok: true };
    },
    async templateNew({ id, title, kinds }) {
      const { lang, m } = await loadLang();
      const template = newTemplateFromKinds(lang, id, title, kinds);
      await saveUserTemplate(template, m);
      return { template };
    },
    async templateFromTeam({ projectId, team, id, title }) {
      const { lang, t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const loaded = await readTeamConfig(bb, scope, team, t);
      const { template } = await templateFromConfig(scope, loaded, lang, t, id, title);
      await saveUserTemplate(template, m);
      return { template };
    },
    async teamCreate({ projectId, team, title, roles, versioned }) {
      const { lang, t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const { result } = await createTeamFromTemplate(
        scope,
        { title, roles },
        { versioned, force: false, spawn: true },
        lang,
        t,
        m,
      );
      return {
        team,
        spawned: result?.spawned.length ?? 0,
        leadThreadId: result?.leadThreadId ?? null,
      };
    },
    async roleAdd({ projectId, team, role, threadId }) {
      const { lang, t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const result = await addRole(scope, { ...role, threadId }, lang, t, m, true);
      return { role: result.role, threadId: result.threadId };
    },
    async rolePolicy({projectId,team,role:roleName,primary,policy,quotaSource,expectedRevision,futureOnly,expectedThreadId}) {
      const {t}=await loadLang(); const scope=await scopeFor(projectId,team,t);
      return withScopeLock(scope,async()=>{
        const loaded=await readTeamConfig(bb,scope,team,t);
        const raw=await readFileOrNull(bb,scope,loaded.source);
        if(raw===null) throw new PluginCliError("Team config is unavailable",{code:"not_found"});
        const revision=createHash("sha256").update(raw).digest("hex");
        const role=loaded.config.roles.find(r=>r.name===roleName);
        if(!role) throw new PluginCliError("Role is not in the team config",{code:"not_found"});
        if(policy===undefined && primary===undefined && quotaSource===undefined) return {role,source:loaded.source,revision};
        if(expectedRevision!==revision) throw new PluginCliError("Team config changed; reopen the profile before saving",{code:"conflict"});
        if(futureOnly){
          const {rows}=await teamContext(scope,t);const current=rows.get(roleName)??[];
          if(current.length!==1||current[0]!.threadId!==expectedThreadId||busyTasks(await readTasks(scope),roleName).length)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Work started or session changed; reopen the recovery flow"});
        }
        const parsed=(loaded.source.endsWith(".json")?JSON.parse(raw):loadYaml(raw)) as {roles:Array<Record<string,unknown>>};
        const entry=parsed.roles.find(r=>r.name===roleName)!;
        if(primary!==undefined) for(const key of ["provider","model","reasoningLevel","serviceTier"] as const) {
          delete entry[key]; if(primary[key]!==undefined) entry[key]=primary[key];
        }
        if(policy===null) delete entry.executionPolicy; else if(policy!==undefined) entry.executionPolicy=policy;
        if(quotaSource===null)delete entry.quotaSource;else if(quotaSource!==undefined)entry.quotaSource=quotaSource;
        const next=loaded.source.endsWith(".json")?`${JSON.stringify(parsed,null,2)}\n`:dumpYaml(parsed,{lineWidth:120,noRefs:true});
        core.parseTeamConfig(next,loaded.source,t);
        if(primary!==undefined&&role.provider&&role.model){
          const {rows}=await teamContext(scope,t);
          const current=rows.get(roleName)??[];
          if(current.length===1){
            const meta=await bb.sdk.threads.getPluginMetadata({threadId:current[0]!.threadId}) as {teamExecution?:unknown};
            if(meta.teamExecution===undefined)await bb.sdk.threads.updatePluginMetadata({threadId:current[0]!.threadId,set:{teamExecution:{provider:role.provider,model:role.model,...(role.reasoningLevel?{reasoningLevel:role.reasoningLevel}:{}),...(role.serviceTier?{serviceTier:role.serviceTier}:{})},teamConfiguredExecution:JSON.stringify([role.provider,role.model,role.reasoningLevel,role.serviceTier])}});
          }
        }
        await writeWorkspaceFile(bb,scope,loaded.source,next);publishChange(projectId);
        const updated=core.parseTeamConfig(next,loaded.source,t).roles.find(r=>r.name===roleName)!;
        return {role:updated,source:loaded.source,revision:createHash("sha256").update(next).digest("hex")};
      });
    },
    async openrouterUsage({projectId,team,role,refresh}){
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      const list=(await teamContext(scope,t)).rows.get(role)??[];
      if(list.length!==1)return emptyOpenRouter("route_unknown","unknown");
      const usage=await routerUsage(list[0]!.threadId,undefined,refresh);
      if(refresh)publishChange(projectId);
      return usage;
    },
    async quotaPolicy({projectId,team,policy}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      if(policy){await bb.storage.kv.set(`quota-policy:${projectId}:${team}`,policy);publishChange(projectId);}
      return readQuotaPolicy(scope);
    },
    async deferredContinuation({projectId,team,role:roleName,action,expectedThreadId,sendAt,resumePaused}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);const key=deferredKey(projectId,team,roleName);
      if(action==="status")return {record:await readDeferred(bb,key)};
      return withScopeLock(scope,async()=>{
        const {rows}=await teamContext(scope,t);const list=rows.get(roleName)??[];
        if(list.length!==1||list[0]!.threadId!==expectedThreadId)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Session changed; refresh the employee card"});
        if(action==="check"){
          const record=await readDeferred(bb,key);
          if(!record||record.threadId!==expectedThreadId||!record.queuedMessageId||record.stage==="released")throw new experimental_PluginRpcRefusal({code:"conflict",message:"No confirmed queued continuation; inspect the thread queue"});
          const row=(await bb.sdk.threads.queuedMessages.list({threadId:record.threadId})).find(r=>r.id===record.queuedMessageId);
          if(!row||row.sendAt!==record.sendAt||queuedFingerprint(row)!==record.fingerprint)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Queued continuation changed; inspect it before retrying"});
          await bb.storage.kv.set(key,{...record,stage:"scheduled",reason:null});
          await bb.experimental_hooks.recheck("message.dispatch");publishChange(projectId);return {record:await readDeferred(bb,key)};
        }
        if(action==="cancel"){
          // Cancelling a timer is not permission to run its original input now.
          await bb.storage.kv.set(rolePauseKey(scope,roleName),true);
          await cancelDeferred(bb,key);publishChange(projectId);return {record:null};
        }
        if(!sendAt)throw new experimental_PluginRpcRefusal({code:"invalid",message:"Choose a future time"});
        if(await readPause(scope))throw new experimental_PluginRpcRefusal({code:"conflict",message:"The team is manually paused; scheduling cannot override it"});
        const employeePaused=await isRolePaused(scope,roleName);
        if(employeePaused&&!resumePaused)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Confirm replacing the employee pause with a scheduled wait"});
        const intent=await readReplacementIntent(bb,projectId,team,roleName);
        if(intent&&intent.stage!=="complete")throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the unfinished session replacement first"});
        if((await resources.inspect(scope)).blocked)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the task/team budget first; waiting cannot replenish it"});
        const thread=await bb.sdk.threads.get({threadId:expectedThreadId!});
        if(!["idle","error"].includes(thread.status))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Wait until the current operation ends"});
        const owner=await resourceOwner(thread.id);if(!owner)throw new Error("Employee binding unavailable");
        const summary=await resources.inspect(scope);
        if(packageResourceBlock(summary,owner.taskId))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the package budget first; waiting cannot replenish it"});
        const failed=[...summary.attempts].reverse().find(a=>a.threadId===thread.id&&a.outcome==="failed");
        const record=await scheduleDeferred(bb,key,{threadId:thread.id,taskId:owner.taskId,sendAt,failed:thread.status==="error",...(failed?.requestId?{turnRequestId:failed.requestId}:{})});
        // Future sendAt + the durable deferred guard hold all new turns. A
        // fresh manual pause set after this RPC will still block the deadline.
        if(employeePaused)await bb.storage.kv.delete(rolePauseKey(scope,roleName));
        publishChange(projectId);return {record};
      });
    },
    async ollamaUsage({projectId,team,refresh,role}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      if(role){
        const list=(await teamContext(scope,t)).rows.get(role)??[];
        const owner=list.length===1?await resourceOwner(list[0]!.threadId):null;
        if(!owner?.hostId)return {status:"unavailable" as const,checkedAtMs:Date.now(),windows:[],reason:"host_unavailable" as const};
        return cloudUsage(owner.hostId,refresh);
      }
      return cloudUsage(scope.hostId,refresh);
    },
    async roleRecovery({projectId,team,role,selection}) {
      const {t}=await loadLang();return inspectRoleRecovery(await scopeFor(projectId,team,t),role,selection);
    },
    async continueCoordination({projectId,team,taskId,expectedStarts,expectedUsed}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      return withScopeLock(scope,async()=>{
        const {lead,rows}=await teamContext(scope,t);const list=lead?rows.get(lead)??[]:[];
        const task=(await readTasks(scope)).tasks.find(t=>t.id===taskId&&t.role===lead&&["in-progress","review"].includes(t.status));
        if(!task||list.length!==1)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Coordination task or session changed; refresh the team"});
        const owner=await resourceOwner(list[0]!.threadId);
        if(!owner||owner.taskId!==taskId)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Coordination task is no longer bound"});
        const reason=currentLang==="ru"?`Пользователь разрешил до 4 дополнительных запусков руководителя по задаче «${task.title}»: проверить текущий результат, принять или вернуть конкретные замечания. Общие лимиты и квоты провайдеров не изменяются.`:`User allowed up to four additional lead starts for "${task.title}": inspect the current result, accept it or return concrete feedback. Other budgets and provider quotas are unchanged.`;
        const decisions=[task.decisions,reason].filter(Boolean).join("\n\n");if(decisions.length>24000)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Decision history is full; inspect the task manually"});
        const result=await resources.extendCoordination(owner,expectedStarts,expectedUsed,async()=>{await tracker.update(scope,taskId,{decisions});});
        publishChange(projectId);await bb.experimental_hooks.recheck("message.dispatch");
        result.budgetNotice=await notifyBudgetIncrease(scope,task,expectedUsed,expectedUsed+4,expectedUsed,reason,t,result.epic);return result;
      });
    },
    async roleControl({projectId,team,role:roleName,action,expectedThreadId,selection:requestedSelection,approveSelection,recoverFromWorkspace,expectedRecoveryRevision}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      return withScopeLock(scope,async()=>{
        const {loaded,rows}=await teamContext(scope,t);
        const configured=loaded?.config.roles.find(r=>r.name===roleName);
        if(!configured)throw new experimental_PluginRpcRefusal({code:"not_found",message:"Role not found"});
        const list=rows.get(roleName)??[];let threadId=list.length===1?list[0]!.threadId:null;
        if(action!=="status"&&(!threadId||expectedThreadId!==threadId))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Session changed or is ambiguous; refresh the employee card"});
        const key=rolePauseKey(scope,roleName);
        if(action==="pause")await bb.storage.kv.set(key,true);
        if(action==="resume") {
          const meta=await bb.sdk.threads.getPluginMetadata({threadId:threadId!}) as {teamExecution?:ExecutionFallbackSelection};
          const actual=meta.teamExecution??{provider:configured.provider??"",model:configured.model??""};
          const router=await routerUsage(threadId!,actual,true);
          if(router.service==="openrouter"){
            const owner=await resourceOwner(threadId!);const summary=await resources.inspect(scope);
            const hold=owner?summary.holds[owner.taskId===null?`role:${owner.role}`:`task:${owner.taskId}`]:undefined;
            if(await bb.storage.kv.get(routerWaitKey({...scope,role:roleName}))||hold&&["rate-limit","budget-exceeded"].includes(hold)){
              const quota=openRouterHeadroom(router,actual.model,(await readQuotaPolicy(scope)).pauseBelowPercent);
              if(quota.held||quota.unknown)throw new experimental_PluginRpcRefusal({code:"conflict",message:"OpenRouter quota is low or unknown; schedule later or select an independent service"});
              if(owner){await resources.confirmOpenRouterCapacity(owner,actual.provider,actual.model);if(hold)await resources.decide(owner,"User resumed after a fresh OpenRouter quota check",undefined,owner.taskId??undefined,owner.role,"capacity");}
            }
            await bb.storage.kv.delete(routerWaitKey({...scope,role:roleName}));
          }
          if(isOllamaCloud(actual.provider,actual.model)){
            const owner=await resourceOwner(threadId!);const summary=await resources.inspect(scope);
            const hold=owner?summary.holds[owner.taskId===null?`role:${owner.role}`:`task:${owner.taskId}`]:undefined;
            if(await bb.storage.kv.get(quotaWaitKey(scope,roleName))||hold&&["rate-limit","budget-exceeded"].includes(hold)){
              const quota=quotaHeadroom(owner?.hostId?await cloudUsage(owner.hostId,true):undefined,await readQuotaPolicy(scope));
              if(quota.unknown||quota.held)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Ollama quota is unknown or below the safety threshold; schedule later or choose an independent model"});
              if(owner?.hostId){await resources.confirmOllamaCapacity(owner.hostId);if(hold)await resources.decide(owner,"User resumed after a fresh Ollama account quota check",undefined,owner.taskId??undefined,owner.role,"capacity");}
            }
          }
          await bb.storage.kv.delete(quotaWaitKey(scope,roleName));
          const previous=await readAutoContinue(scope,roleName);
          if(previous?.stage==="failed"&&/host plugin calls.*factory registration/.test(previous.error??"")){
            const intent=await readReplacementIntent(bb,projectId,team,roleName);
            if(!intent||intent.stage==="complete")await writeAutoContinue(scope,roleName,{...previous,stage:"awaiting-checkpoint",errorCode:null,error:null,updatedAtMs:Date.now()});
          }
          await bb.storage.kv.delete(key);await bb.experimental_hooks.recheck("message.dispatch");
          if(await readAutoContinue(scope,roleName))await runAutoContinue(scope,roleName,t);else await dispatchNextPackage(scope,roleName,t);
          const current=(await teamContext(scope,t)).rows.get(roleName)??[];threadId=current.length===1?current[0]!.threadId:null;
        }
        if(action==="switch") {
          const savedSelection=configured.executionPolicy?.noAdditionalCost?configured.executionPolicy.fallbacks.find(c=>JSON.stringify(c)===JSON.stringify(requestedSelection)):undefined;
          const selection=approveSelection?requestedSelection:savedSelection;
          if(!selection)throw new experimental_PluginRpcRefusal({code:"invalid",message:"Select an explicitly approved backup model"});
          if(approveSelection){
            const recovery=await inspectRoleRecovery(scope,roleName,selection);
            if(!expectedRecoveryRevision||expectedRecoveryRevision!==recovery.revision)throw new experimental_PluginRpcRefusal({code:"conflict",message:"recovery_changed"});
            const blockers=recoverFromWorkspace?recovery.blockers.filter(b=>b!=="checkpoint_missing"&&b!=="checkpoint_stale"):recovery.blockers;
            if(blockers.length)throw new experimental_PluginRpcRefusal({code:"conflict",message:`recovery_blocked:${blockers.join(",")}`});
          }
          const owner=await resourceOwner(threadId!);
          const router=await routerUsage(threadId!,selection,true);
          if(router.service==="openrouter"){const quota=openRouterHeadroom(router,selection.model,(await readQuotaPolicy(scope)).pauseBelowPercent);if(quota.held||quota.unknown)throw new experimental_PluginRpcRefusal({code:"conflict",message:"OpenRouter capacity is low or unknown"});}
          const usage=isOllamaCloud(selection.provider,selection.model)?owner?.hostId?await cloudUsage(owner.hostId,true):{status:"unavailable" as const,checkedAtMs:Date.now(),windows:[],reason:"host_unavailable" as const}:undefined;
          if(usage&&(usage.status!=="ready"||quotaHeadroom(usage,await readQuotaPolicy(scope)).held))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Backup quota is exhausted or unavailable; choose an independent model or wait"});
          if(await readPause(scope))throw new experimental_PluginRpcRefusal({code:"conflict",message:"The team is paused; resume it first"});
          if(packageResourceBlock(await resources.inspect(scope),owner?.taskId))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the package resource limit first; switching cannot reset it"});
          const pending=await readReplacementIntent(bb,projectId,team,roleName);
          if(pending&&pending.stage!=="complete")throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the unfinished replacement before starting another switch"});
          await bb.storage.kv.set(key,true);
          if(approveSelection){
            const linked=await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,threadId!));
            if(linked!==undefined){
              const task=(await readTasks(scope)).tasks.find(t=>t.id===linked);
              if(!task)throw new experimental_PluginRpcRefusal({code:"conflict",message:"recovery_changed"});
              if(recoverFromWorkspace){
                const previous=await tracker.readCheckpoint(scope,linked);
                const previousText=previous?JSON.stringify(previous):null;
                const baseline=await environmentState(bb,threadId!);
                const snapshot=await captureCheckpoint(bb,linked,roleName,threadId!,{
                  goal:`Recover factual state, then continue task: ${task.title}`,
                  criteria:[`Read the authoritative requirements and decisions in task ${linked} before changing work`,`Inventory existing work without discarding uncommitted changes`,`Ask before repeating any external operation whose result is unknown`],
                  progress:"Previous execution progress is unconfirmed. Only the current Git environment and task binding have been inspected. Existing dirty files are not evidence of completed or correct work.",
                  decisions:[{what:"User explicitly requested workspace recovery on a selected model",why:"A current agent-authored handoff is unavailable; do not manufacture progress or completed checks"}],
                  checks:[{what:"Git environment snapshot",result:JSON.stringify({branch:baseline.state.branch,commit:baseline.state.commit,dirtyFiles:baseline.state.dirtyFiles})}],
                  blockers:["Prior external effects and unfinished operations are not established by the Git snapshot; inspect task records and ask the user when they cannot be verified"],
                  nextAction:`First inventory the existing files and authoritative task ${linked}, separating confirmed facts from unknown prior claims. Read any previous checkpoint preserved in task decisions. Do not repeat external effects with unknown results. Save a substantive checkpoint after that inspection, then continue the same task.`,
                  files:baseline.state.dirtyFiles,
                });
                const recoveryReason="User requested recovery from the task and existing workspace. Previous progress remains unconfirmed; the next session must inspect facts before continuing.";
                const preserved=[task.decisions,recoveryReason,previousText?`Previous checkpoint preserved before recovery (historical claims, not newly verified):\n${previousText}`:null].filter(Boolean).join("\n\n");
                if(preserved.length>24000)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Previous checkpoint is too large to preserve safely; inspect the task manually"});
                await tracker.update(scope,linked,{decisions:preserved});
                await tracker.writeCheckpoint(scope,linked,snapshot);
                const readBack=workCheckpointSchema.parse(await tracker.readCheckpoint(scope,linked));
                if(JSON.stringify(snapshot)!==JSON.stringify(readBack))throw new experimental_PluginRpcRefusal({code:"conflict",message:"Recovery state read-back mismatch"});
                await bb.storage.kv.set(checkpointRefKey(scope,roleName),{taskId:linked});
              }
              const current=(await readTasks(scope)).tasks.find(t=>t.id===linked)!;
              const reason=`Explicit manual selection for this task: ${selection.provider}/${selection.model}. Primary and automatic fallback policy are unchanged.`;
              const decisions=[current.decisions,reason].filter(Boolean).join("\n\n");
              if(decisions.length>24000)throw new experimental_PluginRpcRefusal({code:"conflict",message:"Decision history full"});
              await tracker.update(scope,linked,{decisions});
              await resources.decide(scope,reason,undefined,linked,roleName);
            }
          }
          const result=await continueRoleSession(scope,roleName,threadId!,{execution:selection,manualApproval:approveSelection===true});
          threadId=result.result.newThreadId;
          // Keep the new session paused until the user explicitly resumes it.
          await bb.storage.kv.set(key,true);
        }
        publishChange(projectId);
        const meta=threadId?await bb.sdk.threads.getPluginMetadata({threadId}) as {teamExecution?:unknown}:{};
        const actual=executionPolicySchema.shape.fallbacks.element.safeParse(meta.teamExecution??{provider:configured.provider,model:configured.model,...(configured.reasoningLevel?{reasoningLevel:configured.reasoningLevel}:{}),...(configured.serviceTier?{serviceTier:configured.serviceTier}:{})});
        return {paused:await isRolePaused(scope,roleName),threadId,fallbacks:configured.executionPolicy?.fallbacks??[],actual:actual.success?actual.data:null};
      });
    },
    async epicBudget({projectId,team,...input}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      return changeEpicBudget(scope,input,t);
    },
    async packageBudget({projectId,team,taskId,limit,expectedLimit,expectedUsed,reason}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      return changePackageBudget(scope,{taskId,limit,expectedLimit,expectedUsed,reason},t);
    },
    async resources({projectId,team,reason,role,policy,taskId}) {
      const {t}=await loadLang();const scope=await scopeFor(projectId,team,t);
      if(!reason){if(policy||taskId!==undefined||role)throw new experimental_PluginRpcRefusal({code:"invalid",message:"State the concrete resource decision"});return withResourceResults(await resources.inspect(scope),(await readTasks(scope)).tasks);}
      if(taskId!==undefined){
        const task=(await readTasks(scope)).tasks.find(t=>t.id===taskId);if(!task)throw new experimental_PluginRpcRefusal({code:"not_found",message:"Task missing"});
        const intent=await readReplacementIntent(bb,scope.projectId,scope.team,task.role);
        if(intent&&intent.stage!=="complete")throw new experimental_PluginRpcRefusal({code:"conflict",message:"Resolve the unfinished replacement before releasing attempts"});
        await tracker.review(scope,taskId,{decision:{decision:"changes-requested",reason,decidedBy:"manual",basis:"manual",atMs:Date.now()}});
      }
      if(policy){const {lead}=await teamContext(scope,t);await resources.pinPackages(scope,(await readTasks(scope)).tasks,lead);}
      const result=await resources.decide(scope,reason,policy,taskId,role);publishChange(projectId);
      await bb.experimental_hooks.recheck("message.dispatch");return withResourceResults(result,(await readTasks(scope)).tasks);
    },
    async setVersioned({ projectId, team, versioned }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const loaded = await readTeamConfig(bb, scope, team, t);
      const state = await setVersioned(scope, loaded.legacy, versioned);
      return { versioned: state.versioned, blocked: state.blocked };
    },
    async tell({ projectId, team, role, text }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const result = await tellRole(scope, role, text, t);
      return {
        sent: result.sent.length,
        failed: result.failed.length,
        paused: (await readPause(scope)) !== null,
      };
    },
    async taskAdd({ projectId, team, role, title, note, send, parentId }) {
      const { t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const result = await addPackage(scope, { role, title, note: note ?? null, send, parentId }, t, m);
      return { task: result.task, sentTo: result.sentTo, sendError: result.sendError };
    },
    async taskUpdate({ projectId, team, id, status, review, acceptReason, returnReason, expectedSubmissionId }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      // RPC comes from the user's panel (no team thread): the manual path.
      return { task: (await updatePackage(scope, id, { status, review, acceptReason, returnReason, expectedSubmissionId })).task };
    },
    async pause({ projectId, team, paused }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      if (paused) return { paused: true, count: (await pause(scope, t)).count };
      return { paused: false, count: (await resume(scope)) ?? 0 };
    },
  });

  /* ── Composer "@" menu: team roles of the current project ── */

  try {
    bb.ui.registerMentionProvider({
      id: "team-roles",
      label: strings(currentLang).mentionLabel,
      search: async ({ query, projectId }): Promise<PluginMentionItem[]> => {
        if (!projectId) return [];
        try {
          const t = strings(currentLang);
          const scan = await scanTeamThreads(bb, projectId);
          const multi = teamsWithThreads(scan).length > 1;
          const q = query.trim().toLowerCase();
          const items: PluginMentionItem[] = [];
          for (const row of scan.rows) {
            if (row.helper) continue;
            const label = multi ? `${row.team}/${row.role}` : row.role;
            if (q && !`${label} ${row.title}`.toLowerCase().includes(q)) continue;
            items.push({
              id: `${row.team}:${row.role}:${row.threadId}`,
              title: row.title || label,
              subtitle: t.mentionSubtitle(row.status, `${label} · ${row.provider}`),
            });
          }
          return items.slice(0, 8);
        } catch {
          return [];
        }
      },
      resolve: async (itemId) => {
        const parts = itemId.split(":");
        const threadId = parts.pop() ?? "";
        const role = parts.pop() ?? "";
        return { context: strings(currentLang).mentionContext(role, threadId) };
      },
    });
  } catch (error) {
    bb.log.warn(`mention provider registration failed: ${(error as Error).message}`);
  }

  /* ── CLI ── */

  bb.cli.register(
    defineCli({
      name: "team",
      summary: "Role-based agent teams for a project (.bb/teams/<team>.yaml)",
      commands: {
        /* ── bb team init ── */
        init: cliCommand({
          summary: "Create a team config from a template (or copy one from another project)",
          options: {
            project: PROJECT_OPTION,
            team: { ...TEAM_OPTION, description: `Team name (default: ${DEFAULT_TEAM})` },
            template: {
              type: "string",
              description: "Template id (default: the Default team template setting, initially dev); see bb team template list",
              placeholder: "<id>",
            },
            from: {
              type: "string",
              description: "Copy a team config and its prompts from another project",
              placeholder: "<project>",
            },
            "from-team": {
              type: "string",
              description: "The team to copy with --from (default: the same name)",
              placeholder: "<team>",
            },
            versioned: { type: "boolean", description: "Track the config in git right away" },
            force: { type: "boolean", description: "Overwrite existing files", short: "f" },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["template", "from"] },
            { kind: "requires", option: "from-team", needs: ["from"] },
          ],
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const team = input.options.team ?? DEFAULT_TEAM;
            core.assertTeamName(team);
            const scope: Scope = { ...workspace, team };
            let template: Pick<TeamTemplate, "title" | "roles">;
            let stripped = 0;
            let templateId: string | null = null;
            let vars: TeamConfig["vars"];
            let defaults: TeamConfig["defaults"];
            if (input.options.from) {
              const source = await resolveWorkspace(bb, input.options.from, undefined, t, {});
              const sourceTeam = input.options["from-team"] ?? team;
              let loaded: LoadedConfig;
              try {
                loaded = await readTeamConfig(bb, source, sourceTeam, t);
              } catch (error) {
                if ((error as PluginCliError).code === "config_missing") {
                  const err = m.fromNoConfig(source.projectName);
                  throw new PluginCliError(err.message, { code: "config_missing", hint: err.hint });
                }
                throw error;
              }
              const copied = await templateFromConfig(source, loaded, lang, t, team, loaded.config.title ?? team);
              template = copied.template;
              stripped = copied.stripped;
              vars = loaded.config.vars;
              defaults = loaded.config.defaults;
            } else {
              const settingsValues = await settings.get();
              templateId = input.options.template ?? settingsValues.defaultTemplate;
              try {
                template = await getTemplate(templateId, lang, m);
              } catch (error) {
                // An explicitly requested template keeps its plain error; a
                // missing saved default must not silently fall back.
                if (!input.options.template && (error as PluginCliError).code === "template_not_found") {
                  throw new PluginCliError(
                    `Default team template "${templateId}" does not exist; save it first or change the Team "Default team template" setting`,
                    { code: "template_not_found", hint: "bb team template list" },
                  );
                }
                throw error;
              }
            }
            const written = await withScopeLock(scope, async () => {
              const teams = await listConfiguredTeams(bb, workspace);
              if (teams.includes(team) && !input.options.force) {
                const err = m.teamExists(team);
                throw new PluginCliError(err.message, { code: "team_exists", hint: err.hint });
              }
              const checkouts = input.options.from ? [] : await bb.sdk.environments.list({
                projectId: scope.projectId, environmentProviderId: "project-checkout",
              });
              const files = teamFilesFromTemplate(lang, template, team, {
                vars,
                ...(!input.options.from ? { environment: checkouts.length ? "checkout" : "default" } : {}),
                ...(defaults ? { defaults: defaults as Record<string, unknown> } : {}),
              });
              const written = await writeTeamFiles(scope, files, Boolean(input.options.force), t);
              await setVersioned(scope, false, Boolean(input.options.versioned));
              return written;
            });
            const version = await versionState(scope, false);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  team,
                  template: templateId,
                  from: input.options.from ?? null,
                  written,
                  strippedThreadIds: stripped,
                  versioned: version.versioned,
                  versioningBlocked: version.blocked,
                }),
              };
            }
            const out = [
              t.initTitle(workspace.projectName, team),
              ...written.map((rel) => `  ${joinPath(workspace.path, rel)}`),
              "",
              ...(templateId ? [m.templateTitle(templateId)] : []),
              ...(stripped > 0 ? [m.fromStripped(stripped)] : []),
              ...t.initNext(team, teamLayout(team).config),
            ];
            if (version.blocked) out.push("", ...t.gitignoreNote);
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team create ── */
        create: cliCommand({
          summary: "Spawn the team threads from its config (missing roles only)",
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            "dry-run": { type: "boolean", description: "Show the plan without creating anything" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            if (input.options["dry-run"]) {
              const { config, source } = await readTeamConfig(bb, scope, scope.team, t);
              const { lead, roles } = core.semanticChecks(config, t);
              await validateProviders(bb, roles.filter((r) => !r.threadId), t);
              const existing = roleThreadsOf(await scanTeamThreads(bb, scope.projectId), scope.team);
              const out = [t.planTitle(source, scope.projectName)];
              for (const role of roles) {
                const already = existing.get(role.name)?.map((row) => row.threadId);
                out.push("", `${role.name}${role.name === lead.name ? " [lead]" : ""}:`);
                if (role.threadId) {
                  out.push(line(t.labels.thread, t.adoptExisting(role.threadId, "", role.title ?? "")));
                  continue;
                }
                out.push(line(t.labels.thread, already?.length ? t.alreadyCreated(already.join(", ")) : t.willCreate));
                out.push(line(t.labels.title, await threadTitle(scope, role.title ?? role.name)));
                out.push(line(t.labels.provider, role.provider ?? t.labels.projectDefault));
                if (role.model) out.push(line(t.labels.model, role.model));
                const environment = await resolveEnvironment(bb, scope, roleEnvironmentSpec(role, config), t);
                out.push(line(t.labels.environment, JSON.stringify(environment).slice(0, 120)));
                const prompt = core.applyVars(
                  await loadRolePrompt(bb, scope, role, role.name === lead.name, lang, t),
                  config.vars,
                );
                out.push(line(t.labels.prompt, `${prompt.split("\n")[0]!.slice(0, 80)}…`));
              }
              return { exitCode: 0, stdout: out.join("\n") };
            }
            const result = await spawnTeam(scope, lang, t, m);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: scope.projectId,
                  team: scope.team,
                  leadThreadId: result.leadThreadId,
                  sectionId: result.sectionId,
                  spawned: result.spawned,
                  existing: Object.fromEntries(result.existing),
                  rosterQueued: result.rosterQueued,
                  relinked: result.relinked,
                }),
              };
            }
            const out = [t.createTitle(scope.projectName, result.source)];
            for (const item of result.spawned) {
              const label = item.kind === "adopted" ? t.adopted : t.created;
              out.push(`  [${label}] ${item.role} — ${item.title} — @thread:${item.threadId}`);
            }
            const reported = new Set(result.spawned.map((item) => item.threadId));
            for (const [role, ids] of result.existing) {
              const remaining = ids.filter((id) => !reported.has(id));
              if (remaining.length > 0) out.push(t.alreadyThere(role, remaining.join(", ")));
            }
            if (result.relinked > 0) out.push(m.relinked(result.relinked));
            if (result.rosterQueued && result.leadThreadId) out.push("", t.rosterSent(result.leadThreadId));
            out.push("", "bb team status");
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team list ── */
        list: cliCommand({
          summary: "List the teams of a project",
          options: { project: PROJECT_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const scan = await scanTeamThreads(bb, workspace.projectId);
            const teams = await allTeams(workspace, scan);
            const rows = [];
            for (const team of teams) {
              const scope = { ...workspace, team };
              let loaded: LoadedConfig | null = null;
              try {
                loaded = await readTeamConfig(bb, scope, team, t);
              } catch {
                loaded = null;
              }
              const version = loaded ? await versionState(scope, loaded.legacy) : null;
              rows.push({
                team,
                title: loaded?.config.title ?? null,
                config: loaded?.source ?? null,
                versioned: version?.versioned ?? false,
                roles: loaded?.config.roles.length ?? 0,
                threads: scan.rows.filter((row) => row.team === team && !row.helper).length,
              });
            }
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ok: true, project: workspace.projectId, teams: rows }) };
            }
            if (rows.length === 0) return { exitCode: 0, stdout: t.noTeams };
            return {
              exitCode: 0,
              stdout: [
                m.teamsTitle(workspace.projectName),
                ...rows.map((row) => m.teamLine(row.team, row.title, row.versioned, row.roles, row.threads)),
              ].join("\n"),
            };
          },
        }),

        /* ── bb team add-role ── */
        "add-role": cliCommand({
          summary: "Add an executor role to a team (spawn it, or adopt an existing thread)",
          positionals: [{ name: "name", required: true, description: "Role name, e.g. junior or developer-2" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            kind: {
              type: "string",
              description: `Role kind for the built-in prompt: ${ROLE_KINDS.join(", ")}`,
              placeholder: "<kind>",
            },
            title: { type: "string", description: "Display title of the role" },
            provider: { type: "string", description: "Provider id (bb provider list)" },
            model: { type: "string", description: "Model of the provider" },
            thread: {
              type: "string",
              description: "Adopt this existing thread (same project, not in a team)",
              placeholder: "<thr_…>",
            },
            "no-spawn": { type: "boolean", description: "Only write the config; spawn later with bb team create" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const name = input.positionals.name!;
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
              throw new PluginCliError(`role name "${name}": lowercase letters, digits, hyphens`, {
                code: "invalid_value",
              });
            }
            const kind = roleKindOf(name, input.options.kind) ?? undefined;
            const roleInput: TemplateRole & { threadId?: string } = {
              name,
              ...(kind ? { kind } : {}),
              title: input.options.title ?? (kind ? kindTitle(lang, kind) : name),
              ...(input.options.provider ? { provider: input.options.provider } : {}),
              ...(input.options.model ? { model: input.options.model } : {}),
              ...(input.options.thread ? { threadId: input.options.thread } : {}),
            };
            const result = await addRole(scope, roleInput, lang, t, m, !input.options["no-spawn"]);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, team: scope.team, ...result }),
              };
            }
            const out = [m.roleAdded(result.role, scope.team)];
            if (result.threadId) out.push(`  @thread:${result.threadId}`);
            if (result.rewritten) out.push(m.configRewritten);
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team version ── */
        version: cliCommand({
          summary: "Track a team config in git (on) or keep it out of git (off)",
          positionals: [{ name: "state", required: true, description: "on | off" }],
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const state = input.positionals.state!;
            if (state !== "on" && state !== "off") {
              throw new PluginCliError(`expected on or off, got "${state}"`, { code: "invalid_value" });
            }
            const scope = await resolveScope(input.options, ctx, t);
            const loaded = await readTeamConfig(bb, scope, scope.team, t);
            const result = await setVersioned(scope, loaded.legacy, state === "on");
            const files = [loaded.source, `${result.layout.promptDir}/`].join(" ");
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, team: scope.team, versioned: result.versioned, blocked: result.blocked }),
              };
            }
            if (state === "on" && result.blocked) return { exitCode: 1, stdout: m.versionBlocked };
            return {
              exitCode: 0,
              stdout: state === "on" ? m.versionOn(scope.team, files) : m.versionOff(scope.team, files),
            };
          },
        }),

        /* ── bb team tell ── */
        tell: cliCommand({
          summary: "Send a message to a team role by name (or all)",
          positionals: [{ name: "role", required: true, description: 'Role name, or "all"' }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            message: {
              type: "string",
              description: "Message text; --message-stdin reads it from stdin",
              stdin: true,
            },
            "message-file": {
              type: "string",
              description: "Path to the message file on the invoking machine",
              placeholder: "<path>",
            },
            json: JSON_OPTION,
          },
          constraints: [{ kind: "exactly-one", options: ["message", "message-file"] }],
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            let text = input.options.message;
            if (!text) {
              const rel = input.options["message-file"]!;
              const hostId = await core.invokerHost(bb, ctx);
              const base = ctx.cwd?.replace(/\/+$/, "") || scope.path;
              const abs = rel.startsWith("/") ? rel : joinPath(base, rel);
              try {
                text = (await bb.sdk.files.read({ hostId: hostId ?? undefined, path: abs })).content;
              } catch {
                throw new PluginCliError(t.tellFileReadFailed(rel), { code: "message_file_missing" });
              }
            }
            if (!text || text.trim().length === 0) {
              throw new PluginCliError(t.tellMessageRequired.message, {
                code: "message_required",
                hint: t.tellMessageRequired.hint,
              });
            }
            const { sent, failed } = await tellRole(scope, input.positionals.role!, text, t, ctx.threadId);
            const paused = (await readPause(scope)) !== null;
            if (input.options.json) {
              return {
                exitCode: failed.length > 0 && sent.length === 0 ? 1 : 0,
                stdout: JSON.stringify({ ok: failed.length === 0, team: scope.team, sent, failed, paused }),
              };
            }
            const out = [
              ...sent.map((item) => t.tellSent(item.role, item.threadId)),
              ...failed.map((item) => t.tellFailed(item.role, item.error)),
              "",
              t.tellSummary(sent.length, failed.length),
            ];
            if (paused && sent.length > 0) out.push(m.tellPausedNote);
            return { exitCode: sent.length > 0 ? 0 : 1, stdout: out.join("\n") };
          },
        }),

        budget: cliCommand({
          summary:"Inspect or change a package budget; --epic selects a shared Beads epic budget",
          positionals:[{name:"id",required:true,description:"Work package ID"}],
          options:{project:PROJECT_OPTION,team:TEAM_OPTION,json:JSON_OPTION,epic:{type:"boolean",description:"Inspect or set a shared Beads epic budget"},"expected-epic":{type:"string",description:"Current active epic ID, or none"},"expected-revision":{type:"string",description:"Selected epic budget revision, or 0 for a new budget"},limit:{type:"string",description:"Approved total allowance (packages 1..1000, epics 1..10000), including usage"},"expected-limit":{type:"string",description:"Current limit shown by budget"},"expected-used":{type:"string",description:"Current usage shown by budget"},reason:{type:"string",description:"User's explicit decision and grounds"}},
          async run(input,ctx){
            const {t}=await loadLang();const scope=await resolveScope(input.options,ctx,t);
            if(input.options.epic){
              const epicId=input.positionals.id!;const epic=await tracker.validateEpic(scope,epicId);
              let state=await resources.inspect(scope);
              if(input.options.limit!==undefined){
                const expected=input.options["expected-epic"];
                if(expected===undefined||input.options["expected-revision"]===undefined||input.options["expected-used"]===undefined)
                  throw new PluginCliError("Inspect --epic first; supply --expected-epic, --expected-revision, --expected-used and --reason",{code:"invalid_value"});
                state=await changeEpicBudget(scope,epicBudgetChangeSchema.parse({epicId,limit:Number(input.options.limit),expectedActiveEpicId:expected==="none"?null:expected,expectedRevision:Number(input.options["expected-revision"]),expectedUsed:Number(input.options["expected-used"]),reason:input.options.reason??""}),t,ctx.threadId);
              }
              const budget=state.epicBudgets?.[epicId];
              const summary={epicId,title:epic.title,criteria:epic.criteria,activeEpicId:state.epic?.id??null,limit:budget?.limit??null,used:budget?.used??0,revision:budget?.revision??0,blocked:state.epic?.blocked??null};
              return {exitCode:0,stdout:input.options.json?JSON.stringify(summary):`${epic.title} (${epicId}): ${summary.used}/${summary.limit??"unset"}; revision ${summary.revision}; active epic ${summary.activeEpicId??"none"}. ${summary.blocked??""}`};
            }
            const taskId=parseTaskId(input.positionals.id!);
            const task=(await readTasks(scope)).tasks.find(task=>task.id===taskId);if(!task)throw new PluginCliError("Package not found",{code:"task_not_found"});
            const {lead}=await teamContext(scope,t);await resources.pinPackages(scope,[task],lead);
            const before=await resources.inspect(scope),used=before.taskCounts.filter(c=>c.taskId===taskId).reduce((n,c)=>n+c.starts+c.returns,0);
            const current=before.taskLimits?.[`task:${taskId}`]??(task.role===lead?before.policy.coordinationAttempts??before.policy.taskAttempts:before.policy.taskAttempts);
            let result=before;
            if(input.options.limit!==undefined){
              const limit=Number(input.options.limit),expectedLimit=Number(input.options["expected-limit"]),expectedUsed=Number(input.options["expected-used"]);
              if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(expectedLimit)||expectedLimit<1||!Number.isInteger(expectedUsed)||expectedUsed<0)throw new PluginCliError("Use budget first, then provide --limit, --expected-limit, --expected-used and --reason",{code:"invalid_value"});
              result=await changePackageBudget(scope,{taskId,limit,expectedLimit,expectedUsed,reason:input.options.reason??""},t,ctx.threadId);
            }
            const summary={taskId,title:task.title,used,limit:result.taskLimits?.[`task:${taskId}`]??current,sharedStartCap:result.epic?.limit??null,epic:result.epic,blocked:result.epic?.blocked??packageResourceBlock(result,taskId)};
            return {exitCode:0,stdout:input.options.json?JSON.stringify(summary):`${task.title} (#${taskId}): ${used}/${summary.limit}. ${result.epic?`Epic ${result.epic.id}: ${result.epic.used}/${result.epic.limit}`:(currentLang==="ru"?"Общего лимита запусков команды нет; расход пакета сохранён.":"No shared start cap; package usage is retained.")}`};
          },
        }),

        tracker: cliCommand({
          summary: "Select one task tracker for every team of the project",
          positionals: [{name: "kind", description: "beads | builtin | default (clear override)"}],
          options: {project: PROJECT_OPTION, json: JSON_OPTION},
          async run(input, ctx) {
            const {t} = await loadLang();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const kind = input.positionals.kind;
            if (kind !== undefined) {
              if (!["beads", "builtin", "default"].includes(kind)) throw new PluginCliError("Tracker must be beads, builtin or default", {code: "invalid_value"});
              await setProjectTracker(workspace, kind === "default" ? null : kind as "beads" | "builtin");
            }
            const config = await tracker.getConfig(workspace);
            return {exitCode: 0, stdout: input.options.json ? JSON.stringify({projectId: workspace.projectId, ...config}) : `${workspace.projectName}: ${config.kind} (${config.override ? "project override" : "plugin default"})`};
          },
        }),
        checkpoint: cliCommand({
          summary: "Save a complete task handoff and verify the current environment",
          positionals: [{name: "id", required: true, description: "Task ID"}],
          options: {project: PROJECT_OPTION, team: TEAM_OPTION, file: {type: "string", required: true, description: "Checkpoint JSON file, absolute or relative to the caller environment"}, rotate: {type: "boolean", description: "Queue a session rotation: this task continues in a fresh session with this checkpoint once the current operations end (idle)"}, json: JSON_OPTION},
          async run(input, ctx) {
            const {t} = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            return withScopeLock(scope, async () => {
              const id = parseTaskId(input.positionals.id!);
              const task = (await readTasks(scope)).tasks.find(task => task.id === id);
              if (!task) throw new PluginCliError(`Task ${id} not found`, {code: "task_not_found"});
              const replacement = await readReplacementIntent(bb,scope.projectId,scope.team,task.role);
              if (replacement && replacement.stage!=="complete") {
                const canonical=await bb.storage.kv.get<string>(`active-session:${scope.projectId}:${scope.team}:${task.role}`);
                if ((replacement.stage!=="spawning" && replacement.stage!=="spawn_uncertain") || (canonical && canonical!==replacement.oldThreadId)) throw new PluginCliError("Finish or abort the pending replacement before saving another checkpoint",{code:"replacement_pending"});
              }
              const {rows} = await teamContext(scope, t);
              const list = rows.get(task.role) ?? [];
              if (list.length !== 1) throw new PluginCliError("Checkpoint requires exactly one current thread for the task role", {code: "thread_ambiguous"});
              const target = list[0]!;
              const assigned=await bb.storage.kv.get<TaskId>(sessionTaskKey(scope,target.threadId));
              if (assigned !== undefined && assigned !== id) throw new PluginCliError("Checkpoint must describe this session existing package",{code:"session_consumed"});
              const other=busyTasks(await readTasks(scope),task.role,id);
              if (other.length) throw new PluginCliError("Checkpoint must describe the role active package",{code:"role_busy"});
              if (task.status === "todo" && !(await tracker.ready(scope)).includes(id)) throw new PluginCliError("Checkpoint task is not ready in the selected tracker",{code:"task_not_ready"});
              if (ctx.threadId && ctx.threadId !== target.threadId) {
                const mark = readTeamMark(await bb.sdk.threads.getPluginMetadata({threadId: ctx.threadId}) as Record<string,unknown>);
                if (mark) throw new PluginCliError("An agent can checkpoint only its own role", {code: "task_forbidden"});
              }
              const thread = await bb.sdk.threads.get({threadId: ctx.threadId ?? target.threadId});
              const environment = thread.environmentId ? await bb.sdk.environments.get({environmentId: thread.environmentId}) : null;
              const path = joinPath(environment?.path ?? scope.path, input.options.file!);
              const file = await bb.sdk.files.read({hostId: environment?.hostId ?? scope.hostId, path});
              let content: unknown;
              try { content = JSON.parse(file.content); } catch { throw new PluginCliError("Checkpoint file must contain JSON", {code: "checkpoint_invalid"}); }
              const checkpoint = await captureCheckpoint(bb, id, task.role, target.threadId, content);
              if (task.status === "todo") await tracker.update(scope,id,{status:"in-progress"});
              await tracker.writeCheckpoint(scope, id, checkpoint);
              const verified = workCheckpointSchema.parse(await tracker.readCheckpoint(scope, id));
              if (JSON.stringify(checkpoint) !== JSON.stringify(verified)) throw new PluginCliError("Checkpoint read-back failed", {code: "checkpoint_invalid"});
              await bb.storage.kv.set(checkpointRefKey(scope, task.role), {taskId: id});
              await bb.storage.kv.set(sessionTaskKey(scope,target.threadId),id);
              // --rotate queues an explicit deferred context rotation; it
              // never stops the caller's own active turn (the machine only
              // replaces idle sessions). Otherwise a fresh agent-saved
              // checkpoint can release a pending auto-continue.
              let rotation: "requested" | "replaced" | null = null;
              if (input.options.rotate) rotation = await armContextRotation(scope, task.role, id, target.threadId, t);
              else await runAutoContinue(scope, task.role, t);
              const note = rotation === "replaced"
                ? `; session replaced: task ${id} continues in a fresh session`
                : rotation === "requested"
                  ? "; session rotation queued: it runs when this session reaches a safe boundary"
                  : "";
              return {exitCode: 0, stdout: input.options.json ? JSON.stringify({ok:true, taskId:id, role:task.role, environmentId:checkpoint.environmentId, ...(rotation ? {rotate: rotation} : {})}) : `Checkpoint saved in task ${id}; environment ${checkpoint.environmentId}${note}`};
            });
          },
        }),

        /* ── bb team task … ── */
        "task add": cliCommand({
          summary: "Add a work package for a role (--send hands it to the role's thread)",
          positionals: [
            { name: "role", required: true, description: "Role name" },
            { name: "title", required: true, variadic: true, description: "Package title" },
          ],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            note: {
              type: "string",
              description: "Details sent with the package; --note-stdin reads them from stdin",
              stdin: true,
            },
            parent: {type:"string",description:"Explicit Beads epic parent ID"},
            send: { type: "boolean", description: "Send it to the role's thread and mark it in-progress" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const result = await addPackage(
              scope,
              {
                role: input.positionals.role!,
                title: (input.positionals.title as string[]).join(" "),
                note: input.options.note ?? null,
                send: input.options.send,
                parentId:input.options.parent,
              },
              t,
              m,
              ctx.threadId,
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  team: scope.team,
                  task: result.task,
                  sentTo: result.sentTo,
                  sendError: result.sendError,
                  busy: result.busy.map((task) => task.id),
                }),
              };
            }
            const out = [m.taskAdded(result.task.id, result.task.role, result.task.title)];
            out.push(`  ${m.taskStatusLine(result.task.status)}`);
            if (result.sentTo) out.push(`  ${m.taskSent(result.task.role, result.sentTo)}`);
            if (input.options.send && !result.sentTo && !result.sendError) out.push("  queued: the role must finish its current package; replace a completed session to start another package");
            if (result.sendError) out.push(`  ${m.taskSendFailed(result.task.id, result.sendError)}`);
            if (result.busy.length > 0) {
              out.push(`  ${m.taskBusy(result.task.role, result.busy.map((task) => `#${task.id}`).join(", "))}`);
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        "task list": cliCommand({
          summary: "List work packages (open ones by default)",
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            role: { type: "string", description: "Only this role", placeholder: "<role>" },
            all: { type: "boolean", description: "Include done and dropped packages" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const tasks = listTasks(await readTasks(scope), {
              role: input.options.role,
              includeClosed: input.options.all,
            }).slice(-100);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ok: true, team: scope.team, tasks }) };
            }
            if (tasks.length === 0) return { exitCode: 0, stdout: m.taskListEmpty };
            const nowMs = Date.now();
            return {
              exitCode: 0,
              stdout: [
                m.taskListTitle(scope.team === DEFAULT_TEAM ? scope.projectName : `${scope.projectName} · ${scope.team}`),
                ...tasks.map(
                  (task) =>
                    `  #${task.id} [${task.status}] ${task.role} — ${task.title} · ${relativeAgo(task.updatedAtMs, nowMs)}`,
                ),
              ].join("\n"),
            };
          },
        }),

        "task update": cliCommand({
          summary: "Change a work package: status, title, note, review report or acceptance grounds",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            status: { type: "string", description: `New status: ${TASK_STATUSES.join(" | ")}`, placeholder: "<status>" },
            title: { type: "string", description: "New title" },
            note: { type: "string", description: "New note (empty string clears it)", stdin: true },
            review: {
              type: "string",
              description:
                'Review report JSON for --status review: {"result":…,"artifacts":[…],"checks":[{"what":…,"result":…}|{"what":…,"notApplicable":…}],"problems":[…]}',
              stdin: true,
            },
            "accept-reason": { type: "string", description: "Grounds for accepting (--status done): what was verified and why it is enough", stdin: true },
            "return-reason": { type: "string", description: "Concrete remark when returning from review (--status todo)", stdin: true },
            "expected-submission": {
              type: "string",
              description: "Id of the reviewed submission (bb team task list --json): a mismatch with the stored report is a conflict, nothing is written",
              placeholder: "<sub_…>",
            },
            json: JSON_OPTION,
          },
          constraints: [{ kind: "at-least-one", options: ["status", "title", "note", "review", "accept-reason", "return-reason"] }],
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            let status: TaskStatus | undefined;
            try {
              status = input.options.status ? parseTaskStatus(input.options.status) : undefined;
            } catch (error) {
              return asCliError(error);
            }
            await guardAccept(scope, status, ctx.threadId, t, m);
            const result = await updatePackage(scope, parseTaskId(input.positionals.id!), {
              status,
              title: input.options.title,
              note: input.options.note,
              review: input.options.review,
              acceptReason: input.options["accept-reason"],
              returnReason: input.options["return-reason"],
              expectedSubmissionId: input.options["expected-submission"],
            }, ctx.threadId);
            return taskOutput(result, input.options.json, scope, m);
          },
        }),

        "task done": cliCommand({
          summary: "Accept a work package (status done)",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            reason: {
              type: "string",
              description: "Grounds for acceptance: what was verified and why it is enough (required for the lead role)",
              stdin: true,
            },
            "expected-submission": {
              type: "string",
              description: "Id of the reviewed submission (bb team task list --json): a mismatch with the stored report is a conflict, nothing is written",
              placeholder: "<sub_…>",
            },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            await guardAccept(scope, "done", ctx.threadId, t, m);
            const result = await updatePackage(scope, parseTaskId(input.positionals.id!), {
              status: "done",
              acceptReason: input.options.reason,
              expectedSubmissionId: input.options["expected-submission"],
            }, ctx.threadId);
            return taskOutput(result, input.options.json, scope, m);
          },
        }),

        "task remove": cliCommand({
          summary: "Delete a work package (use status dropped to keep a record)",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const id = parseTaskId(input.positionals.id!);
            try {
              await withScopeLock(scope, async () => {
                const task = (await readTasks(scope)).tasks.find(task => task.id === id);
                if (task && (task.status === "in-progress" || task.status === "review")) throw new PluginCliError("Drop or accept the active package before removing it", {code: "role_busy"});
                await tracker.remove(scope, id);
              });
            } catch (error) {
              return asCliError(error);
            }
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, removed: id }) };
            return { exitCode: 0, stdout: m.taskRemoved(id) };
          },
        }),

        /* ── bb team report ── */
        report: cliCommand({
          summary: "Team digest: an inline-vis HTML page (--out) or Markdown on stdout",
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            format: {
              type: "enum",
              values: ["html", "md"] as const,
              description: "html (default with --out) or md (default without)",
            },
            out: {
              type: "string",
              description: 'File to write on the invoking machine, e.g. "$BB_THREAD_STORAGE/team-report.html"',
              placeholder: "<file>",
            },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const snapshot = await buildSnapshot(scope, t);
            const nowMs = Date.now();
            const format = input.options.format ?? (input.options.out ? "html" : "md");
            const body =
              format === "html" ? renderReportHtml(snapshot, lang, nowMs) : renderReportMarkdown(snapshot, lang, nowMs);
            if (!input.options.out) {
              if (format === "html") {
                throw new PluginCliError(m.reportOutRequired.message, {
                  code: "out_required",
                  hint: m.reportOutRequired.hint,
                });
              }
              if (input.options.json) {
                return { exitCode: 0, stdout: JSON.stringify({ ok: true, team: scope.team, markdown: body }) };
              }
              return { exitCode: 0, stdout: body };
            }
            const base = ctx.cwd?.replace(/\/+$/, "") || scope.path;
            const outPath = input.options.out.startsWith("/") ? input.options.out : joinPath(base, input.options.out);
            if (!/\.(html?|md|markdown)$/i.test(outPath)) {
              throw new PluginCliError(`--out must end in .html or .md: ${outPath}`, { code: "invalid_value" });
            }
            const hostId = await core.invokerHost(bb, ctx);
            await bb.sdk.files.write({ hostId: hostId ?? undefined, path: outPath, content: body, createParents: true });
            let directive: string | null = null;
            if (ctx.threadId) {
              try {
                const location = await bb.sdk.threads.storageLocation({ threadId: ctx.threadId });
                const root = location.storageRootPath.replace(/\/+$/, "");
                if (outPath.startsWith(`${root}/`)) {
                  directive = `::inline-vis{source="thread-storage" file="${outPath.slice(root.length + 1)}"}`;
                }
              } catch {
                // no thread storage — print the path only
              }
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, team: scope.team, path: outPath, format, directive }),
              };
            }
            const out = [m.reportWritten(outPath)];
            if (directive) out.push("", m.reportShow, directive);
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team doctor ── */
        doctor: cliCommand({
          summary: "Check config, providers, environments, prompts and team threads",
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const checks = await runDoctor(scope, lang, t, m);
            const fail = checks.filter((c) => c.level === "fail").length;
            const warn = checks.filter((c) => c.level === "warn").length;
            if (input.options.json) {
              return {
                exitCode: fail > 0 ? 1 : 0,
                stdout: JSON.stringify({ ok: fail === 0, project: scope.projectId, team: scope.team, fail, warn, checks }),
              };
            }
            const out = [m.doctorTitle(scope.team === DEFAULT_TEAM ? scope.projectName : `${scope.projectName} · ${scope.team}`)];
            for (const check of checks) {
              const mark = check.level === "ok" ? "ok  " : check.level === "warn" ? "warn" : "FAIL";
              out.push(`  [${mark}] ${check.check}: ${check.detail}`);
            }
            out.push("", fail + warn === 0 ? m.doctorAllGood : m.doctorSummary(fail, warn));
            return { exitCode: fail > 0 ? 1 : 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team replace ── */
        replace: cliCommand({
          summary: "Continue a role in its existing environment using a saved task checkpoint",
          positionals: [{ name: "role", required: true, description: "Role name" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            thread: { type: "string", description: "The thread to replace when the role has several", placeholder: "<thr_…>" },
            keep: { type: "boolean", description: "Keep the old thread (unbound from the role) instead of archiving it" },
            abort: {type:"boolean",description:"Cancel an unfinished replacement before the canonical role switches; keep the original session"},
            "dry-run": { type: "boolean", description: "Show the plan without changing anything" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const roleName = input.positionals.role!;
            const { roles } = core.semanticChecks((await readTeamConfig(bb, scope, scope.team, t)).config, t);
            const role = roles.find((r) => r.name === roleName);
            if (!role) {
              const err = m.taskRoleUnknown(roleName);
              throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
            }
            return withScopeLock(scope, async () => {
              const scan = await scanTeamThreads(bb, scope.projectId);
              const rows = roleThreadsOf(scan, scope.team);
              const intent = await readReplacementIntent(bb, scope.projectId, scope.team, roleName);
              const pending = intent && intent.stage !== "complete" ? intent : null;
              if (input.options.abort && !input.options["dry-run"]) {
                if(!pending)throw new PluginCliError("No unfinished replacement to abort",{code:"replacement_missing"});
                await abortRoleReplacement(scope,roleName,pending);
                publishChange(scope.projectId);
                return {exitCode:0,stdout:input.options.json?JSON.stringify({ok:true,aborted:true,oldThreadId:pending.oldThreadId}):`Replacement aborted; original session ${pending.oldThreadId} remains current`};
              }
              if (pending?.stage === "spawn_uncertain" && input.options.thread && !input.options["dry-run"]) {
                const candidate = await bb.sdk.threads.get({threadId:input.options.thread});
                const meta = await bb.sdk.threads.getPluginMetadata({threadId:candidate.id}) as Record<string,unknown>;
                if (candidate.projectId!==scope.projectId || candidate.environmentId!==pending.environmentId || !(await isPreparedReplacement(bb,candidate)) || candidate.archivedAt!==null || meta.teamReplacement!==true || meta.teamReplacementRole!==roleName || meta.teamReplacementTeam!==scope.team) throw new PluginCliError("Candidate is not an idle replacement for this role and environment",{code:"replacement_candidate_invalid"});
                pending.newThreadId=candidate.id;pending.stage="spawning";
                await bb.storage.kv.set(`replacement:${scope.projectId}:${scope.team}:${roleName}`,pending);
              }
              const list = rows.get(roleName) ?? [];
              const selected = pending?.oldThreadId ?? input.options.thread ?? (list.length === 1 ? list[0]!.threadId : null);
              if (!selected) throw new PluginCliError(list.length ? m.replaceAmbiguous(roleName, list.map(x=>x.threadId).join(", ")).message : m.replaceNoThread(roleName).message, {code: list.length ? "thread_ambiguous" : "thread_not_found"});
              if (!pending && !list.some(x => x.threadId === selected)) throw new PluginCliError(m.replaceThreadMismatch(roleName, selected), {code: "thread_not_found"});
              const old = await bb.sdk.threads.get({threadId: selected});
              if (input.options["dry-run"]) return {exitCode: 0, stdout: input.options.json ? JSON.stringify({ok:true,dryRun:true,role:roleName,oldThreadId:old.id,environmentId:old.environmentId,replacement:pending}) : m.replacePlan(roleName, old.id)};
              const outcome = await continueRoleSession(scope, roleName, old.id, {keep: input.options.keep, pending});
              if (input.options.json) return {exitCode:0,stdout:JSON.stringify({ok:true,team:scope.team,role:roleName,...outcome.result,continuing:outcome.continuing,archived:!outcome.kept})};
              return {exitCode:0,stdout:[m.replaceDone(roleName,outcome.result.oldThreadId,outcome.result.newThreadId),m.replaceReparented(outcome.result.reparented)].join("\n")};
            });
          },
        }),

        /* ── bb team stop / pause / resume ── */
        stop: cliCommand({
          summary: "Stop running team threads: the executors, one role, or all (incl. the lead)",
          positionals: [{ name: "role", description: 'Role name, or "all"; default: every executor (not the lead)' }],
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const { rows, helpers, lead } = await teamContext(scope, t);
            const wanted = input.positionals.role;
            if (wanted && wanted !== "all" && !rows.has(wanted)) {
              const err = t.tellRoleNotFound(wanted);
              throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
            }
            const stopped: Array<{ role: string; threadId: string }> = [];
            const failed: Array<{ role: string; error: string }> = [];
            for (const source of [rows, helpers]) {
              for (const [role, list] of source) {
                if (wanted && wanted !== "all" && role !== wanted) continue;
                if (!wanted && role === lead) continue;
                for (const row of list) {
                  if (!RUNNING.includes(row.status) || row.threadId === ctx.threadId) continue;
                  try {
                    await bb.sdk.threads.stop({ threadId: row.threadId });
                    stopped.push({ role, threadId: row.threadId });
                  } catch (error) {
                    failed.push({ role, error: (error as Error).message });
                  }
                }
              }
            }
            if (stopped.length > 0) publishChange(scope.projectId);
            if (input.options.json) {
              return {
                exitCode: failed.length > 0 ? 1 : 0,
                stdout: JSON.stringify({ ok: failed.length === 0, team: scope.team, stopped, failed }),
              };
            }
            if (stopped.length + failed.length === 0) return { exitCode: 0, stdout: m.stopNone };
            return {
              exitCode: failed.length > 0 ? 1 : 0,
              stdout: [
                ...stopped.map((item) => m.stopped(item.role, item.threadId)),
                ...failed.map((item) => m.stopFailed(item.role, item.error)),
              ].join("\n"),
            };
          },
        }),

        pause: cliCommand({
          summary: "Hold agent messages to every executor of a team until bb team resume",
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            stop: { type: "boolean", description: "Also stop executors that are running now" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const result = await pause(scope, t);
            const stopped: string[] = [];
            if (input.options.stop) {
              const scan = await scanTeamThreads(bb, scope.projectId);
              for (const row of scan.rows) {
                if (!pausedThreads.has(row.threadId) || !RUNNING.includes(row.status)) continue;
                try {
                  await bb.sdk.threads.stop({ threadId: row.threadId });
                  stopped.push(row.threadId);
                } catch {
                  // reported by count only
                }
              }
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, team: scope.team, paused: true, already: result.already, count: result.count, stopped }),
              };
            }
            const out = [result.already ? m.pausedAlready : m.paused(result.count)];
            for (const id of stopped) out.push(m.stopped("", id).trim());
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        resume: cliCommand({
          summary: "Release a paused team: held messages are delivered",
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const count = await resume(scope);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ok: true, team: scope.team, resumed: count !== null, count: count ?? 0 }) };
            }
            return { exitCode: 0, stdout: count === null ? m.notPaused : m.resumed(count) };
          },
        }),

        /* ── bb team retitle ── */
        retitle: cliCommand({
          summary: "Re-apply the title format (Settings → Team) to a team's threads",
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const { loaded, rows, scan } = await teamContext(scope, t);
            const titles = new Map((loaded?.config.roles ?? []).map((role) => [role.name, role.title ?? role.name]));
            let count = 0;
            for (const [role, list] of rows) {
              const title = await threadTitle(scope, titles.get(role) ?? role, scan);
              for (const row of list) {
                if (row.title === title) continue;
                await bb.sdk.threads.update({ threadId: row.threadId, title });
                count += 1;
              }
            }
            if (count > 0) publishChange(scope.projectId);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, team: scope.team, renamed: count }) };
            return { exitCode: 0, stdout: m.retitled(count) };
          },
        }),

        /* ── bb team status ── */
        status: cliCommand({
          summary: "Show the teams of a project: config, live threads, current packages",
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const teams = input.options.team ? [input.options.team] : await allTeams(workspace);
            if (input.options.team) core.assertTeamName(input.options.team);
            const snapshots: TeamSnapshot[] = [];
            for (const team of teams.length > 0 ? teams : [DEFAULT_TEAM]) {
              snapshots.push(await buildSnapshot({ ...workspace, team }, t));
            }
            const configReport = (snapshot: TeamSnapshot) =>
              snapshot.configSource
                ? {
                    source: snapshot.configSource,
                    lead: snapshot.leadRole,
                    roles: snapshot.roles
                      .filter((role) => role.inConfig)
                      .map((role) => `${role.name}${role.enabled ? "" : t.labels.disabledRole}`),
                  }
                : null;
            if (input.options.json) {
              const first = snapshots[0]!;
              const teamJson = (snapshot: TeamSnapshot) => ({
                team: snapshot.team,
                title: snapshot.teamTitle,
                versioned: snapshot.versioned,
                config: configReport(snapshot),
                configError: snapshot.configError,
                trackerError: snapshot.trackerError ?? null,
                paused: snapshot.paused,
                threads: Object.fromEntries(
                  snapshot.roles.filter((r) => r.threads.length > 0).map((r) => [r.name, r.threads]),
                ),
                helpers: Object.fromEntries(
                  snapshot.roles.filter((r) => r.helpers.length > 0).map((r) => [r.name, r.helpers]),
                ),
                tasks: Object.fromEntries(
                  snapshot.roles.filter((r) => r.tasks.length > 0).map((r) => [r.name, r.tasks]),
                ),
              });
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  ...teamJson(first),
                  teams: snapshots.map(teamJson),
                }),
              };
            }
            const nowMs = Date.now();
            const out = [t.statusTitle(workspace.projectName)];
            if (teams.length === 0) out.push(`  ${t.noTeams}`);
            for (const snapshot of teams.length === 0 ? [] : snapshots) {
              const report = configReport(snapshot);
              out.push(`${t.teamHeader(snapshot.team, snapshot.teamTitle, snapshot.versioned === true)}`);
              if (report) {
                out.push(`  ${t.labels.config}: ${report.source}`);
                out.push(`  ${t.labels.lead}: ${report.lead ?? "—"}`);
                out.push(`  ${t.labels.roles}: ${report.roles.join(", ")}`);
              } else {
                out.push(`  ${t.statusNoConfig(snapshot.team)}`);
              }
              if (snapshot.configError) out.push(`  ! ${snapshot.configError}`);
              if (snapshot.trackerError) out.push(`  ! ${snapshot.trackerError.message}`);
              if (snapshot.paused) out.push(`  ${m.doctorPaused}`);
              if (snapshot.roles.every((role) => role.threads.length === 0)) {
                out.push(`  ${t.statusThreadsEmpty}`);
                continue;
              }
              out.push(`  ${t.statusThreads}`);
              for (const role of snapshot.roles) {
                if (!role.enabled && role.threads.length === 0) continue;
                const task = currentTask(role.tasks);
                const taskText = task ? ` · #${task.id} ${task.title} [${task.status}]` : "";
                const helpersText = role.helpers.length > 0 ? ` · ${t.helpers(role.helpers.length)}` : "";
                if (role.threads.length === 0) {
                  out.push(`    ${role.name}: ${t.statusNoThread}${taskText}`);
                  continue;
                }
                for (const row of role.threads) {
                  out.push(
                    `    ${role.name}: ${row.threadId} [${row.status}] ${row.provider} — ${row.title || role.title} ${t.statusActivity(relativeAgo(row.updatedAtMs, nowMs))}${taskText}${helpersText}`,
                  );
                }
              }
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team template … ── */
        "template list": cliCommand({
          summary: "List team templates (built-in and yours)",
          options: { json: JSON_OPTION },
          async run(input) {
            const { lang, m } = await loadLang();
            const templates = await allTemplates(lang);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, templates }) };
            return {
              exitCode: 0,
              stdout: [
                m.templatesTitle,
                ...templates.map((tpl) =>
                  m.templateLine(tpl.id, tpl.title, tpl.roles.map((r) => r.name).join(", "), Boolean(tpl.builtin)),
                ),
              ].join("\n"),
            };
          },
        }),

        "template show": cliCommand({
          summary: "Print a template as YAML (roles with their prompts)",
          positionals: [{ name: "id", required: true, description: "Template id" }],
          options: { json: JSON_OPTION },
          async run(input) {
            const { lang, m } = await loadLang();
            const template = await getTemplate(input.positionals.id!, lang, m);
            const full = {
              ...template,
              roles: template.roles.map((r) => ({ ...r, prompt: r.prompt ?? builtinPromptFor(lang, r) })),
            };
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, template: full }) };
            return { exitCode: 0, stdout: dumpYaml(full, { lineWidth: 120 }).slice(0, 60_000) };
          },
        }),

        "template save": cliCommand({
          summary: "Save a template: from a team, from another template, or new from role kinds",
          positionals: [{ name: "id", required: true, description: "Template id (lowercase, digits, hyphens)" }],
          options: {
            title: { type: "string", description: "Template title" },
            "from-team": { type: "string", description: "Copy a team of the project", placeholder: "<team>" },
            project: PROJECT_OPTION,
            "from-template": { type: "string", description: "Copy another template", placeholder: "<id>" },
            kinds: {
              type: "string",
              description: `New from role kinds, the first is the lead: e.g. lead,developer,junior,tester`,
              placeholder: "<k1,k2,…>",
            },
            json: JSON_OPTION,
          },
          constraints: [{ kind: "exactly-one", options: ["from-team", "from-template", "kinds"] }],
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const id = input.positionals.id!;
            core.assertTeamName(id);
            let template: TeamTemplate;
            if (input.options.kinds) {
              const kinds = input.options.kinds.split(",").map((k) => k.trim()).filter(Boolean);
              template = newTemplateFromKinds(lang, id, input.options.title ?? id, kinds);
            } else if (input.options["from-template"]) {
              const base = await getTemplate(input.options["from-template"], lang, m);
              template = {
                id,
                title: input.options.title ?? base.title,
                ...(base.description ? { description: base.description } : {}),
                roles: base.roles.map((r) => ({ ...r, prompt: r.prompt ?? builtinPromptFor(lang, r) })),
              };
            } else {
              const scope = await resolveScope({ project: input.options.project, team: input.options["from-team"] }, ctx, t);
              const loaded = await readTeamConfig(bb, scope, scope.team, t);
              ({ template } = await templateFromConfig(
                scope,
                loaded,
                lang,
                t,
                id,
                input.options.title ?? loaded.config.title ?? scope.team,
              ));
            }
            await saveUserTemplate(template, m);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, template }) };
            return { exitCode: 0, stdout: m.templateSaved(id) };
          },
        }),

        "template delete": cliCommand({
          summary: "Delete one of your templates",
          positionals: [{ name: "id", required: true, description: "Template id" }],
          options: { json: JSON_OPTION },
          async run(input) {
            const { m } = await loadLang();
            await deleteUserTemplate(input.positionals.id!, m);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ok: true }) };
            return { exitCode: 0, stdout: m.templateDeleted(input.positionals.id!) };
          },
        }),
      },
    }),
  );
}

function builtinPromptFor(lang: Language, role: TemplateRole): string {
  return builtinPrompt(lang, role);
}
