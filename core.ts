// Core of bb-plugin-team: workspace and team resolution, config reading,
// thread scanning (roles + helpers), environments, prompts, providers.
// SDK-dependent helpers live here so server.ts stays the plugin wiring.

import { PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import type { Language } from "./snapshot";
import type { Strings } from "./strings";
import {
  CONFIG_PATH,
  DEFAULT_TEAM,
  LEGACY_CONFIG_JSON,
  ROLE_NAME_RE,
  TEAMS_DIR,
  TEAM_NAME_RE,
  builtinPrompt,
  teamLayout,
} from "./templates";

/* ──────────────────────── Types ──────────────────────── */

type Sdk = BbPluginApi["sdk"];
export type SpawnEnvironment = NonNullable<Parameters<Sdk["threads"]["spawn"]>[0]>["environment"];
export type ThreadDto = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

export interface Workspace {
  projectId: string;
  projectName: string;
  /** Absolute project checkout path without a trailing `/`. */
  path: string;
  hostId: string;
}

/* ──────────────────────── Config schema ──────────────────────── */

const PARENT_NOTIFICATIONS = ["auto", "stuck", "off"] as const;
const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export const NOTIFY_EVENTS = ["idle", "error"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const roleSchema = z.object({
  name: z.string().regex(ROLE_NAME_RE, "role name: lowercase letters, digits, hyphens"),
  /** Role kind for the built-in prompt (lead, developer, junior, tester, …). */
  kind: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningLevel: z
    .enum(["low", "medium", "high", "xhigh", "max", "none", "ultra", "ultracode"])
    .optional(),
  serviceTier: z.string().trim().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  environment: z.string().trim().min(1).optional(),
  parentNotifications: z.enum(PARENT_NOTIFICATIONS).optional(),
  lead: z.boolean().optional(),
  enabled: z.boolean().optional(),
  /** Existing thread id: adopt it instead of spawning a new thread. */
  threadId: z.string().trim().regex(/^thr_/, "thread id must start with thr_").optional(),
  /** Wake the lead on these lifecycle events of the role's thread. */
  notifyOn: z.array(z.enum(NOTIFY_EVENTS)).optional(),
  prompt: z.string().optional(),
  promptFile: z.string().optional(),
});

export const teamConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Human title of the team (the file name is its id). */
  title: z.string().trim().min(1).max(120).optional(),
  /** Project constants for {{vars.<name>}} in prompts and environments. */
  vars: z
    .record(
      z.string().regex(/^[A-Za-z0-9_-]+$/, "var name: letters, digits, _ and -"),
      z.union([z.string(), z.number(), z.boolean()]),
    )
    .optional(),
  defaults: z
    .object({
      environment: z.string().trim().min(1).optional(),
      parentNotifications: z.enum(PARENT_NOTIFICATIONS).optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
    })
    .optional(),
  roles: z.array(roleSchema).min(1),
});

export type Role = z.infer<typeof roleSchema>;
export type TeamConfig = z.infer<typeof teamConfigSchema>;

/* ──────────────────────── Paths ──────────────────────── */

export function joinPath(workspace: string, rel: string): string {
  return rel.startsWith("/")
    ? rel
    : `${workspace}/${rel.replace(/^\.\//, "").replace(/^\/+/, "")}`;
}

export function requireInsideWorkspace(workspace: string, abs: string): void {
  if (abs !== workspace && !abs.startsWith(`${workspace}/`)) {
    throw new PluginCliError(`path "${abs}" escapes the workspace ${workspace}`, {
      code: "path_outside_workspace",
    });
  }
}

export function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export async function readFileOrNull(
  bb: BbPluginApi,
  workspace: Workspace,
  rel: string,
): Promise<string | null> {
  try {
    const file = await bb.sdk.files.read({
      hostId: workspace.hostId,
      path: joinPath(workspace.path, rel),
      rootPath: workspace.path,
    });
    return file.content;
  } catch {
    return null;
  }
}

export async function writeWorkspaceFile(
  bb: BbPluginApi,
  workspace: Workspace,
  rel: string,
  content: string,
): Promise<void> {
  const abs = joinPath(workspace.path, rel);
  requireInsideWorkspace(workspace.path, abs);
  await bb.sdk.files.write({
    hostId: workspace.hostId,
    path: abs,
    rootPath: workspace.path,
    content,
    createParents: true,
  });
}

