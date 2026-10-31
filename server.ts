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
  type BbPluginApi,
  type PluginMentionItem,
} from "@get-bb/plugin-sdk";
import { dump as dumpYaml } from "js-yaml";
import { z } from "zod";
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
import { renderReportHtml, renderReportMarkdown } from "./report";
import {
  TASK_STATUSES,
  currentTask,
  relativeAgo,
  type Language,
  type SnapshotRole,
  type SnapshotThread,
  type TaskStatus,
  type TeamSnapshot,
  type TeamTask,
} from "./snapshot";
import { strings, type Strings } from "./strings";
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

export function parseTaskId(value: string): number {
  const id = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) {
    throw new PluginCliError(`task id must be a positive number: "${value}"`, {
      code: "invalid_value",
    });
  }
  return id;
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
    }),
  },
  templateSave: {
    input: z.object({ template: templateSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  templateDelete: {
    input: z.object({ id: teamSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
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
    output: z.object({ task: taskSchema, sentTo: z.string().nullable() }),
  },
  taskUpdate: {
    input: z
      .object({
        projectId: projectIdSchema,
        team: teamSchema,
        id: z.number().int().positive(),
        status: z.enum(TASK_STATUSES),
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

  const settings = bb.settings.define({
    language: {
      type: "select",
      options: ["en", "ru"],
      default: "en",
      label: "Language / Язык",
      description: "CLI output, panel and template language: en (English) or ru (Русский)",
    },
    teamSection: {
      type: "boolean",
      default: true,
      label: "Team sidebar sections",
      description: "Keep each team's threads in its own sidebar section (Team · <name>)",
    },
    roster: {
      type: "boolean",
      default: true,
      label: "Send team roster",
      description: "Send the team roster message to the lead after bb team create",
    },
    titleFormat: {
      type: "string",
      default: DEFAULT_TITLE_FORMAT,
      label: "Thread title format",
      description:
        "Title of team threads: {team} and {role} placeholders; {team} is dropped while the project has one team",
    },
  });

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

  const readTasks = async (scope: Scope): Promise<TaskStore> =>
    normalizeTaskStore(await bb.storage.kv.get(taskKey(scope.projectId, scope.team)));
  const writeTasks = async (scope: Scope, store: TaskStore): Promise<void> => {
    await bb.storage.kv.set(taskKey(scope.projectId, scope.team), store);
    publishChange(scope.projectId);
  };
  const asCliError = (error: unknown): never => {
    if (error instanceof TaskError) throw new PluginCliError(error.message, { code: error.code });
    throw error;
  };

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

  bb.experimental_hooks.on("message.dispatch", (ctx) =>
    pauseDecision(
      ctx.thread.id,
      { initiator: ctx.initiator, originPluginId: ctx.originPluginId },
      bb.pluginId,
      pausedThreads,
      messages(currentLang).pauseWaitReason,
    ),
  );

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

  const resume = async (scope: Scope): Promise<number | null> => {
    const existing = await readPause(scope);
    if (!existing) return null;
    await bb.storage.kv.delete(pauseKey(scope));
    for (const id of existing.threadIds) pausedThreads.delete(id);
    await bb.experimental_hooks.recheck("message.dispatch");
    publishChange(scope.projectId);
    return existing.threadIds.length;
  };

  /* ── Messages to roles ── */

  const tellRole = async (
    scope: Scope,
    wantedRole: string,
    text: string,
    t: Strings,
    senderThreadId?: string,
  ) => {
    const { rows } = await teamContext(scope, t);
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
  };

  /* ── Work package operations (CLI + panel) ── */

  const addPackage = async (
    scope: Scope,
    input: { role: string; title: string; note: string | null; send: boolean },
    t: Strings,
    m: Messages,
    senderThreadId?: string,
  ): Promise<{ task: TeamTask; sentTo: string | null; busy: TeamTask[] }> => {
    const { loaded, rows, lead } = await teamContext(scope, t);
    const roles = new Set([...rows.keys(), ...(loaded?.config.roles.map((r) => r.name) ?? [])]);
    if (!roles.has(input.role)) {
      const err = m.taskRoleUnknown(input.role);
      throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
    }
    const target = rows.get(input.role)?.[0] ?? null;
    if (input.send && !target) {
      const err = m.taskNoThread(input.role);
      throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
    }
    let store = await readTasks(scope);
    const busy = busyTasks(store, input.role);
    let task: TeamTask;
    try {
      ({ store, task } = addTask(
        store,
        {
          role: input.role,
          title: input.title,
          note: input.note,
          status: input.send ? "in-progress" : "todo",
        },
        Date.now(),
      ));
    } catch (error) {
      return asCliError(error);
    }
    await writeTasks(scope, store);
    let sentTo: string | null = null;
    if (input.send && target) {
      const leadThread = lead && lead !== input.role ? rows.get(lead)?.[0]?.threadId : null;
      await bb.sdk.threads.send({
        originPluginId: bb.pluginId,
        ...(senderThreadId && senderThreadId !== target.threadId ? { senderThreadId } : {}),
        threadId: target.threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: m.taskBody(task.id, task.title, task.note, leadThread ? `@thread:${leadThread}` : null),
            mentions: [],
          },
        ],
      });
      sentTo = target.threadId;
    }
    return { task, sentTo, busy };
  };

  const updatePackage = async (
    scope: Scope,
    id: number,
    patch: { status?: TaskStatus; title?: string; note?: string | null },
  ): Promise<{ task: TeamTask; previous: TeamTask; busy: TeamTask[] }> => {
    const store = await readTasks(scope);
    try {
      const result = updateTask(store, id, patch, Date.now());
      await writeTasks(scope, result.store);
      const busy =
        patch.status === "in-progress" ? busyTasks(result.store, result.task.role, result.task.id) : [];
      return { task: result.task, previous: result.previous, busy };
    } catch (error) {
      return asCliError(error);
    }
  };

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
    for (const role of roles) {
      if (!wanted(role)) continue;
      const already = existing.get(role.name);
      if (role.threadId || (already && already.length > 0)) {
        plan.push({ role, environment: null, prompt: "" });
        continue;
      }
      plan.push({
        role,
        environment: await resolveEnvironment(bb, scope, roleEnvironmentSpec(role, config), t),
        prompt: await loadRolePrompt(bb, scope, role, role.name === lead.name, lang, t),
      });
    }

    const sectionId = settingsValues.teamSection
      ? await ensureSection(bb, teamSectionName(t, scope.team))
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
    return { source, leadThreadId, sectionId, spawned, existing, rosterQueued };
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
    if (loaded.config.roles.some((role) => role.name === input.name)) {
      const err = m.roleExists(input.name, scope.team);
      throw new PluginCliError(err.message, { code: "role_exists", hint: err.hint });
    }
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
    if (input.environment) entry.environment = input.environment;
    if (input.notifyOn?.length) entry.notifyOn = input.notifyOn;
    if (input.threadId) {
      entry.threadId = input.threadId;
    } else if (input.prompt) {
      const rel = `${layout.promptDir}/${input.name}.md`;
      await writeWorkspaceFile(bb, scope, rel, `${input.prompt.trim()}\n`);
      entry.promptFile = rel;
    }

    const raw = (await readFileOrNull(bb, scope, loaded.source)) ?? "";
    let rewritten = false;
    let next: string;
    if (loaded.source.endsWith(".json")) {
      const parsed = JSON.parse(raw) as { roles: unknown[] };
      parsed.roles.push(entry);
      next = `${JSON.stringify(parsed, null, 2)}\n`;
    } else {
      const appended = appendRoleToYaml(raw, entry);
      if (appended) {
        next = appended;
      } else {
        rewritten = true;
        next = dumpYaml({ ...loaded.config, roles: [...loaded.config.roles, entry] }, { lineWidth: 120 });
      }
    }
    core.parseTeamConfig(next, loaded.source, t); // never write a config that does not parse
    await writeWorkspaceFile(bb, scope, loaded.source, next);
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
    const teams = await listConfiguredTeams(bb, scope);
    if (teams.includes(scope.team) && !options.force) {
      const err = m.teamExists(scope.team);
      throw new PluginCliError(err.message, { code: "team_exists", hint: err.hint });
    }
    await validateProviders(bb, template.roles.filter((r) => r.enabled !== false), t);
    const files = teamFilesFromTemplate(lang, template, scope.team);
    const written = await writeTeamFiles(scope, files, options.force, t);
    await setVersioned(scope, false, options.versioned);
    const result = options.spawn ? await spawnTeam(scope, lang, t, m) : null;
    return { written, result };
  };

  /* ── Snapshot (status, report, panel) ── */

  const buildSnapshot = async (scope: Scope, t: Strings): Promise<TeamSnapshot> => {
    const { loaded, configError, lead, scan, rows, helpers } = await teamContext(scope, t);
    const store = await readTasks(scope);
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
    return {
      projectId: scope.projectId,
      projectName: scope.projectName,
      team: scope.team,
      teamTitle: loaded?.config.title ?? null,
      teams: await allTeams(scope, scan),
      versioned: version ? version.versioned : null,
      versioningBlocked: version ? version.blocked : false,
      configSource: loaded?.source ?? null,
      configError,
      leadRole: lead,
      paused,
      roles,
      generatedAtMs: Date.now(),
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
    publishChange(thread.projectId);
    if (kind === "other" || mark.helper || !thread.parentThreadId) return;
    const notifyOn = Array.isArray(meta.teamNotifyOn) ? meta.teamNotifyOn : [];
    if (!notifyOn.includes(kind)) return;
    const m = messages(currentLang);
    const text =
      kind === "idle"
        ? m.notifyIdle(mark.role, thread.id, excerpt(detail))
        : m.notifyError(mark.role, thread.id, excerpt(detail, 300));
    await bb.sdk.threads.send({
      originPluginId: bb.pluginId,
      threadId: thread.parentThreadId,
      mode: "queue-if-active",
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

  bb.events.on("thread.created", ({ thread }) => onThreadCreated(thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    onTeamThreadEvent(thread, "idle", lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) => onTeamThreadEvent(thread, "error", error));
  bb.events.on("thread.active", ({ thread }) => onTeamThreadEvent(thread, "other", null));
  bb.events.on("thread.archived", ({ thread }) => onTeamThreadEvent(thread, "other", null));

  /* ── RPC ── */

  const kindsList = (lang: Language) =>
    ROLE_KINDS.map((kind) => ({ kind, title: kindTitle(lang, kind) }));

  bb.rpc.register(rpcContract, {
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
      return { templates: await allTemplates(lang), kinds: kindsList(lang), language: lang };
    },
    async templateSave({ template }) {
      const { m } = await loadLang();
      await saveUserTemplate(template, m);
      return { ok: true };
    },
    async templateDelete({ id }) {
      const { m } = await loadLang();
      await deleteUserTemplate(id, m);
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
      return { task: result.task, sentTo: result.sentTo };
    },
    async taskUpdate({ projectId, team, id, status }) {
      const { t } = await loadLang();
      const scope = await scopeFor(projectId, team, t);
      return { task: (await updatePackage(scope, id, { status })).task };
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
              description: "Template id: dev (default), qa, docs, product, or your own (bb team template list)",
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
              templateId = input.options.template ?? "dev";
              template = await getTemplate(templateId, lang, m);
            }
            const teams = await listConfiguredTeams(bb, workspace);
            if (teams.includes(team) && !input.options.force) {
              const err = m.teamExists(team);
              throw new PluginCliError(err.message, { code: "team_exists", hint: err.hint });
            }
            const files = teamFilesFromTemplate(lang, template, team, {
              vars,
              ...(defaults ? { defaults: defaults as Record<string, unknown> } : {}),
            });
            const written = await writeTeamFiles(scope, files, Boolean(input.options.force), t);
            const version = await setVersioned(scope, false, Boolean(input.options.versioned));
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
                  busy: result.busy.map((task) => task.id),
                }),
              };
            }
            const out = [m.taskAdded(result.task.id, result.task.role, result.task.title)];
            out.push(`  ${m.taskStatusLine(result.task.status)}`);
            if (result.sentTo) out.push(`  ${m.taskSent(result.task.role, result.sentTo)}`);
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
          summary: "Change a work package: status, title or note",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            status: { type: "string", description: `New status: ${TASK_STATUSES.join(" | ")}`, placeholder: "<status>" },
            title: { type: "string", description: "New title" },
            note: { type: "string", description: "New note (empty string clears it)", stdin: true },
            json: JSON_OPTION,
          },
          constraints: [{ kind: "at-least-one", options: ["status", "title", "note"] }],
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            let status: TaskStatus | undefined;
            try {
              status = input.options.status ? parseTaskStatus(input.options.status) : undefined;
            } catch (error) {
              return asCliError(error);
            }
            const result = await updatePackage(scope, parseTaskId(input.positionals.id!), {
              status,
              title: input.options.title,
              note: input.options.note,
            });
            return taskOutput(result, input.options.json, scope, m);
          },
        }),

        "task done": cliCommand({
          summary: "Accept a work package (status done)",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: { project: PROJECT_OPTION, team: TEAM_OPTION, json: JSON_OPTION },
          async run(input, ctx) {
            const { t, m } = await loadLang();
            const scope = await resolveScope(input.options, ctx, t);
            const result = await updatePackage(scope, parseTaskId(input.positionals.id!), { status: "done" });
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
            let next: TaskStore;
            try {
              ({ store: next } = removeTask(await readTasks(scope), id));
            } catch (error) {
              return asCliError(error);
            }
            await writeTasks(scope, next);
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
          summary: "Move a role onto a fresh thread: handoff of its last report and open packages",
          positionals: [{ name: "role", required: true, description: "Role name" }],
          options: {
            project: PROJECT_OPTION,
            team: TEAM_OPTION,
            thread: { type: "string", description: "The thread to replace when the role has several", placeholder: "<thr_…>" },
            keep: { type: "boolean", description: "Keep the old thread (unbound from the role) instead of archiving it" },
            "dry-run": { type: "boolean", description: "Show the plan without changing anything" },
            json: JSON_OPTION,
          },
          async run(input, ctx) {
            const { lang, t, m } = await loadLang();
            const settingsValues = await settings.get();
            const scope = await resolveScope(input.options, ctx, t);
            const roleName = input.positionals.role!;
            const { config } = await readTeamConfig(bb, scope, scope.team, t);
            const { lead, roles } = core.semanticChecks(config, t);
            const role = roles.find((r) => r.name === roleName);
            if (!role) {
              const err = m.taskRoleUnknown(roleName);
              throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
            }
            const scan = await scanTeamThreads(bb, scope.projectId);
            const rows = roleThreadsOf(scan, scope.team);
            const list = rows.get(roleName) ?? [];
            let old: TeamThreadRow | undefined;
            if (input.options.thread) {
              old = list.find((row) => row.threadId === input.options.thread);
              if (!old) {
                throw new PluginCliError(m.replaceThreadMismatch(roleName, input.options.thread), {
                  code: "thread_not_found",
                });
              }
            } else if (list.length === 0) {
              const err = m.replaceNoThread(roleName);
              throw new PluginCliError(err.message, { code: "thread_not_found", hint: err.hint });
            } else if (list.length > 1) {
              const err = m.replaceAmbiguous(roleName, list.map((row) => row.threadId).join(", "));
              throw new PluginCliError(err.message, { code: "thread_ambiguous", hint: err.hint });
            } else {
              old = list[0]!;
            }
            const isLead = role.name === lead.name;
            if (input.options["dry-run"]) {
              if (input.options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ ok: true, dryRun: true, role: roleName, oldThreadId: old.threadId }),
                };
              }
              return { exitCode: 0, stdout: m.replacePlan(roleName, old.threadId) };
            }
            await validateProviders(bb, [role], t);
            const environment = await resolveEnvironment(bb, scope, roleEnvironmentSpec(role, config), t);
            let output: string | null = null;
            try {
              output = excerpt((await bb.sdk.threads.output({ threadId: old.threadId })).output, 4000);
            } catch {
              output = null;
            }
            const taskLines = listTasks(await readTasks(scope), { role: roleName })
              .map((task) => `- #${task.id} ${task.title} [${task.status}]`)
              .join("\n");
            const roleThreads = new Map<string, string>();
            for (const [name, threads] of rows) if (threads[0]) roleThreads.set(name, threads[0].threadId);
            const leadThreadId = isLead ? null : roleThreads.get(lead.name) ?? null;
            const rawPrompt = await loadRolePrompt(bb, scope, role, isLead, lang, t);
            const prompt =
              core.applyPlaceholders(
                rawPrompt,
                { workspace: scope, leadThreadId, roleThreads, teamVars: config.vars, teamName: scope.team },
                t,
              ) + m.replaceHandoff(`@thread:${old.threadId}`, output, taskLines);
            const sectionId = settingsValues.teamSection
              ? await ensureSection(bb, teamSectionName(t, scope.team))
              : null;
            const defaults = config.defaults ?? {};
            const spawnArgs = {
              projectId: scope.projectId,
              title: await threadTitle(scope, role.title ?? role.name, scan),
              providerId: role.provider,
              model: role.model,
              reasoningLevel: role.reasoningLevel,
              serviceTier: role.serviceTier,
              permissionMode: role.permissionMode ?? defaults.permissionMode,
              environment,
              sectionId,
              parentThreadId: leadThreadId ?? undefined,
              parentNotifications: leadThreadId ? role.parentNotifications ?? defaults.parentNotifications : undefined,
              pluginMetadata: teamMetadata(role, scope.team),
              prompt,
            };
            let fresh: Awaited<ReturnType<typeof bb.sdk.threads.spawn>>;
            try {
              fresh = await bb.sdk.threads.spawn(spawnArgs);
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              try {
                fresh = await bb.sdk.threads.spawn(spawnArgs);
              } catch (error) {
                const err = t.spawnFailed(roleName, (error as Error).message);
                throw new PluginCliError(err.message, { code: "spawn_failed", hint: err.hint });
              }
            }
            await bb.sdk.threads.updatePluginMetadata({
              threadId: old.threadId,
              remove: ["teamRole", "teamName", "teamNotifyOn"],
            });
            let reparented = 0;
            if (isLead) {
              for (const row of scan.rows) {
                if (row.parentThreadId !== old.threadId || row.threadId === old.threadId) continue;
                await bb.sdk.threads.update({ threadId: row.threadId, parentThreadId: fresh.id });
                reparented += 1;
              }
            }
            if (!input.options.keep) await bb.sdk.threads.archive({ threadId: old.threadId });
            const pauseState = await readPause(scope);
            if (pauseState?.threadIds.includes(old.threadId)) {
              const threadIds = pauseState.threadIds.map((id) => (id === old!.threadId ? fresh.id : id));
              await bb.storage.kv.set(pauseKey(scope), { ...pauseState, threadIds });
              pausedThreads.delete(old.threadId);
              pausedThreads.add(fresh.id);
            }
            if (!isLead && leadThreadId) {
              await bb.sdk.threads.send({
                originPluginId: bb.pluginId,
                threadId: leadThreadId,
                mode: "queue-if-active",
                input: [
                  {
                    type: "text",
                    text: m.replaceLeadNotice(roleName, `@thread:${old.threadId}`, `@thread:${fresh.id}`),
                    mentions: [],
                  },
                ],
              });
            }
            publishChange(scope.projectId);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  team: scope.team,
                  role: roleName,
                  oldThreadId: old.threadId,
                  newThreadId: fresh.id,
                  archived: !input.options.keep,
                  reparented,
                  configBindsOld: role.threadId === old.threadId,
                }),
              };
            }
            const out = [m.replaceDone(roleName, old.threadId, fresh.id)];
            out.push(input.options.keep ? m.replaceKept(old.threadId) : m.replaceArchived(old.threadId));
            if (reparented > 0) out.push(m.replaceReparented(reparented));
            if (role.threadId === old.threadId) out.push(m.replaceConfigNote(roleName, old.threadId));
            return { exitCode: 0, stdout: out.join("\n") };
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
