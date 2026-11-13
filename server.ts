import { verifyQuotaBoundary } from "./checkpoint";
import { ResourceControl, resourcePolicySchema, withResourceResults, confirmedQuota, type ResourceOwner, type ResourceSummary } from "./resource-control";
import { executionPolicySchema, withExecutionProfile, type ExecutionFallbackSelection } from "./execution-policy";
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
import { contextView, sessionViewSchema, type SessionView } from "./session-view";
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
import { messages, type Messages } from "./messages";
import {
  GENERATOR_SELECTION_KV_KEY,
  generalSettingDescriptors,
  generatorSelectionSchema,
  languageSettingDescriptor,
  parseGeneratorSelection,
  settingsMessages,
  type GeneratorSelection,
} from "./settings-localization";
import { renderReportHtml, renderReportMarkdown } from "./report";
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
} from "./snapshot";
import { strings, type Strings } from "./strings";
import { createTaskTracker, isTrackerAbsentError } from "./tracker";
import { captureCheckpoint, verifyCheckpoint, workCheckpointSchema } from "./checkpoint";
import { acceptanceGate, latestDecision, type AcceptanceCaller, type AcceptanceDecision } from "./review";
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
} from "./templates";

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
  sessionView: {
    input: z.object({ projectId: projectIdSchema, team: teamSchema, role: z.string().min(1).max(100) }).strict(),
    output: sessionViewSchema,
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
    input:z.object({projectId:projectIdSchema,team:teamSchema,role:z.string(),primary:templateRoleSchema.pick({provider:true,model:true,reasoningLevel:true,serviceTier:true}).strict().optional(),policy:executionPolicySchema.nullable().optional(),expectedRevision:z.string().optional()}).strict(),
    output:z.object({role:templateRoleSchema,source:z.string(),revision:z.string()}),
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
    return {projectId:first.projectId,team:mark.team,role:mark.role,taskId:bound??null,ownerThreadId,hostId};
  };
  const resources=new ResourceControl(bb,resourceOwner,publishChange);

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
    return resources.admit(ctx);
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
    if (await readPause(scope)) return;
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
    const {task} = await tracker.update(scope, next.id, {status: "in-progress"});
    await deliverPackage(scope, task, target, lead);
  };

  const addPackage = async (
    scope: Scope,
    input: { role: string; title: string; note: string | null; send: boolean },
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
      const task = await tracker.add(scope, {...input, status: send ? "in-progress" : "todo"});
      let sentTo: string | null = null, sendError: string | null = null;
      if (send && target) {
        try { await deliverPackage(scope, task, target, lead, senderThreadId); sentTo = target.threadId; }
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
    options: { keep?: boolean; pending?: ReplacementIntent | null; execution?: ExecutionFallbackSelection } = {},
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
    const stillApproved=savedSelection&&configuredRole.executionPolicy?.fallbacks.some(c=>JSON.stringify(c)===JSON.stringify(savedSelection));
    const pendingQuota=(await resources.inspect(scope)).fallbacks.find(f=>f.threadId===oldThreadId&&f.selection&&f.stage!=="complete");
    const quotaApproved=pendingQuota?.selection&&configuredRole.executionPolicy?.fallbacks.some(c=>JSON.stringify(c)===JSON.stringify(pendingQuota.selection));
    const execution=options.execution??(quotaApproved?pendingQuota!.selection!:oldMeta.teamConfiguredExecution===configuredExecution&&stillApproved?savedSelection:undefined);
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
      + (continuing ? `\nThis is a task handoff, not initial setup. Resume checkpoint nextAction for task ${checkpoint.taskId} now. If it is in review, wait for lead acceptance. Do not pick another package; other packages remain queued.` : "\nThe checkpoint task is already accepted or cancelled. Do not execute it again. Confirm readiness and wait for the next queued assignment.")
      + `\nRoute messages by role: bb team tell <role> --message-file -. The lead role is ${lead.name}. Earlier direct thread addresses are superseded.`;
    const defaults = config.defaults ?? {};
    const sectionId = settingsValues.teamSection ? await ensureSection(bb,teamSectionName(t,scope.team),[strings("en"),strings("ru")].map(x=>teamSectionName(x,scope.team))) : null;
    const result = await replaceSession(bb, {
      projectId:scope.projectId, team:scope.team, role:roleName,
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
        pluginMetadata:{...teamMetadata(role,scope.team),...(execution?{teamExecution:execution,teamConfiguredExecution:configuredExecution}:{})}, prompt,
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
      if (await readPause(scope)) return; // resume() retries
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
      view.phase = intent.stage === "spawn_uncertain" ? "error" : "replacing";
      view.blockedReason = "replacement_pending";
    }
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

  // Restart safety: advance durable auto-continue requests that survived a
  // plugin restart; their event triggers may have fired while it was down.
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
  ) => {
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
        pluginMetadata: teamMetadata(entry.role, scope.team),
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
  };

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

  /* ── Snapshot (status, report, panel) ── */

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
    const resourceSummary=withResourceResults(await resources.inspect(scope),store.tasks);
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
      });
      const active=role.threads.some(thread=>thread.status==="active"||thread.status==="starting");
      const task=role.tasks.find(task=>task.status==="in-progress"||task.status==="review");
      const resourceReason=resourceSummary.blocked??resourceSummary.holds[task?`task:${task.id}`:`role:${role.name}`];
      if(!active&&resourceReason&&executionState?.kind!=="error")executionState={kind:"error",taskId:task?.id??null,errorCode:"resource_hold",errorMessage:resourceReason,safeAction:"Inspect Team resources and record a concrete decision; replacing the session cannot reset the budget",atMs:Date.now()};
      withExecutionState.push(executionState ? {...role, executionState} : role);
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
      generatedAtMs: Date.now(),
      tracker: (await tracker.getConfig(scope)).kind,
      trackerError,
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
        for (const role of roles) {
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
    if ((await readPause(scope)) !== null) add(m.check.threads, "warn", m.doctorPaused);
    return checks;
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
    const candidates:ExecutionFallbackSelection[]=[];
    if(confirmedQuota(failure)&&configuredCandidates.length){
      const old=await bb.sdk.threads.get({threadId:failure.threadId});
      const catalogs=new Map<string,Awaited<ReturnType<typeof bb.sdk.providers.models>>|null>();
      if(old.environmentId)for(const candidate of configuredCandidates){
        if(candidate.provider===old.providerId)continue; // Exhausted provider/account scope.
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
    const plan=await resources.failed(failure,candidates);if(!plan)return;
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
    if(entry.waitingOn?.kind==="plugin"&&entry.waitingOn.pluginId===bb.pluginId&&entry.waitingOn.reason.startsWith("Team resources:")){
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
    async sessionView({ projectId, team, role }) {
      const { t } = await loadLang();
      return readSessionView(await scopeFor(projectId, team, t), role, t);
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
    async rolePolicy({projectId,team,role:roleName,primary,policy,expectedRevision}) {
      const {t}=await loadLang(); const scope=await scopeFor(projectId,team,t);
      return withScopeLock(scope,async()=>{
        const loaded=await readTeamConfig(bb,scope,team,t);
        const raw=await readFileOrNull(bb,scope,loaded.source);
        if(raw===null) throw new PluginCliError("Team config is unavailable",{code:"not_found"});
        const revision=createHash("sha256").update(raw).digest("hex");
        const role=loaded.config.roles.find(r=>r.name===roleName);
        if(!role) throw new PluginCliError("Role is not in the team config",{code:"not_found"});
        if(policy===undefined && primary===undefined) return {role,source:loaded.source,revision};
        if(expectedRevision!==revision) throw new PluginCliError("Team config changed; reopen the profile before saving",{code:"conflict"});
        const parsed=(loaded.source.endsWith(".json")?JSON.parse(raw):loadYaml(raw)) as {roles:Array<Record<string,unknown>>};
        const entry=parsed.roles.find(r=>r.name===roleName)!;
        if(primary!==undefined) for(const key of ["provider","model","reasoningLevel","serviceTier"] as const) {
          delete entry[key]; if(primary[key]!==undefined) entry[key]=primary[key];
        }
        if(policy===null) delete entry.executionPolicy; else if(policy!==undefined) entry.executionPolicy=policy;
        const next=loaded.source.endsWith(".json")?`${JSON.stringify(parsed,null,2)}\n`:dumpYaml(parsed,{lineWidth:120,noRefs:true});
        core.parseTeamConfig(next,loaded.source,t);
        await writeWorkspaceFile(bb,scope,loaded.source,next);publishChange(projectId);
        const updated=core.parseTeamConfig(next,loaded.source,t).roles.find(r=>r.name===roleName)!;
        return {role:updated,source:loaded.source,revision:createHash("sha256").update(next).digest("hex")};
      });
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
    async taskAdd({ projectId, team, role, title, note, send }) {
      const { t, m } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      const result = await addPackage(scope, { role, title, note: note ?? null, send }, t, m);
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
                if (!pending) throw new PluginCliError("No unfinished replacement to abort",{code:"replacement_missing"});
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