/* ──────────────────────── Workspace (project) ──────────────────────── */

export interface ProjectSourceCandidate {
  projectId: string;
  projectName: string;
  path: string;
  hostId: string;
}

/** Longest-path match of cwd against project sources on the given host. */
export function findSourceByPath(
  cwd: string,
  candidates: ProjectSourceCandidate[],
  hostId: string | null,
): ProjectSourceCandidate | null {
  let best: ProjectSourceCandidate | null = null;
  for (const candidate of candidates) {
    if (hostId !== null && candidate.hostId !== hostId) continue;
    const path = candidate.path.replace(/\/+$/, "");
    if (cwd !== path && !cwd.startsWith(`${path}/`)) continue;
    if (!best || path.length > best.path.replace(/\/+$/, "").length) best = candidate;
  }
  return best;
}

export async function resolveWorkspace(
  bb: BbPluginApi,
  projectArg: string | undefined,
  ctxProjectId: string | undefined,
  t: Strings,
  ctx: { cwd?: string; threadId?: string },
): Promise<Workspace> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const explicit = projectArg ?? ctxProjectId;
  if (explicit) {
    const found = projects.find((p) => p.id === explicit || p.name === explicit);
    if (!found) {
      const err = t.projectNotFound(explicit);
      throw new PluginCliError(err.message, { code: "project_not_found", hint: err.hint });
    }
    const source = found.sources.find((s) => s.isDefault) ?? found.sources[0];
    if (!source) {
      throw new PluginCliError(t.projectSourceMissing(found.name), {
        code: "project_source_missing",
      });
    }
    return {
      projectId: found.id,
      projectName: found.name,
      path: source.path.replace(/\/+$/, ""),
      hostId: source.hostId,
    };
  }

  // No explicit project: resolve it from the invoking directory, limited to
  // sources on the invoking machine (nested projects pick the longest path).
  const cwd = ctx.cwd?.replace(/\/+$/, "");
  if (!cwd) {
    throw new PluginCliError(t.projectNotResolved.message, {
      code: "project_not_resolved",
      hint: t.projectNotResolved.hint,
    });
  }
  const hostId = await invokerHost(bb, ctx);
  const candidates: ProjectSourceCandidate[] = projects.flatMap((project) =>
    project.sources.map((source) => ({
      projectId: project.id,
      projectName: project.name,
      path: source.path,
      hostId: source.hostId,
    })),
  );
  const match = findSourceByPath(cwd, candidates, hostId);
  if (!match) {
    const err = t.projectByPathNotFound(cwd);
    throw new PluginCliError(err.message, { code: "project_not_resolved", hint: err.hint });
  }
  return {
    projectId: match.projectId,
    projectName: match.projectName,
    path: match.path.replace(/\/+$/, ""),
    hostId: match.hostId,
  };
}

/** The machine a CLI invocation runs on: the thread's host, else the server. */
export async function invokerHost(
  bb: BbPluginApi,
  ctx: { threadId?: string },
): Promise<string | null> {
  if (ctx.threadId) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        return environment.hostId;
      }
    } catch {
      // fall back to the server host
    }
  }
  try {
    return (await bb.sdk.system.config()).primaryHostId;
  } catch {
    return null;
  }
}

/* ──────────────────────── Teams and configs ──────────────────────── */

export function assertTeamName(team: string): void {
  if (!TEAM_NAME_RE.test(team)) {
    throw new PluginCliError(
      `team name "${team}": lowercase letters, digits and hyphens, up to 32 characters`,
      { code: "invalid_value" },
    );
  }
}

export interface LoadedConfig {
  config: TeamConfig;
  /** Workspace-relative config path. */
  source: string;
  /** The v0.1 single-team file (.bb/team.yaml), read as team "main". */
  legacy: boolean;
}

/** Candidate config files of a team, in priority order. */
export function configCandidates(team: string): Array<{ rel: string; legacy: boolean }> {
  const list = [
    { rel: `${TEAMS_DIR}/${team}.yaml`, legacy: false },
    { rel: `${TEAMS_DIR}/${team}.json`, legacy: false },
  ];
  if (team === DEFAULT_TEAM) {
    list.push({ rel: CONFIG_PATH, legacy: true }, { rel: LEGACY_CONFIG_JSON, legacy: true });
  }
  return list;
}

export function parseTeamConfig(content: string, source: string, t: Strings): TeamConfig {
  let raw: unknown;
  try {
    raw = source.endsWith(".json") ? JSON.parse(content) : loadYaml(content);
  } catch (error) {
    throw new PluginCliError(t.configParseFailed(source, (error as Error).message), {
      code: "config_parse_failed",
    });
  }
  const parsed = teamConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginCliError(t.configInvalid(source, zodIssues(parsed.error)), {
      code: "config_invalid",
    });
  }
  return parsed.data;
}

export async function readTeamConfig(
  bb: BbPluginApi,
  workspace: Workspace,
  team: string,
  t: Strings,
): Promise<LoadedConfig> {
  for (const candidate of configCandidates(team)) {
    const content = await readFileOrNull(bb, workspace, candidate.rel);
    if (content === null) continue;
    return {
      config: parseTeamConfig(content, candidate.rel, t),
      source: candidate.rel,
      legacy: candidate.legacy,
    };
  }
  const err = t.configMissing(team, workspace.projectId);
  throw new PluginCliError(err.message, { code: "config_missing", hint: err.hint });
}

/** Team names that have a config file in the project. */
export async function listConfiguredTeams(
  bb: BbPluginApi,
  workspace: Workspace,
): Promise<string[]> {
  const names = new Set<string>();
  try {
    const listing = await bb.sdk.files.list({
      hostId: workspace.hostId,
      path: joinPath(workspace.path, TEAMS_DIR),
      includeHidden: false,
      limit: 500,
    });
    for (const file of listing.files) {
      const match = /^([a-z0-9][a-z0-9-]{0,31})\.(ya?ml|json)$/.exec(file.path);
      if (match) names.add(match[1]!);
    }
  } catch {
    // no .bb/teams directory
  }
  if (!names.has(DEFAULT_TEAM)) {
    for (const rel of [CONFIG_PATH, LEGACY_CONFIG_JSON]) {
      if ((await readFileOrNull(bb, workspace, rel)) !== null) {
        names.add(DEFAULT_TEAM);
        break;
      }
    }
  }
  return [...names].sort();
}

/** Semantic checks zod cannot express. Returns the lead role. */
export function semanticChecks(config: TeamConfig, t: Strings): { lead: Role; roles: Role[] } {
  const roles = config.roles.filter((r) => r.enabled !== false);
  if (roles.length === 0) {
    throw new PluginCliError(t.allRolesDisabled, { code: "config_invalid" });
  }
  const names = new Set<string>();
  const threadIds = new Set<string>();
  for (const role of roles) {
    if (names.has(role.name)) {
      throw new PluginCliError(t.roleDeclaredTwice(role.name), { code: "config_invalid" });
    }
    if (role.threadId && threadIds.has(role.threadId)) {
      throw new PluginCliError(t.threadBoundTwice(role.threadId), { code: "config_invalid" });
    }
    if (role.threadId) threadIds.add(role.threadId);
    names.add(role.name);
    // A role may omit both prompt and promptFile (built-in prompt), not set both.
    if (role.prompt && role.promptFile) {
      throw new PluginCliError(t.roleNeedsPrompt(role.name), { code: "config_invalid" });
    }
  }
  const explicitLeads = roles.filter((r) => r.lead === true);
  if (explicitLeads.length > 1) {
    throw new PluginCliError(t.multipleLeads(explicitLeads.map((r) => r.name).join(", ")), {
      code: "config_invalid",
    });
  }
  const lead = explicitLeads[0] ?? roles[0]!;
  return { lead, roles };
}

/* ──────────────────────── Environments ──────────────────────── */

export type EnvironmentSpec =
  | { kind: "default" | "checkout" | "worktree" }
  | { kind: "env"; id: string };

export function parseEnvironmentSpec(spec: string, t: Strings): EnvironmentSpec {
  switch (spec) {
    case "default":
    case "checkout":
    case "worktree":
      return { kind: spec };
    default: {
      const match = /^(?:env|reuse):(.+)$/.exec(spec);
      if (!match) {
        const err = t.environmentInvalid(spec);
        throw new PluginCliError(err.message, { code: "environment_invalid", hint: err.hint });
      }
      return { kind: "env", id: match[1]! };
    }
  }
}

export async function resolveEnvironment(
  bb: BbPluginApi,
  workspace: Workspace,
  spec: string,
  t: Strings,
): Promise<SpawnEnvironment> {
  const parsed = parseEnvironmentSpec(spec, t);
  switch (parsed.kind) {
    case "default":
      return { type: "project-default" };
    case "checkout": {
      const envs = await bb.sdk.environments.list({
        projectId: workspace.projectId,
        environmentProviderId: "project-checkout",
      });
      const target = envs.find((e) => e.status === "ready") ?? envs[0];
      if (!target) {
        const err = t.checkoutMissing(workspace.projectId);
        throw new PluginCliError(err.message, { code: "environment_not_found", hint: err.hint });
      }
      return { type: "reuse", environmentId: target.id };
    }
    case "worktree":
      return {
        type: "host",
        hostId: workspace.hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      };
    case "env": {
      const envs = await bb.sdk.environments.list({ projectId: workspace.projectId });
      if (!envs.some((e) => e.id === parsed.id)) {
        const err = t.environmentNotFound(parsed.id, workspace.projectId);
        throw new PluginCliError(err.message, { code: "environment_not_found", hint: err.hint });
      }
      return { type: "reuse", environmentId: parsed.id };
    }
  }
}

/* ──────────────────────── Prompts and placeholders ──────────────────────── */

export type TeamVars = Record<string, string | number | boolean>;

/** {{vars.<name>}} substitution; unknown names stay visible as a stub. */
export function applyVars(text: string, vars: TeamVars | undefined): string {
  return text.replace(/\{\{vars\.([A-Za-z0-9_-]+)\}\}/g, (_all, name: string) => {
    const value = vars?.[name];
    return value === undefined ? `<vars.${name}?>` : String(value);
  });
}

/** Names used as {{vars.<name>}} in a text that vars does not define. */
export function unknownVars(text: string, vars: TeamVars | undefined): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\{vars\.([A-Za-z0-9_-]+)\}\}/g)) {
    if (vars?.[match[1]!] === undefined) names.add(match[1]!);
  }
  return [...names];
}

export function applyPlaceholders(
  text: string,
  vars: {
    workspace: Workspace;
    leadThreadId: string | null;
    roleThreads: Map<string, string>;
    teamVars?: TeamVars;
    teamName?: string;
  },
  t: Strings,
): string {
  const { workspace, leadThreadId, roleThreads } = vars;
  return applyVars(text, vars.teamVars)
    .replaceAll("{{teamName}}", vars.teamName ?? DEFAULT_TEAM)
    .replaceAll("{{projectId}}", workspace.projectId)
    .replaceAll("{{workspacePath}}", workspace.path)
    .replaceAll("{{leadThreadId}}", leadThreadId ?? t.leadStub)
    .replaceAll("{{leadThreadRef}}", leadThreadId ? `@thread:${leadThreadId}` : t.leadStub)
    .replace(/\{\{role\.([a-z0-9-]+)\.(threadId|ref)\}\}/g, (_all, name, kind) => {
      const id = roleThreads.get(name as string);
      if (!id) return t.roleStub(name as string);
      return kind === "ref" ? `@thread:${id}` : id;
    });
}

/** The role's environment spec with {{vars.*}} resolved; unknown vars fail. */
export function roleEnvironmentSpec(role: Role, config: TeamConfig): string {
  const raw = role.environment ?? config.defaults?.environment ?? "default";
  const missing = unknownVars(raw, config.vars);
  if (missing.length > 0) {
    throw new PluginCliError(
      `role "${role.name}": environment "${raw}" uses undefined vars: ${missing.join(", ")}`,
      { code: "config_invalid", hint: "Define them under vars: in the team config" },
    );
  }
  return applyVars(raw, config.vars);
}

/** The role prompt: inline, from its file, else the built-in prompt of its kind. */
export async function loadRolePrompt(
  bb: BbPluginApi,
  workspace: Workspace,
  role: Role,
  lead: boolean,
  lang: Language,
  t: Strings,
): Promise<string> {
  if (role.prompt) return role.prompt;
  if (!role.promptFile) return builtinPrompt(lang, { ...role, lead });
  const abs = joinPath(workspace.path, role.promptFile);
  requireInsideWorkspace(workspace.path, abs);
  try {
    const file = await bb.sdk.files.read({
      hostId: workspace.hostId,
      path: abs,
      rootPath: workspace.path,
    });
    return file.content;
  } catch {
    throw new PluginCliError(t.promptFileMissing(role.name, role.promptFile), {
      code: "prompt_file_missing",
    });
  }
}

/* ──────────────────────── Threads: roles and helpers ──────────────────────── */

const THREAD_PAGE = 200;
const THREAD_SCAN_MAX = 5000;

/** Every live (not archived) thread of a project, paged past the 200 limit. */
export async function listProjectThreads(
  bb: BbPluginApi,
  projectId: string,
): Promise<ThreadDto[]> {
  const all: ThreadDto[] = [];
  for (let offset = 0; offset < THREAD_SCAN_MAX; offset += THREAD_PAGE) {
    const page = await bb.sdk.threads.list({
      projectId,
      includeHidden: true,
      limit: THREAD_PAGE,
      offset,
    });
    all.push(...page);
    if (page.length < THREAD_PAGE) break;
  }
  return all.filter((thread) => thread.archivedAt === null);
}

export interface TeamThreadRow {
  threadId: string;
  team: string;
  role: string;
  /** true: a nested thread under a role thread, not the role thread itself. */
  helper: boolean;
  status: string;
  provider: string;
  title: string;
  updatedAtMs: number;
  parentThreadId: string | null;
  environmentId: string | null;
}

export interface ThreadScan {
  rows: TeamThreadRow[];
  /** Project threads that carry no team mark and sit under no team thread. */
  free: ThreadDto[];
}

/** Team marks in thread plugin metadata (v0.1 threads have no teamName: "main"). */
export function readTeamMark(
  metadata: Record<string, unknown> | undefined,
): { team: string; role: string; helper: boolean } | null {
  if (!metadata) return null;
  const team = typeof metadata.teamName === "string" ? metadata.teamName : DEFAULT_TEAM;
  if (typeof metadata.teamRole === "string") return { team, role: metadata.teamRole, helper: false };
  if (typeof metadata.teamHelperOf === "string") {
    return { team, role: metadata.teamHelperOf, helper: true };
  }
  return null;
}

/**
 * Every team thread of a project. Role threads carry `teamRole`; any thread
 * nested under a team thread is a helper of that role (marked or not).
 */
export async function scanTeamThreads(bb: BbPluginApi, projectId: string): Promise<ThreadScan> {
  const active = await listProjectThreads(bb, projectId);
  const byId = new Map(active.map((thread) => [thread.id, thread]));
  const marks = new Map<string, { team: string; role: string; helper: boolean }>();
  for (let index = 0; index < active.length; index += THREAD_PAGE) {
    const batch = active.slice(index, index + THREAD_PAGE);
    if (batch.length === 0) break;
    const meta = await bb.sdk.threads.experimental_listPluginMetadata({
      threadIds: batch.map((thread) => thread.id),
    });
    for (const entry of meta.threads) {
      const mark = readTeamMark(entry.metadata as Record<string, unknown>);
      if (mark) marks.set(entry.threadId, mark);
    }
  }
  // Unmarked nested threads inherit the nearest team ancestor's role as helpers.
  const resolve = (id: string, depth = 0): { team: string; role: string } | null => {
    const mark = marks.get(id);
    if (mark) return mark;
    if (depth > 20) return null;
    const parent = byId.get(id)?.parentThreadId;
    return parent ? resolve(parent, depth + 1) : null;
  };
  const rows: TeamThreadRow[] = [];
  const free: ThreadDto[] = [];
  for (const thread of active) {
    const own = marks.get(thread.id);
    const inherited = own ? null : thread.parentThreadId ? resolve(thread.parentThreadId) : null;
    const mark = own ?? (inherited ? { ...inherited, helper: true } : null);
    if (!mark) {
      free.push(thread);
      continue;
    }
    rows.push({
      threadId: thread.id,
      team: mark.team,
      role: mark.role,
      helper: mark.helper,
      status: thread.status,
      provider: thread.providerId,
      title: thread.title ?? "",
      updatedAtMs: thread.updatedAt,
      parentThreadId: thread.parentThreadId ?? null,
      environmentId: thread.environmentId ?? null,
    });
  }
  return { rows, free };
}

/** role → role threads (helpers excluded) of one team. */
export function roleThreadsOf(scan: ThreadScan, team: string): Map<string, TeamThreadRow[]> {
  const map = new Map<string, TeamThreadRow[]>();
  for (const row of scan.rows) {
    if (row.team !== team || row.helper) continue;
    const list = map.get(row.role) ?? [];
    list.push(row);
    map.set(row.role, list);
  }
  return map;
}

/** role → helper threads of one team. */
export function helpersOf(scan: ThreadScan, team: string): Map<string, TeamThreadRow[]> {
  const map = new Map<string, TeamThreadRow[]>();
  for (const row of scan.rows) {
    if (row.team !== team || !row.helper) continue;
    const list = map.get(row.role) ?? [];
    list.push(row);
    map.set(row.role, list);
  }
  return map;
}

/** Teams that have threads in the project. */
export function teamsWithThreads(scan: ThreadScan): string[] {
  return [...new Set(scan.rows.map((row) => row.team))].sort();
}

/** No config: the lead is the role whose thread parents other team threads. */
export function inferLeadRole(rows: Map<string, TeamThreadRow[]>): string | null {
  const parents = new Set(
    [...rows.values()].flat().map((row) => row.parentThreadId).filter(Boolean),
  );
  for (const [role, list] of rows) {
    if (list.some((row) => parents.has(row.threadId))) return role;
  }
  return null;
}

/* ──────────────────────── Providers, sections ──────────────────────── */

export interface ProviderState {
  enabled: string[];
  disabled: string[];
}

export async function providerState(bb: BbPluginApi): Promise<ProviderState> {
  const providers = await bb.sdk.providers.list();
  const enabled = providers.map((p) => p.id);
  let disabled: string[] = [];
  try {
    const catalog = await bb.sdk.providers.catalog();
    disabled = catalog
      .filter((entry) => entry.enabled === false && !enabled.includes(entry.id))
      .map((entry) => entry.id);
  } catch {
    // catalog unavailable — unknown providers are reported as unknown
  }
  return { enabled, disabled };
}

export async function validateProviders(
  bb: BbPluginApi,
  roles: Array<{ provider?: string }>,
  t: Strings,
): Promise<void> {
  const needed = [...new Set(roles.map((r) => r.provider).filter(Boolean))] as string[];
  if (needed.length === 0) return;
  const state = await providerState(bb);
  const missing = needed.filter((id) => !state.enabled.includes(id));
  if (missing.length === 0) return;
  const turnedOff = missing.filter((id) => state.disabled.includes(id));
  const unknown = missing.filter((id) => !state.disabled.includes(id));
  if (turnedOff.length > 0) {
    const err = t.providerDisabled(turnedOff.join(", "), state.enabled.join(", "), turnedOff[0]!);
    throw new PluginCliError(err.message, { code: "provider_disabled", hint: err.hint });
  }
  const err = t.providerUnknown(unknown.join(", "), state.enabled.join(", "));
  throw new PluginCliError(err.message, { code: "provider_not_found", hint: err.hint });
}

/** True when .bb is covered by a .gitignore pattern. */
export function gitIgnoresBB(gitignoreContent: string): boolean {
  return gitignoreContent.split("\n").some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return false;
    return [".bb", ".bb/", "/.bb", "/.bb/", ".bb/*", ".bb/**", "/.bb/*", "/.bb/**"].includes(line);
  });
}

/** Sidebar section of a team: "Team" for main, "Team · <name>" otherwise. */
export function teamSectionName(t: Strings, team: string): string {
  return team === DEFAULT_TEAM ? t.sectionName : `${t.sectionName} · ${team}`;
}

/** Find a section by any of its names (both languages), else create the first one. */
export async function ensureSection(
  bb: BbPluginApi,
  name: string,
  aliases: readonly string[] = [],
): Promise<string | null> {
  try {
    const sections = await bb.sdk.threadSections.list();
    const found =
      sections.find((s) => s.name === name) ?? sections.find((s) => aliases.includes(s.name));
    if (found) return found.id;
    const created = await bb.sdk.threadSections.create({ name });
    return created.id;
  } catch {
    return null;
  }
}

/** Team file layout for an existing config (legacy single file or teams dir). */
export function layoutFor(team: string, legacy: boolean) {
  return teamLayout(team, legacy);
}

/** First lines of an agent reply, bounded for a notification. */
export function excerptSafe(text: string | null, max = 600): string | null {
  if (!text) return null;
  const value = text.trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
