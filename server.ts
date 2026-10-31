// bb-plugin-team — role-based agent team for a project, configured in .bb/team.yaml.
//
// Commands (bb team --help):
//   bb team init     — write the team template (.bb/team.yaml + role prompts)
//   bb team create   — spawn the team threads (lead + executors)
//   bb team status   — the config and the live team threads
//   bb team tell     — message a role by name (or all roles)
//   bb team task …   — work packages per role: add / list / update / done / remove
//   bb team report   — visual digest (inline-vis HTML) or Markdown
//   bb team doctor   — pre-flight checks of config, providers, environments, threads
//   bb team replace  — rotate a role onto a fresh thread with a handoff
//   bb team stop / pause / resume — bulk control of the executors
//
// UI: the Team panel (app.tsx) and the "Team roles" section of the @ menu.
// Opt-in per project: the plugin does nothing in projects without .bb/team.yaml.
//
// Plugin settings (Settings UI):
//   language    — CLI output + template language: "en" (default) | "ru"
//   teamSection — keep team threads in a sidebar section: true (default)
//   roster      — send the team roster to the lead after create: true (default)

import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginMentionItem,
} from "@get-bb/plugin-sdk";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { messages, type Messages } from "./messages";
import { renderReportHtml, renderReportMarkdown } from "./report";
import {
  TASK_STATUSES,
  currentTask,
  relativeAgo,
  type Language,
  type SnapshotRole,
  type TaskStatus,
  type TeamSnapshot,
  type TeamTask,
} from "./snapshot";
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
  CONFIG_PATH,
  TEMPLATE_NAMES,
  isTemplateName,
  templateFiles,
  type TemplateName,
} from "./templates";

export { relativeAgo };
export type { Language, TeamSnapshot };

const CONFIG_PATH_JSON = ".bb/team.json";

/* ──────────────────────── SDK types (type-level only) ──────────────────────── */

type Sdk = BbPluginApi["sdk"];
type SpawnEnvironment = NonNullable<
  Parameters<Sdk["threads"]["spawn"]>[0]
>["environment"];

interface Workspace {
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
type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

const roleSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "role name: lowercase letters, digits, hyphens"),
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
type TeamConfig = z.infer<typeof teamConfigSchema>;

/* ──────────────────────── Strings (en | ru) ──────────────────────── */

interface Strings {
  sectionName: string;
  projectNotResolved: { message: string; hint: string };
  projectNotFound: (name: string) => { message: string; hint: string };
  projectSourceMissing: (name: string) => string;
  pathOutsideWorkspace: (abs: string, ws: string) => string;
  configMissing: (projectId: string) => { message: string; hint: string };
  configParseFailed: (source: string, error: string) => string;
  configInvalid: (source: string, issues: string) => string;
  allRolesDisabled: string;
  roleDeclaredTwice: (name: string) => string;
  threadBoundTwice: (id: string) => string;
  roleNeedsPrompt: (name: string) => string;
  multipleLeads: (names: string) => string;
  environmentInvalid: (spec: string) => { message: string; hint: string };
  checkoutMissing: (projectId: string) => { message: string; hint: string };
  environmentNotFound: (id: string, projectId: string) => { message: string; hint: string };
  promptFileMissing: (role: string, file: string) => string;
  providerDisabled: (ids: string, avail: string, first: string) => { message: string; hint: string };
  providerUnknown: (ids: string, avail: string) => { message: string; hint: string };
  threadNotFound: (role: string, id: string) => string;
  spawnFailed: (role: string, error: string) => { message: string; hint: string };
  tellRoleNotFound: (role: string) => { message: string; hint: string };
  tellMessageRequired: { message: string; hint: string };
  tellFileReadFailed: (path: string) => string;
  tellSent: (role: string, threadId: string) => string;
  tellFailed: (role: string, error: string) => string;
  tellSummary: (sent: number, failed: number) => string;
  statusNoThread: string;
  statusActivity: (ago: string) => string;
  mentionLabel: string;
  mentionSubtitle: (status: string, provider: string) => string;
  mentionContext: (role: string, threadId: string) => string;
  threadWrongProject: (role: string, id: string) => string;
  threadArchived: (role: string, id: string) => { message: string; hint: string };
  leadStub: string;
  roleStub: (name: string) => string;
  initTitle: (project: string) => string;
  initNext: string[];
  scaffoldExists: (files: string) => { message: string; hint: string };
  planTitle: (source: string, project: string) => string;
  adoptExisting: (id: string, status: string, title: string) => string;
  alreadyCreated: (ids: string) => string;
  willCreate: string;
  created: string;
  adopted: string;
  alreadyThere: (role: string, ids: string) => string;
  createTitle: (project: string, source: string) => string;
  rosterSent: (leadId: string) => string;
  statusTitle: (project: string) => string;
  statusThreads: string;
  statusThreadsEmpty: string;
  statusNoConfig: string;
  projectByPathNotFound: (cwd: string) => { message: string; hint: string };
  gitignoreNote: string[];
  labels: {
    thread: string;
    title: string;
    provider: string;
    model: string;
    environment: string;
    prompt: string;
    config: string;
    lead: string;
    roles: string;
    projectDefault: string;
    disabledRole: string;
  };
  rosterLines: {
    header: string;
    executors: string;
    tell: string;
    notify: string;
    next: string;
    defaultProvider: string;
  };
}

const STRINGS: Record<Language, Strings> = {
  en: {
    sectionName: "Team",
    projectNotResolved: {
      message: "no project specified: run from a project thread or add --project <id|name>",
      hint: "List projects: bb project list",
    },
    projectNotFound: (name) => ({
      message: `project "${name}" not found`,
      hint: "List projects: bb project list",
    }),
    projectSourceMissing: (name) =>
      `project "${name}" has no sources (checkout) on a connected machine`,
    pathOutsideWorkspace: (abs, ws) =>
      `path "${abs}" escapes the workspace ${ws}`,
    configMissing: (projectId) => ({
      message: `no ${CONFIG_PATH} in the project: run bb team init first`,
      hint: `bb team init --project ${projectId}`,
    }),
    configParseFailed: (source, error) =>
      `${source}: parse error (${error})`,
    configInvalid: (source, issues) =>
      `${source}: invalid config schema — ${issues}`,
    allRolesDisabled: "every role is disabled (enabled: false)",
    roleDeclaredTwice: (name) => `role "${name}" is declared twice`,
    threadBoundTwice: (id) => `thread ${id} is bound to two roles`,
    roleNeedsPrompt: (name) =>
      `role "${name}": set exactly one of prompt / promptFile`,
    multipleLeads: (names) => `lead: true on more than one role (${names})`,
    environmentInvalid: (spec) => ({
      message: `unknown environment "${spec}"`,
      hint: "Allowed: default | checkout | worktree | env:<id>",
    }),
    checkoutMissing: (projectId) => ({
      message:
        "the project has no checkout environment: set environment: default or env:<id>",
      hint: `Project environments: bb environment list --project ${projectId}`,
    }),
    environmentNotFound: (id, projectId) => ({
      message: `environment "${id}" not found in the project`,
      hint: `Project environments: bb environment list --project ${projectId}`,
    }),
    promptFileMissing: (role, file) =>
      `role "${role}": cannot read prompt file ${file}`,
    providerDisabled: (ids, avail, first) => ({
      message: `providers disabled: ${ids}`,
      hint: `Enable: bb provider enable ${first} — or change provider in .bb/team.yaml. Available now: ${avail}`,
    }),
    providerUnknown: (ids, avail) => ({
      message: `unknown providers: ${ids}`,
      hint: `Available: ${avail}. Model list: bb provider models`,
    }),
    threadNotFound: (role, id) => `role "${role}": thread ${id} not found`,
    spawnFailed: (role: string, error: string) => ({
      message: `role "${role}": thread spawn failed — ${error}`,
      hint: "Re-run bb team create: it skips finished roles and completes the rest.",
    }),
    tellRoleNotFound: (role) => ({
      message: `role "${role}" has no team thread in this project`,
      hint: "Roles with threads: bb team status. Spawn the team: bb team create",
    }),
    tellMessageRequired: {
      message: "set the message: --message <text> or --message-file <path>",
      hint: "Multi-line: bb team tell <role> --message-stdin <<'EOF' … EOF",
    },
    tellFileReadFailed: (path) => `cannot read the message file "${path}"`,
    tellSent: (role, threadId) => `  ${role} — @thread:${threadId} — sent`,
    tellFailed: (role, error) => `  ${role} — failed: ${error}`,
    tellSummary: (sent, failed) =>
      `sent: ${sent}, failed: ${failed}`,
    statusNoThread: "(no thread)",
    statusActivity: (ago) => `· active ${ago} ago`,
    mentionLabel: "Team roles",
    mentionSubtitle: (status, provider) => `Team role · ${status} · ${provider}`,
    mentionContext: (role, threadId) =>
      `The sender mentions the team role "${role}". Its thread is @thread:${threadId}.`, 
    threadWrongProject: (role, id) =>
      `role "${role}": thread ${id} belongs to another project`,
    threadArchived: (role, id) => ({
      message: `role "${role}": thread ${id} is archived`,
      hint: `Unarchive it: bb thread unarchive ${id} — or drop threadId from the config so the role gets a fresh thread`,
    }),
    leadStub: "<lead-not-created-yet>",
    roleStub: (name) => `<role-${name}-not-created-yet>`,
    initTitle: (project) => `Team template created in project "${project}":`,
    initNext: [
      "Next:",
      "  1) edit .bb/team.yaml: roles, providers, models",
      "  2) adjust role prompts in .bb/team/roles/ if needed",
      "  3) bb team doctor — check providers, environments, prompts",
      "  4) bb team create — spawn the team threads",
    ],
    scaffoldExists: (files) => ({
      message: `template already exists: ${files}`,
      hint: "Overwrite: bb team init --force (edits in these files will be lost)",
    }),
    planTitle: (source, project) =>
      `Team plan (config ${source}, project "${project}") — dry-run:`,
    adoptExisting: (id, status, title) =>
      `adopt existing ${id} (${status}, "${title}")`,
    alreadyCreated: (ids) => `already created (${ids}) — will be skipped`,
    willCreate: "will be created",
    created: "created",
    adopted: "adopted",
    alreadyThere: (role, ids) => `  [exists] ${role} — ${ids} (skipped)`,
    createTitle: (project, source) =>
      `Project team "${project}" (config ${source}):`,
    rosterSent: (leadId) =>
      `Team roster sent to the lead (@thread:${leadId}).`,
    statusTitle: (project) => `Project "${project}":`,
    statusThreads: "team threads:",
    statusThreadsEmpty: "team threads: none (bb team create)",
    statusNoConfig: `no .bb/team.yaml (bb team init writes the template)`,
    projectByPathNotFound: (cwd) => ({
      message: `no project found for path "${cwd}"`,
      hint: "cd into a project, or pass --project <id|name>. List projects: bb project list",
    }),
    gitignoreNote: [
      "note: .bb/ is gitignored in this project.",
      "Commit .bb/team.yaml and .bb/team/ if the team config is shared with everyone",
      "who clones the repo; keep them untracked for a personal-only setup.",
    ],
    labels: {
      thread: "thread",
      title: "title",
      provider: "provider",
      model: "model",
      environment: "environment",
      prompt: "prompt",
      config: "config",
      lead: "lead",
      roles: "roles",
      projectDefault: "(project default)",
      disabledRole: " (disabled)",
    },
    rosterLines: {
      header: "The team was created by bb team create (config .bb/team.yaml).",
      executors:
        "Executors are your child threads; they report to you by message:",
      tell: 'Assign packages by role: bb team task add <role> "<title>" --note "<details>" --send',
      notify:
        "You are woken on executor failures and blockers (parentNotifications: stuck).",
      next: "Next: wait for the user's task, decompose it, distribute the work packages.",
      defaultProvider: "default",
    },
  },
  ru: {
    sectionName: "Команда",
    projectNotResolved: {
      message: "не указан проект: запустите из треда проекта или добавьте --project <id|имя>",
      hint: "Список проектов: bb project list",
    },
    projectNotFound: (name) => ({
      message: `проект "${name}" не найден`,
      hint: "Список проектов: bb project list",
    }),
    projectSourceMissing: (name) =>
      `у проекта "${name}" нет источников (checkout) на подключённой машине`,
    pathOutsideWorkspace: (abs, ws) =>
      `путь "${abs}" выходит за границы воркспейса ${ws}`,
    configMissing: (projectId) => ({
      message: `в проекте нет ${CONFIG_PATH}: сначала выполните bb team init`,
      hint: `bb team init --project ${projectId}`,
    }),
    configParseFailed: (source, error) => `${source}: ошибка разбора (${error})`,
    configInvalid: (source, issues) =>
      `${source}: неверная схема конфига — ${issues}`,
    allRolesDisabled: "все роли выключены (enabled: false)",
    roleDeclaredTwice: (name) => `роль "${name}" объявлена дважды`,
    threadBoundTwice: (id) => `тред ${id} привязан к двум ролям`,
    roleNeedsPrompt: (name) => `роль "${name}": укажите ровно одно из prompt / promptFile`,
    multipleLeads: (names) => `lead: true более чем у одной роли (${names})`,
    environmentInvalid: (spec) => ({
      message: `неизвестное окружение "${spec}"`,
      hint: "Допустимо: default | checkout | worktree | env:<id>",
    }),
    checkoutMissing: (projectId) => ({
      message:
        "у проекта нет checkout-окружения: укажите environment: default или env:<id>",
      hint: `Окружения проекта: bb environment list --project ${projectId}`,
    }),
    environmentNotFound: (id, projectId) => ({
      message: `окружение "${id}" не найдено в проекте`,
      hint: `Окружения проекта: bb environment list --project ${projectId}`,
    }),
    promptFileMissing: (role, file) => `роль "${role}": не читается промпт-файл ${file}`,
    providerDisabled: (ids, avail, first) => ({
      message: `провайдеры отключены: ${ids}`,
      hint: `Включить: bb provider enable ${first} — или заменить provider в .bb/team.yaml. Доступны сейчас: ${avail}`,
    }),
    providerUnknown: (ids, avail) => ({
      message: `неизвестные провайдеры: ${ids}`,
      hint: `Доступны: ${avail}. Список моделей: bb provider models`,
    }),
    threadNotFound: (role, id) => `роль "${role}": тред ${id} не найден`,
    spawnFailed: (role: string, error: string) => ({
      message: `роль "${role}": не удалось создать тред — ${error}`,
      hint: "Повторите bb team create: готовые роли пропускаются, остальное дозасоздастся.",
    }),
    tellRoleNotFound: (role) => ({
      message: `у роли "${role}" нет треда команды в этом проекте`,
      hint: "Роли с тредами: bb team status. Создать команду: bb team create",
    }),
    tellMessageRequired: {
      message: "укажите сообщение: --message <текст> или --message-file <путь>",
      hint: "Многострочно: bb team tell <роль> --message-stdin <<'EOF' … EOF",
    },
    tellFileReadFailed: (path) => `не читается файл сообщения "${path}"`,
    tellSent: (role, threadId) => `  ${role} — @thread:${threadId} — отправлено`,
    tellFailed: (role, error) => `  ${role} — ошибка: ${error}`,
    tellSummary: (sent, failed) =>
      `отправлено: ${sent}, ошибок: ${failed}`,
    statusNoThread: "(нет треда)",
    statusActivity: (ago) => `· активность ${ago} назад`,
    mentionLabel: "Роли команды",
    mentionSubtitle: (status, provider) => `Роль команды · ${status} · ${provider}`,
    mentionContext: (role, threadId) =>
      `Отправитель упоминает роль команды "${role}". Тред роли: @thread:${threadId}.`,
    threadWrongProject: (role, id) =>
      `роль "${role}": тред ${id} принадлежит другому проекту`,
    threadArchived: (role, id) => ({
      message: `роль "${role}": тред ${id} архивирован`,
      hint: `Разархивируйте: bb thread unarchive ${id} — или уберите threadId из конфига, тогда роль получит новый тред`,
    }),
    leadStub: "<lead-ещё-не-создан>",
    roleStub: (name) => `<роль-${name}-ещё-не-создана>`,
    initTitle: (project) => `Шаблон команды создан в проекте "${project}":`,
    initNext: [
      "Дальше:",
      "  1) отредактируйте .bb/team.yaml: роли, провайдеры, модели",
      "  2) при желании поправьте промпты ролей в .bb/team/roles/",
      "  3) bb team doctor — проверить провайдеры, окружения, промпты",
      "  4) bb team create — поднять команду тредов",
    ],
    scaffoldExists: (files) => ({
      message: `шаблон уже существует: ${files}`,
      hint: "Перезаписать: bb team init --force (правки в файлах будут потеряны)",
    }),
    planTitle: (source, project) =>
      `План команды (конфиг ${source}, проект "${project}") — dry-run:`,
    adoptExisting: (id, status, title) =>
      `привязка существующего ${id} (${status}, "${title}")`,
    alreadyCreated: (ids) => `уже создан (${ids}) — будет пропущен`,
    willCreate: "будет создан",
    created: "создан",
    adopted: "привязан",
    alreadyThere: (role, ids) => `  [уже есть] ${role} — ${ids} (пропущен)`,
    createTitle: (project, source) =>
      `Команда проекта "${project}" (конфиг ${source}):`,
    rosterSent: (leadId) => `Руководителю (@thread:${leadId}) отправлен состав команды.`,
    statusTitle: (project) => `Проект "${project}":`,
    statusThreads: "треды команды:",
    statusThreadsEmpty: "треды команды: не созданы (bb team create)",
    statusNoConfig: `конфига .bb/team.yaml нет (bb team init создаст шаблон)`,
    projectByPathNotFound: (cwd) => ({
      message: `по пути "${cwd}" не найден проект`,
      hint: "перейдите в каталог проекта или укажите --project <id|имя>. Список: bb project list",
    }),
    gitignoreNote: [
      "замечание: каталог .bb/ игнорируется git в этом проекте.",
      "Закоммитьте .bb/team.yaml и .bb/team/, если конфиг команды общий для всех,",
      "кто клонирует репозиторий; для личной настройки оставьте как есть.",
    ],
    labels: {
      thread: "тред",
      title: "заголовок",
      provider: "провайдер",
      model: "модель",
      environment: "окружение",
      prompt: "промпт",
      config: "конфиг",
      lead: "руководитель",
      roles: "роли",
      projectDefault: "(по умолчанию проекта)",
      disabledRole: " (выключена)",
    },
    rosterLines: {
      header: "Состав команды создан командой bb team create (конфиг .bb/team.yaml).",
      executors: "Исполнители — твои дочерние треды, отчёты приходят тебе сообщениями:",
      tell: 'Пакеты выдавай по роли: bb team task add <роль> "<название>" --note "<детали>" --send',
      notify:
        "Уведомления приходят при сбоях и блокировках исполнителей (parentNotifications: stuck).",
      next: "Дальше: жди постановку от пользователя, декомпозируй и распределяй пакеты.",
      defaultProvider: "по умолчанию",
    },
  },
};

export function strings(lang: Language): Strings {
  return STRINGS[lang] ?? STRINGS.en;
}

/* ──────────────────────── Helpers ──────────────────────── */

export function joinPath(workspace: string, rel: string): string {
  return rel.startsWith("/")
    ? rel
    : `${workspace}/${rel.replace(/^\.\//, "").replace(/^\/+/, "")}`;
}

export function requireInsideWorkspace(workspace: string, abs: string): void {
  if (abs !== workspace && !abs.startsWith(`${workspace}/`)) {
    throw new PluginCliError(
      `path "${abs}" escapes the workspace ${workspace}`,
      { code: "path_outside_workspace" },
    );
  }
}

export function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Candidate project source for cwd matching. */
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

async function resolveWorkspace(
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
      throw new PluginCliError(err.message, {
        code: "project_not_found",
        hint: err.hint,
      });
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

  // No explicit project: resolve it from the invoking directory. The cwd
  // names a path on the invoking machine, so matches are limited to sources
  // on that host: nested projects pick the longest path, subdirectories of
  // the checkout match the root source, and worktrees never fall back to the
  // main checkout on another path.
  const cwd = ctx.cwd?.replace(/\/+$/, "");
  if (!cwd) {
    throw new PluginCliError(t.projectNotResolved.message, {
      code: "project_not_resolved",
      hint: t.projectNotResolved.hint,
    });
  }
  let hostId: string | null = null;
  if (ctx.threadId) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        hostId = environment.hostId;
      }
    } catch {
      // thread context unavailable — fall back to the server host below
    }
  }
  if (!hostId) {
    try {
      const config = await bb.sdk.system.config();
      hostId = config.primaryHostId;
    } catch {
      hostId = null;
    }
  }
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
    throw new PluginCliError(err.message, {
      code: "project_not_resolved",
      hint: err.hint,
    });
  }
  return {
    projectId: match.projectId,
    projectName: match.projectName,
    path: match.path.replace(/\/+$/, ""),
    hostId: match.hostId,
  };
}

async function readTeamConfig(
  bb: BbPluginApi,
  workspace: Workspace,
  t: Strings,
): Promise<{ config: TeamConfig; source: string }> {
  const paths = [CONFIG_PATH, CONFIG_PATH_JSON];
  let content: string | null = null;
  let source = "";
  for (const rel of paths) {
    const abs = joinPath(workspace.path, rel);
    try {
      const file = await bb.sdk.files.read({
        hostId: workspace.hostId,
        path: abs,
        rootPath: workspace.path,
      });
      content = file.content;
      source = rel;
      break;
    } catch {
      // missing file — try the next candidate
    }
  }
  if (content === null) {
    const err = t.configMissing(workspace.projectId);
    throw new PluginCliError(err.message, { code: "config_missing", hint: err.hint });
  }
  let raw: unknown;
  try {
    raw = source.endsWith(".json") ? JSON.parse(content) : loadYaml(content);
  } catch (error) {
    throw new PluginCliError(
      t.configParseFailed(source, (error as Error).message),
      { code: "config_parse_failed" },
    );
  }
  const parsed = teamConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginCliError(
      t.configInvalid(source, zodIssues(parsed.error)),
      { code: "config_invalid" },
    );
  }
  return { config: parsed.data, source };
}

/** Semantic checks zod cannot express. Returns the lead role. */
export function semanticChecks(
  config: TeamConfig,
  t: Strings = strings("en"),
): { lead: Role; roles: Role[] } {
  const roles = config.roles.filter((r) => r.enabled !== false);
  if (roles.length === 0) {
    throw new PluginCliError(t.allRolesDisabled, { code: "config_invalid" });
  }
  const names = new Set<string>();
  const threadIds = new Set<string>();
  for (const role of roles) {
    if (names.has(role.name)) {
      throw new PluginCliError(t.roleDeclaredTwice(role.name), {
        code: "config_invalid",
      });
    }
    if (role.threadId && threadIds.has(role.threadId)) {
      throw new PluginCliError(t.threadBoundTwice(role.threadId), {
        code: "config_invalid",
      });
    }
    if (role.threadId) threadIds.add(role.threadId);
    names.add(role.name);
    if (role.threadId) continue; // adopted thread: no prompt needed
    if ((role.prompt ? 1 : 0) + (role.promptFile ? 1 : 0) !== 1) {
      throw new PluginCliError(t.roleNeedsPrompt(role.name), {
        code: "config_invalid",
      });
    }
  }
  const explicitLeads = roles.filter((r) => r.lead === true);
  if (explicitLeads.length > 1) {
    throw new PluginCliError(
      t.multipleLeads(explicitLeads.map((r) => r.name).join(", ")),
      { code: "config_invalid" },
    );
  }
  const lead = explicitLeads[0] ?? roles[0];
  return { lead, roles };
}

/** Environment spec parsing. The pure part of resolveEnvironment. */
export type EnvironmentSpec =
  | { kind: "default" | "checkout" | "worktree" }
  | { kind: "env"; id: string };

export function parseEnvironmentSpec(
  spec: string,
  t: Strings = strings("en"),
): EnvironmentSpec {
  switch (spec) {
    case "default":
    case "checkout":
    case "worktree":
      return { kind: spec };
    default: {
      const match = /^(?:env|reuse):(.+)$/.exec(spec);
      if (!match) {
        const err = t.environmentInvalid(spec);
        throw new PluginCliError(err.message, {
          code: "environment_invalid",
          hint: err.hint,
        });
      }
      return { kind: "env", id: match[1]! };
    }
  }
}

async function resolveEnvironment(
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
        throw new PluginCliError(err.message, {
          code: "environment_not_found",
          hint: err.hint,
        });
      }
      return { type: "reuse", environmentId: target.id };
    }
    case "worktree":
      return {
        type: "host",
        hostId: workspace.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      };
    case "env": {
      const wanted = parsed.id;
      const envs = await bb.sdk.environments.list({
        projectId: workspace.projectId,
      });
      if (!envs.some((e) => e.id === wanted)) {
        const err = t.environmentNotFound(wanted, workspace.projectId);
        throw new PluginCliError(err.message, {
          code: "environment_not_found",
          hint: err.hint,
        });
      }
      return { type: "reuse", environmentId: wanted };
    }
  }
}

export type TeamVars = Record<string, string | number | boolean>;

/** {{vars.<name>}} substitution; unknown names stay visible as a stub. */
export function applyVars(text: string, vars: TeamVars | undefined): string {
  return text.replace(/\{\{vars\.([A-Za-z0-9_-]+)\}\}/g, (all, name: string) => {
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

/** Prompt placeholder substitution. */
export function applyPlaceholders(
  text: string,
  vars: {
    workspace: Workspace;
    leadThreadId: string | null;
    roleThreads: Map<string, string>;
    teamVars?: TeamVars;
  },
  t: Strings = strings("en"),
): string {
  const { workspace, leadThreadId, roleThreads } = vars;
  return applyVars(text, vars.teamVars)
    .replaceAll("{{projectId}}", workspace.projectId)
    .replaceAll("{{workspacePath}}", workspace.path)
    .replaceAll("{{leadThreadId}}", leadThreadId ?? t.leadStub)
    .replaceAll(
      "{{leadThreadRef}}",
      leadThreadId ? `@thread:${leadThreadId}` : t.leadStub,
    )
    .replace(/\{\{role\.([a-z0-9-]+)\.(threadId|ref)\}\}/g, (_all, name, kind) => {
      const id = roleThreads.get(name as string);
      if (!id) return t.roleStub(name as string);
      return kind === "ref" ? `@thread:${id}` : id;
    });
}

/** The role's environment spec with {{vars.*}} resolved; unknown vars fail. */
export function roleEnvironmentSpec(
  role: Role,
  config: TeamConfig,
): string {
  const raw = role.environment ?? config.defaults?.environment ?? "default";
  const missing = unknownVars(raw, config.vars);
  if (missing.length > 0) {
    throw new PluginCliError(
      `role "${role.name}": environment "${raw}" uses undefined vars: ${missing.join(", ")}`,
      { code: "config_invalid", hint: "Define them under vars: in .bb/team.yaml" },
    );
  }
  return applyVars(raw, config.vars);
}

async function loadRolePrompt(
  bb: BbPluginApi,
  workspace: Workspace,
  role: Role,
  t: Strings,
): Promise<string> {
  if (role.prompt) return role.prompt;
  const abs = joinPath(workspace.path, role.promptFile!);
  requireInsideWorkspace(workspace.path, abs);
  try {
    const file = await bb.sdk.files.read({
      hostId: workspace.hostId,
      path: abs,
      rootPath: workspace.path,
    });
    return file.content;
  } catch {
    throw new PluginCliError(
      t.promptFileMissing(role.name, role.promptFile!),
      { code: "prompt_file_missing" },
    );
  }
}

type ThreadDto = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

const THREAD_PAGE = 200;
const THREAD_SCAN_MAX = 5000;

/** Every live (not archived) thread of a project, paged past the 200 limit. */
async function listProjectThreads(bb: BbPluginApi, projectId: string): Promise<ThreadDto[]> {
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

/** Team threads with live details: role → thread rows. */
export interface TeamThreadRow {
  threadId: string;
  status: string;
  provider: string;
  title: string;
  updatedAtMs: number;
  parentThreadId: string | null;
  environmentId: string | null;
}

async function findTeamThreadRows(
  bb: BbPluginApi,
  projectId: string,
): Promise<Map<string, TeamThreadRow[]>> {
  // Adopted threads are manually created, so do not filter by origin:
  // take the project threads and read the teamRole metadata marker.
  const active = await listProjectThreads(bb, projectId);
  const map = new Map<string, TeamThreadRow[]>();
  const byId = new Map(active.map((thread) => [thread.id, thread]));
  for (let index = 0; index < active.length; index += THREAD_PAGE) {
    const batch = active.slice(index, index + THREAD_PAGE);
    const meta = await bb.sdk.threads.experimental_listPluginMetadata({
      threadIds: batch.map((thread) => thread.id),
    });
    for (const entry of meta.threads) {
      const role = (entry.metadata as Record<string, unknown>).teamRole;
      if (typeof role !== "string") continue;
      const thread = byId.get(entry.threadId);
      if (!thread) continue;
      const list = map.get(role) ?? [];
      list.push({
        threadId: thread.id,
        status: thread.status,
        provider: thread.providerId,
        title: thread.title ?? "",
        updatedAtMs: thread.updatedAt,
        parentThreadId: thread.parentThreadId ?? null,
        environmentId: thread.environmentId ?? null,
      });
      map.set(role, list);
    }
  }
  return map;
}

/** Threads already bound to team roles: role → thread ids (not archived). */
async function findExistingTeamThreads(
  bb: BbPluginApi,
  projectId: string,
): Promise<Map<string, string[]>> {
  const rows = await findTeamThreadRows(bb, projectId);
  return new Map(
    [...rows.entries()].map(([role, list]) => [role, list.map((row) => row.threadId)]),
  );
}

async function validateProviders(
  bb: BbPluginApi,
  roles: Role[],
  t: Strings,
): Promise<void> {
  const needed = [...new Set(roles.map((r) => r.provider).filter(Boolean))] as string[];
  if (needed.length === 0) return;
  const providers = await bb.sdk.providers.list();
  const ids = new Set(providers.map((p) => p.id));
  const missing = needed.filter((id) => !ids.has(id));
  if (missing.length === 0) return;

  // A disabled provider disappears from providers.list(): tell it apart
  // from a never-installed one via the catalog (enabled: false).
  let disabled = new Set<string>();
  try {
    const catalog = await bb.sdk.providers.catalog();
    disabled = new Set(
      catalog.filter((entry) => entry.enabled === false).map((entry) => entry.id),
    );
  } catch {
    // catalog unavailable — treat everything as unknown
  }
  const turnedOff = missing.filter((id) => disabled.has(id));
  const unknown = missing.filter((id) => !disabled.has(id));
  if (turnedOff.length > 0) {
    const err = t.providerDisabled(turnedOff.join(", "), [...ids].join(", "), turnedOff[0]!);
    throw new PluginCliError(err.message, { code: "provider_disabled", hint: err.hint });
  }
  const err = t.providerUnknown(unknown.join(", "), [...ids].join(", "));
  throw new PluginCliError(err.message, { code: "provider_not_found", hint: err.hint });
}

/** True when .bb is covered by a .gitignore pattern. */
export function gitIgnoresBB(gitignoreContent: string): boolean {
  return gitignoreContent.split("\n").some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return false;
    return line === ".bb" || line === ".bb/" || line.startsWith(".bb/") || line.startsWith(".bb/*");
  });
}

/** Find or create the team sidebar section; returns its id. */
async function ensureTeamSection(
  bb: BbPluginApi,
  t: Strings,
): Promise<string | null> {
  try {
    const sections = await bb.sdk.threadSections.list();
    const found = sections.find((s) => s.name === t.sectionName);
    if (found) return found.id;
    const created = await bb.sdk.threadSections.create({ name: t.sectionName });
    return created.id;
  } catch {
    // sections unavailable — team threads go to the default list
    return null;
  }
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(18)} ${value}`;
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

/** The config and the in-project prompt files of another project's team. */
async function copyTeamFiles(
  bb: BbPluginApi,
  source: Workspace,
  t: Strings,
  m: Messages,
): Promise<{ files: Array<{ rel: string; content: string }>; stripped: number }> {
  let loaded: { config: TeamConfig; source: string };
  try {
    loaded = await readTeamConfig(bb, source, t);
  } catch (error) {
    if ((error as PluginCliError).code === "config_missing") {
      const err = m.fromNoConfig(source.projectName);
      throw new PluginCliError(err.message, { code: "config_missing", hint: err.hint });
    }
    throw error;
  }
  const raw = await bb.sdk.files.read({
    hostId: source.hostId,
    path: joinPath(source.path, loaded.source),
    rootPath: source.path,
  });
  let content: string;
  let stripped = 0;
  if (loaded.source.endsWith(".json")) {
    const parsed = JSON.parse(raw.content) as { roles?: Array<Record<string, unknown>> };
    for (const role of parsed.roles ?? []) {
      if ("threadId" in role) {
        delete role.threadId;
        stripped += 1;
      }
    }
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  } else {
    ({ text: content, stripped } = stripThreadIds(raw.content));
  }
  const files: Array<{ rel: string; content: string }> = [
    { rel: loaded.source, content },
  ];
  const seen = new Set<string>();
  for (const role of loaded.config.roles) {
    if (!role.promptFile || role.promptFile.startsWith("/")) continue;
    const rel = role.promptFile.replace(/^\.\//, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = joinPath(source.path, rel);
    requireInsideWorkspace(source.path, abs);
    try {
      const file = await bb.sdk.files.read({ hostId: source.hostId, path: abs, rootPath: source.path });
      files.push({ rel, content: file.content });
    } catch {
      // a missing prompt in the source — bb team doctor reports it in the target
    }
  }
  return { files, stripped };
}

const PROJECT_OPTION = {
  type: "string",
  description: "Project by ID or name; defaults to the thread's project or the current directory",
  placeholder: "<id|name>",
} as const;

export function parseTaskId(value: string): number {
  const id = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) {
    throw new PluginCliError(`task id must be a positive number: "${value}"`, {
      code: "invalid_value",
    });
  }
  return id;
}

function taskUpdateOutput(
  result: { task: TeamTask; previous: TeamTask; busy: TeamTask[] },
  json: boolean,
  workspace: Workspace,
  m: Messages,
): { exitCode: number; stdout: string } {
  if (json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        project: workspace.projectId,
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
}

/** Thread plugin metadata that marks a team thread. */
export function teamMetadata(role: Role): { teamRole: string; teamNotifyOn: string[] } {
  return { teamRole: role.name, teamNotifyOn: [...(role.notifyOn ?? [])] };
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
  if (!text) return null;
  const value = text.trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export type DoctorLevel = "ok" | "warn" | "fail";
export interface DoctorCheck {
  check: string;
  level: DoctorLevel;
  detail: string;
}

const snapshotSchema = z.custom<TeamSnapshot>(
  (value) => typeof value === "object" && value !== null && "roles" in value,
);
const taskSchema = z.custom<TeamTask>(
  (value) => typeof value === "object" && value !== null && "id" in value,
);
const projectIdSchema = z.string().min(1).max(200);

/** The Team panel's data plane (app.tsx imports only the type). */
export const rpcContract = defineRpcContract({
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  snapshot: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({ snapshot: snapshotSchema, language: z.enum(["en", "ru"]) }),
  },
  tell: {
    input: z
      .object({
        projectId: projectIdSchema,
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
        id: z.number().int().positive(),
        status: z.enum(TASK_STATUSES),
      })
      .strict(),
    output: z.object({ task: taskSchema }),
  },
  pause: {
    input: z.object({ projectId: projectIdSchema, paused: z.boolean() }).strict(),
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
      label: "Language",
      description:
        "CLI output and scaffold template language: en (English) or ru (Russian)",
    },
    teamSection: {
      type: "boolean",
      default: true,
      label: "Team sidebar section",
      description:
        "Keep team threads in a dedicated sidebar section (Team / Команда)",
    },
    roster: {
      type: "boolean",
      default: true,
      label: "Send team roster",
      description: "Send the team roster message to the lead after bb team create",
    },
  });

  const loadLang = async (): Promise<{ lang: Language; t: Strings }> => {
    const values = await settings.get();
    const lang: Language = values.language === "ru" ? "ru" : "en";
    currentLang = lang;
    return { lang, t: strings(lang) };
  };
  let currentLang: Language = "en";
  try {
    currentLang = (await settings.get()).language === "ru" ? "ru" : "en";
  } catch {
    // settings unavailable at load — English until the first command
  }
  const loadMsgs = async (): Promise<{ lang: Language; t: Strings; m: Messages }> => {
    const { lang, t } = await loadLang();
    return { lang, t, m: messages(lang) };
  };

  const publishChange = (projectId: string): void => {
    try {
      bb.realtime.publish("team-changed", { projectId });
    } catch {
      // no connected clients / server not bound yet — the panel refreshes itself
    }
  };

  /* ── Work packages: one kv store per project ── */

  const readTasks = async (projectId: string): Promise<TaskStore> =>
    normalizeTaskStore(await bb.storage.kv.get(taskKey(projectId)));
  const writeTasks = async (projectId: string, store: TaskStore): Promise<void> => {
    await bb.storage.kv.set(taskKey(projectId), store);
    publishChange(projectId);
  };
  const asCliError = (error: unknown): never => {
    if (error instanceof TaskError) {
      throw new PluginCliError(error.message, { code: error.code });
    }
    throw error;
  };

  /* ── Pause: executor threads whose agent messages wait in their queues ── */

  interface PauseState {
    threadIds: string[];
    atMs: number;
  }
  const pauseKey = (projectId: string) => `paused:${projectId}`;
  const pausedThreads = new Set<string>();
  const readPause = async (projectId: string): Promise<PauseState | null> =>
    (await bb.storage.kv.get<PauseState>(pauseKey(projectId))) ?? null;
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

  const leadRoleOf = (
    rows: Map<string, TeamThreadRow[]>,
    configLead: string | null,
  ): string | null => {
    if (configLead) return configLead;
    // No config: the lead is the role whose thread parents other team threads.
    const parents = new Set(
      [...rows.values()].flat().map((row) => row.parentThreadId).filter(Boolean),
    );
    for (const [role, list] of rows) {
      if (list.some((row) => parents.has(row.threadId))) return role;
    }
    return null;
  };

  const pause = async (
    workspace: Workspace,
  ): Promise<{ count: number; already: boolean }> => {
    const existing = await readPause(workspace.projectId);
    if (existing) return { count: existing.threadIds.length, already: true };
    const rows = await findTeamThreadRows(bb, workspace.projectId);
    let configLead: string | null = null;
    try {
      const { config } = await readTeamConfig(bb, workspace, strings(currentLang));
      configLead = semanticChecks(config).lead.name;
    } catch {
      // no config: infer the lead from the thread tree
    }
    const lead = leadRoleOf(rows, configLead);
    const threadIds = [...rows.entries()]
      .filter(([role]) => role !== lead)
      .flatMap(([, list]) => list.map((row) => row.threadId));
    await bb.storage.kv.set(pauseKey(workspace.projectId), {
      threadIds,
      atMs: Date.now(),
    } satisfies PauseState);
    for (const id of threadIds) pausedThreads.add(id);
    publishChange(workspace.projectId);
    return { count: threadIds.length, already: false };
  };

  const resume = async (workspace: Workspace): Promise<number | null> => {
    const existing = await readPause(workspace.projectId);
    if (!existing) return null;
    await bb.storage.kv.delete(pauseKey(workspace.projectId));
    for (const id of existing.threadIds) pausedThreads.delete(id);
    // Held rows are re-decided by core; with the pause gone they dispatch.
    await bb.experimental_hooks.recheck("message.dispatch");
    publishChange(workspace.projectId);
    return existing.threadIds.length;
  };

  /* ── Messages to roles ── */

  const tellRole = async (
    workspace: Workspace,
    wantedRole: string,
    text: string,
    t: Strings,
    senderThreadId?: string,
  ): Promise<{
    sent: Array<{ role: string; threadId: string }>;
    failed: Array<{ role: string; error: string }>;
  }> => {
    const rows = await findTeamThreadRows(bb, workspace.projectId);
    const targets: Array<[string, TeamThreadRow]> = [];
    if (wantedRole === "all") {
      // "all" never echoes the message back into the sender's own thread.
      for (const [role, list] of rows) {
        for (const row of list) {
          if (row.threadId !== senderThreadId) targets.push([role, row]);
        }
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

  const knownRoles = async (
    workspace: Workspace,
  ): Promise<{ roles: Set<string>; rows: Map<string, TeamThreadRow[]>; lead: string | null }> => {
    const rows = await findTeamThreadRows(bb, workspace.projectId);
    const roles = new Set(rows.keys());
    let configLead: string | null = null;
    try {
      const { config } = await readTeamConfig(bb, workspace, strings(currentLang));
      for (const role of config.roles) roles.add(role.name);
      configLead = semanticChecks(config).lead.name;
    } catch {
      // no config — thread roles only
    }
    return { roles, rows, lead: leadRoleOf(rows, configLead) };
  };

  const addPackage = async (
    workspace: Workspace,
    input: { role: string; title: string; note: string | null; send: boolean },
    m: Messages,
    senderThreadId?: string,
  ): Promise<{ task: TeamTask; sentTo: string | null; busy: TeamTask[] }> => {
    const { roles, rows, lead } = await knownRoles(workspace);
    if (!roles.has(input.role)) {
      const err = m.taskRoleUnknown(input.role);
      throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
    }
    const target = rows.get(input.role)?.[0] ?? null;
    if (input.send && !target) {
      const err = m.taskNoThread(input.role);
      throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
    }
    let store = await readTasks(workspace.projectId);
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
    await writeTasks(workspace.projectId, store);
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
            text: m.taskBody(
              task.id,
              task.title,
              task.note,
              leadThread ? `@thread:${leadThread}` : null,
            ),
            mentions: [],
          },
        ],
      });
      sentTo = target.threadId;
    }
    return { task, sentTo, busy };
  };

  const updatePackage = async (
    workspace: Workspace,
    id: number,
    patch: { status?: TaskStatus; title?: string; note?: string | null },
  ): Promise<{ task: TeamTask; previous: TeamTask; busy: TeamTask[] }> => {
    const store = await readTasks(workspace.projectId);
    try {
      const result = updateTask(store, id, patch, Date.now());
      await writeTasks(workspace.projectId, result.store);
      const busy =
        patch.status === "in-progress"
          ? busyTasks(result.store, result.task.role, result.task.id)
          : [];
      return { task: result.task, previous: result.previous, busy };
    } catch (error) {
      return asCliError(error);
    }
  };

  /** The machine a CLI invocation runs on: the thread's host, else the server. */
  const invokerHost = async (ctx: { threadId?: string }): Promise<string | null> => {
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
  };

  /* ── bb team doctor ── */

  const runDoctor = async (
    workspace: Workspace,
    t: Strings,
    m: Messages,
  ): Promise<DoctorCheck[]> => {
    const checks: DoctorCheck[] = [];
    const add = (check: string, level: DoctorLevel, detail: string) =>
      checks.push({ check, level, detail });
    const describe = (error: unknown) => {
      const hint = (error as PluginCliError).hint;
      return `${(error as Error).message}${hint ? ` (${hint})` : ""}`;
    };

    let config: TeamConfig | null = null;
    let lead: Role | null = null;
    let roles: Role[] = [];
    try {
      const loaded = await readTeamConfig(bb, workspace, t);
      config = loaded.config;
      ({ lead, roles } = semanticChecks(loaded.config, t));
      add(m.check.config, "ok", loaded.source);
    } catch (error) {
      add(
        m.check.config,
        "fail",
        (error as PluginCliError).code === "config_missing" ? m.check.configMissing : describe(error),
      );
    }
    const rows = await findTeamThreadRows(bb, workspace.projectId);

    if (config && lead) {
      const spawned = roles.filter((role) => !role.threadId);
      try {
        await validateProviders(bb, spawned, t);
        const used = [...new Set(spawned.map((role) => role.provider ?? "default"))];
        add(m.check.providers, "ok", used.join(", ") || m.doctorOk);
      } catch (error) {
        add(m.check.providers, "fail", describe(error));
      }

      let envFailures = 0;
      for (const role of spawned) {
        try {
          await resolveEnvironment(bb, workspace, roleEnvironmentSpec(role, config), t);
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
          const text = await loadRolePrompt(bb, workspace, role, t);
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
      if (varWarnings === 0 && config.vars) {
        add(m.check.vars, "ok", Object.keys(config.vars).join(", "));
      }

      for (const role of roles.filter((r) => r.threadId)) {
        try {
          const thread = await bb.sdk.threads.get({ threadId: role.threadId! });
          if (thread.projectId !== workspace.projectId) {
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

    try {
      const gitignore = await bb.sdk.files.read({
        hostId: workspace.hostId,
        path: joinPath(workspace.path, ".gitignore"),
        rootPath: workspace.path,
      });
      if (gitIgnoresBB(gitignore.content)) add(m.check.gitignore, "warn", m.doctorGitignored);
    } catch {
      // no .gitignore
    }
    if ((await readPause(workspace.projectId)) !== null) {
      add(m.check.threads, "warn", m.doctorPaused);
    }
    return checks;
  };

  /* ── Snapshot (status, report, panel) ── */

  const buildSnapshot = async (workspace: Workspace, t: Strings): Promise<TeamSnapshot> => {
    let config: TeamConfig | null = null;
    let configSource: string | null = null;
    let configError: string | null = null;
    let configLead: string | null = null;
    try {
      const loaded = await readTeamConfig(bb, workspace, t);
      config = loaded.config;
      configSource = loaded.source;
      configLead = semanticChecks(loaded.config, t).lead.name;
    } catch (error) {
      if ((error as PluginCliError).code !== "config_missing") {
        configError = (error as Error).message;
      }
    }
    const rows = await findTeamThreadRows(bb, workspace.projectId);
    const store = await readTasks(workspace.projectId);
    const paused = (await readPause(workspace.projectId)) !== null;
    const lead = leadRoleOf(rows, configLead);
    const toThreads = (list: TeamThreadRow[] | undefined) =>
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
    for (const role of config?.roles ?? []) {
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
        tasks: listTasks(store, { role: role.name }),
      });
    }
    const extraRoles = [
      ...rows.keys(),
      ...listTasks(store).map((task) => task.role),
    ];
    for (const name of extraRoles) {
      if (seen.has(name)) continue;
      seen.add(name);
      const list = rows.get(name);
      roles.push({
        name,
        title: list?.[0]?.title || name,
        lead: name === lead,
        inConfig: false,
        enabled: true,
        provider: list?.[0]?.provider ?? null,
        model: null,
        threads: toThreads(list),
        tasks: listTasks(store, { role: name }),
      });
    }
    roles.sort((a, b) => Number(b.lead) - Number(a.lead));
    return {
      projectId: workspace.projectId,
      projectName: workspace.projectName,
      configSource,
      configError,
      leadRole: lead,
      paused,
      roles,
      generatedAtMs: Date.now(),
    };
  };

  /* ── Lifecycle: live panel + opt-in lead notifications (role notifyOn) ── */

  const onTeamThreadEvent = async (
    thread: { id: string; projectId: string; parentThreadId: string | null },
    kind: NotifyEvent | "other",
    detail: string | null,
  ): Promise<void> => {
    let meta: Record<string, unknown>;
    try {
      meta = (await bb.sdk.threads.getPluginMetadata({ threadId: thread.id })) as Record<
        string,
        unknown
      >;
    } catch {
      return;
    }
    const role = meta.teamRole;
    if (typeof role !== "string") return;
    publishChange(thread.projectId);
    if (kind === "other" || !thread.parentThreadId) return;
    const notifyOn = Array.isArray(meta.teamNotifyOn) ? meta.teamNotifyOn : [];
    if (!notifyOn.includes(kind)) return;
    const m = messages(currentLang);
    const text =
      kind === "idle"
        ? m.notifyIdle(role, thread.id, excerpt(detail))
        : m.notifyError(role, thread.id, excerpt(detail, 300));
    await bb.sdk.threads.send({
      originPluginId: bb.pluginId,
      threadId: thread.parentThreadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    onTeamThreadEvent(thread, "idle", lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    onTeamThreadEvent(thread, "error", error),
  );
  bb.events.on("thread.active", ({ thread }) => onTeamThreadEvent(thread, "other", null));
  bb.events.on("thread.archived", ({ thread }) => onTeamThreadEvent(thread, "other", null));

  /* ── Team panel RPC ── */

  bb.rpc.register(rpcContract, {
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return { projects: projects.map((p) => ({ id: p.id, name: p.name })) };
    },
    async snapshot({ projectId }) {
      const { lang, t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      return { snapshot: await buildSnapshot(workspace, t), language: lang };
    },
    async tell({ projectId, role, text }) {
      const { t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      const result = await tellRole(workspace, role, text, t);
      return {
        sent: result.sent.length,
        failed: result.failed.length,
        paused: (await readPause(projectId)) !== null,
      };
    },
    async taskAdd({ projectId, role, title, note, send }) {
      const { t, m } = await loadMsgs();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      const result = await addPackage(workspace, { role, title, note: note ?? null, send }, m);
      return { task: result.task, sentTo: result.sentTo };
    },
    async taskUpdate({ projectId, id, status }) {
      const { t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      const result = await updatePackage(workspace, id, { status });
      return { task: result.task };
    },
    async pause({ projectId, paused }) {
      const { t } = await loadLang();
      const workspace = await resolveWorkspace(bb, projectId, undefined, t, {});
      if (paused) {
        const result = await pause(workspace);
        return { paused: true, count: result.count };
      }
      const count = await resume(workspace);
      return { paused: false, count: count ?? 0 };
    },
  });

  // Composer "@" menu: team roles of the current project, resolved into
  // agent-visible context at send time.
  try {
    const langNow = (await settings.get()).language === "ru" ? "ru" : "en";
    bb.ui.registerMentionProvider({
      id: "team-roles",
      label: strings(langNow).mentionLabel,
      search: async ({ query, projectId }): Promise<PluginMentionItem[]> => {
        if (!projectId) return [];
        try {
          const lang = (await settings.get()).language === "ru" ? "ru" : "en";
          const t = strings(lang);
          const rows = await findTeamThreadRows(bb, projectId);
          const q = query.trim().toLowerCase();
          const items: PluginMentionItem[] = [];
          for (const [role, list] of rows) {
            for (const row of list) {
              const hay = `${role} ${row.title}`.toLowerCase();
              if (q && !hay.includes(q)) continue;
              items.push({
                id: `${role}:${row.threadId}`,
                title: row.title || role,
                subtitle: t.mentionSubtitle(row.status, row.provider),
              });
            }
          }
          return items.slice(0, 8);
        } catch {
          return [];
        }
      },
      resolve: async (itemId) => {
        const idx = itemId.lastIndexOf(":");
        const role = idx > 0 ? itemId.slice(0, idx) : itemId;
        const threadId = idx > 0 ? itemId.slice(idx + 1) : "";
        const lang = (await settings.get()).language === "ru" ? "ru" : "en";
        return { context: strings(lang).mentionContext(role, threadId) };
      },
    });
  } catch (error) {
    bb.log.warn(`mention provider registration failed: ${(error as Error).message}`);
  }

  bb.cli.register(
    defineCli({
      name: "team",
      summary: "Role-based agent team for a project, configured in .bb/team.yaml",
      commands: {
        /* ── bb team init: write the team template ── */
        init: cliCommand({
          summary: "Write the team template into a project (.bb/team.yaml + role prompts)",
          options: {
            project: {
              type: "string",
              description: "Project by ID or name; defaults to the thread's project",
              placeholder: "<id|name>",
            },
            force: {
              type: "boolean",
              description: "Overwrite existing template files",
              short: "f",
            },
            template: {
              type: "enum",
              values: TEMPLATE_NAMES,
              description:
                "Preset: code (lead+developer+tester, default), qa (lead+tester), docs (lead+writer+reviewer)",
            },
            from: {
              type: "string",
              description:
                "Copy .bb/team.yaml and its role prompts from another project (threadId bindings are dropped)",
              placeholder: "<project>",
            },
            json: {
              type: "boolean",
              description: "Machine-readable output",
            },
          },
          constraints: [{ kind: "at-most-one", options: ["template", "from"] }],
          async run(input, ctx) {
            const { lang, t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(
              bb,
              input.options.project,
              ctx.projectId,
              t,
              ctx,
            );
            const templateName: TemplateName =
              input.options.template && isTemplateName(input.options.template)
                ? input.options.template
                : "code";
            let stripped = 0;
            let files: ReadonlyArray<{ rel: string; content: string }>;
            if (input.options.from) {
              const source = await resolveWorkspace(bb, input.options.from, undefined, t, {});
              const copied = await copyTeamFiles(bb, source, t, m);
              files = copied.files;
              stripped = copied.stripped;
            } else {
              files = templateFiles(lang, templateName);
            }
            const existing: string[] = [];
            for (const file of files) {
              const abs = joinPath(workspace.path, file.rel);
              try {
                await bb.sdk.files.read({
                  hostId: workspace.hostId,
                  path: abs,
                  rootPath: workspace.path,
                });
                existing.push(file.rel);
              } catch {
                // missing — will be created
              }
            }
            if (existing.length > 0 && !input.options.force) {
              const err = t.scaffoldExists(existing.join(", "));
              throw new PluginCliError(err.message, {
                code: "scaffold_exists",
                hint: err.hint,
              });
            }
            const written: string[] = [];
            for (const file of files) {
              const abs = joinPath(workspace.path, file.rel);
              await bb.sdk.files.write({
                hostId: workspace.hostId,
                path: abs,
                rootPath: workspace.path,
                content: file.content,
                createParents: true,
              });
              written.push(file.rel);
            }
            // Note: .bb may be gitignored — the team config is easy to lose.
            let gitignored = false;
            try {
              const gitignore = await bb.sdk.files.read({
                hostId: workspace.hostId,
                path: joinPath(workspace.path, ".gitignore"),
                rootPath: workspace.path,
              });
              gitignored = gitIgnoresBB(gitignore.content);
            } catch {
              // no .gitignore — nothing to warn about
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  template: input.options.from ? null : templateName,
                  from: input.options.from ?? null,
                  written,
                  strippedThreadIds: stripped,
                  gitignored,
                }),
              };
            }
            const out = [
              t.initTitle(workspace.projectName),
              ...written.map((rel) => `  ${joinPath(workspace.path, rel)}`),
              "",
              ...(input.options.from ? [] : [m.templateTitle(templateName)]),
              ...(stripped > 0 ? [m.fromStripped(stripped)] : []),
              ...t.initNext,
            ];
            if (gitignored) out.push("", ...t.gitignoreNote);
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team create: spawn the team ── */
        create: cliCommand({
          summary: "Spawn the team threads from .bb/team.yaml",
          options: {
            project: {
              type: "string",
              description: "Project by ID or name; defaults to the thread's project",
              placeholder: "<id|name>",
            },
            "dry-run": {
              type: "boolean",
              description: "Show the plan without creating anything",
            },
            json: {
              type: "boolean",
              description: "Machine-readable output",
            },
          },
          async run(input, ctx) {
            const { t } = await loadLang();
            const settingsValues = await settings.get();
            const workspace = await resolveWorkspace(
              bb,
              input.options.project,
              ctx.projectId,
              t,
              ctx,
            );
            const { config, source } = await readTeamConfig(bb, workspace, t);
            const { lead, roles } = semanticChecks(config, t);
            const defaults = config.defaults ?? {};
            await validateProviders(bb, roles.filter((r) => !r.threadId), t);
            const existing = await findExistingTeamThreads(bb, workspace.projectId);

            // Plan: role → environment and prompt (adopted threads need neither).
            interface PlanEntry {
              role: Role;
              environment: SpawnEnvironment | null;
              prompt: string;
            }
            const plan: PlanEntry[] = [];
            for (const role of roles) {
              if (role.threadId) {
                plan.push({ role, environment: null, prompt: "" });
                continue;
              }
              const environment = await resolveEnvironment(
                bb,
                workspace,
                roleEnvironmentSpec(role, config),
                t,
              );
              const rawPrompt = await loadRolePrompt(bb, workspace, role, t);
              plan.push({ role, environment, prompt: rawPrompt });
            }

            // Validate an adoptable thread: exists, same project, not archived.
            const getAdoptableThread = async (
              entry: PlanEntry,
            ): Promise<Awaited<ReturnType<typeof bb.sdk.threads.get>>> => {
              const id = entry.role.threadId!;
              let thread;
              try {
                thread = await bb.sdk.threads.get({ threadId: id });
              } catch {
                throw new PluginCliError(t.threadNotFound(entry.role.name, id), {
                  code: "thread_not_found",
                });
              }
              if (thread.projectId !== workspace.projectId) {
                throw new PluginCliError(
                  t.threadWrongProject(entry.role.name, id),
                  { code: "thread_wrong_project" },
                );
              }
              if (thread.archivedAt !== null) {
                const err = t.threadArchived(entry.role.name, id);
                throw new PluginCliError(err.message, {
                  code: "thread_archived",
                  hint: err.hint,
                });
              }
              return thread;
            };

            if (input.options["dry-run"]) {
              const out = [t.planTitle(source, workspace.projectName)];
              for (const entry of plan) {
                const already = existing.get(entry.role.name);
                out.push("");
                out.push(
                  `${entry.role.name}${entry.role.name === lead.name ? " [lead]" : ""}:`,
                );
                if (entry.role.threadId) {
                  const thread = await getAdoptableThread(entry);
                  out.push(
                    line(
                      t.labels.thread,
                      t.adoptExisting(entry.role.threadId!, thread.status, thread.title ?? ""),
                    ),
                  );
                  continue;
                }
                out.push(
                  line(
                    t.labels.thread,
                    already
                      ? t.alreadyCreated(already.join(", "))
                      : t.willCreate,
                  ),
                );
                out.push(line(t.labels.title, entry.role.title ?? entry.role.name));
                out.push(
                  line(
                    t.labels.provider,
                    entry.role.provider ?? t.labels.projectDefault,
                  ),
                );
                if (entry.role.model) {
                  out.push(line(t.labels.model, entry.role.model));
                }
                out.push(
                  line(
                    t.labels.environment,
                    JSON.stringify(entry.environment).slice(0, 120),
                  ),
                );
                out.push(
                  line(
                    t.labels.prompt,
                    entry.prompt.split("\n")[0]!.slice(0, 80) + "…",
                  ),
                );
              }
              return { exitCode: 0, stdout: out.join("\n") };
            }

            // Sidebar section for team threads (setting: teamSection).
            const sectionId = settingsValues.teamSection
              ? await ensureTeamSection(bb, t)
              : null;

            // Spawn: the lead first, then executors as its child threads.
            // Roles with threadId adopt existing threads without spawning.
            const roleThreads = new Map<string, string>();
            const roleProviders = new Map<string, string>();
            const spawned: Array<{
              role: string;
              kind: "created" | "adopted";
              title: string;
              threadId: string;
              provider: string;
            }> = [];
            let leadThreadId: string | null = null;
            const existingLead = existing.get(lead.name)?.[0] ?? null;

            interface SpawnOutcome {
              threadId: string;
              providerId: string;
            }
            const spawnRole = async (
              entry: PlanEntry,
              parentThreadId: string | undefined,
            ): Promise<SpawnOutcome> => {
              const prompt = applyPlaceholders(
                entry.prompt,
                { workspace, leadThreadId, roleThreads, teamVars: config.vars },
                t,
              );
              const spawnArgs = {
                projectId: workspace.projectId,
                title: entry.role.title ?? entry.role.name,
                providerId: entry.role.provider,
                model: entry.role.model,
                reasoningLevel: entry.role.reasoningLevel,
                serviceTier: entry.role.serviceTier,
                permissionMode:
                  entry.role.permissionMode ?? defaults.permissionMode,
                environment: entry.environment!,
                sectionId,
                parentThreadId,
                parentNotifications: parentThreadId
                  ? entry.role.parentNotifications ?? defaults.parentNotifications
                  : undefined,
                pluginMetadata: teamMetadata(entry.role),
                prompt,
              };
              // A brand-new environment can fail its very first spawn while
              // provisioning (observed as an HTTP 500); one retry after a
              // short delay clears it. A second failure surfaces to the user
              // with an idempotent re-run hint.
              for (let attempt = 1; ; attempt += 1) {
                try {
                  const thread = await bb.sdk.threads.spawn(spawnArgs);
                  return { threadId: thread.id, providerId: thread.providerId };
                } catch (error) {
                  if (attempt >= 2) {
                    const err = t.spawnFailed(
                      entry.role.name,
                      (error as Error).message,
                    );
                    throw new PluginCliError(err.message, {
                      code: "spawn_failed",
                      hint: err.hint,
                    });
                  }
                  await new Promise((resolve) => setTimeout(resolve, 1500));
                }
              }
            };

            const adoptRole = async (
              entry: PlanEntry,
              parentThreadId: string | undefined,
            ): Promise<SpawnOutcome> => {
              const id = entry.role.threadId!;
              const thread = await getAdoptableThread(entry);
              await bb.sdk.threads.updatePluginMetadata({
                threadId: id,
                set: teamMetadata(entry.role),
              });
              if (
                parentThreadId &&
                thread.parentThreadId !== parentThreadId
              ) {
                await bb.sdk.threads.update({
                  threadId: id,
                  parentThreadId,
                });
              }
              if (sectionId && thread.sectionId !== sectionId) {
                await bb.sdk.threads.update({ threadId: id, sectionId });
              }
              return { threadId: id, providerId: thread.providerId };
            };

            const upsertRole = async (
              entry: PlanEntry,
              parentThreadId: string | undefined,
            ): Promise<SpawnOutcome> =>
              entry.role.threadId
                ? adoptRole(entry, parentThreadId)
                : spawnRole(entry, parentThreadId);

            // The lead.
            if (!lead.threadId && existingLead) {
              leadThreadId = existingLead;
              roleThreads.set(lead.name, existingLead);
            } else {
              const leadEntry = plan.find((p) => p.role.name === lead.name)!;
              const result = await upsertRole(leadEntry, undefined);
              leadThreadId = result.threadId;
              roleThreads.set(lead.name, result.threadId);
              roleProviders.set(lead.name, result.providerId);
              spawned.push({
                role: lead.name,
                kind: lead.threadId ? "adopted" : "created",
                title: lead.title ?? lead.name,
                threadId: result.threadId,
                provider: result.providerId,
              });
            }

            // Executors.
            for (const entry of plan) {
              if (entry.role.name === lead.name) continue;
              const already = existing.get(entry.role.name);
              if (!entry.role.threadId && already && already.length > 0) continue;
              const result = await upsertRole(entry, leadThreadId ?? undefined);
              roleThreads.set(entry.role.name, result.threadId);
              roleProviders.set(entry.role.name, result.providerId);
              spawned.push({
                role: entry.role.name,
                kind: entry.role.threadId ? "adopted" : "created",
                title: entry.role.title ?? entry.role.name,
                threadId: result.threadId,
                provider: result.providerId,
              });
            }

            // Roster to the lead (setting: roster).
            const children = plan.filter(
              (p) => p.role.name !== lead.name && roleThreads.has(p.role.name),
            );
            let rosterQueued = false;
            if (settingsValues.roster && leadThreadId && children.length > 0) {
              const roster = [
                t.rosterLines.header,
                "",
                t.rosterLines.executors,
                ...children.map(
                  (c) =>
                    `- ${c.role.title ?? c.role.name} — @thread:${roleThreads.get(c.role.name) ?? existing.get(c.role.name)![0]} (provider: ${roleProviders.get(c.role.name) ?? c.role.provider ?? t.rosterLines.defaultProvider})`,
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

            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  leadThreadId,
                  sectionId,
                  spawned,
                  existing: Object.fromEntries(existing),
                  rosterQueued,
                }),
              };
            }
            const out = [t.createTitle(workspace.projectName, source)];
            for (const item of spawned) {
              const label = item.kind === "adopted" ? t.adopted : t.created;
              out.push(
                `  [${label}] ${item.role} — ${item.title} — @thread:${item.threadId}`,
              );
            }
            const reported = new Set(spawned.map((item) => item.threadId));
            for (const [role, ids] of existing) {
              const remaining = ids.filter((id) => !reported.has(id));
              if (remaining.length === 0) continue;
              out.push(t.alreadyThere(role, remaining.join(", ")));
            }
            if (rosterQueued && leadThreadId) {
              out.push("");
              out.push(t.rosterSent(leadThreadId));
            }
            out.push("");
            out.push("bb team status");
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team tell: message to a role by name ── */
        tell: cliCommand({
          summary: "Send a message to a team role by name (or all)",
          positionals: [
            {
              name: "role",
              required: true,
              description: "Role name, or \"all\" for every bound role",
            },
          ],
          options: {
            project: {
              type: "string",
              description: "Project by ID or name; defaults to the thread's project",
              placeholder: "<id|name>",
            },
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
            json: {
              type: "boolean",
              description: "Machine-readable output",
            },
          },
          constraints: [
            { kind: "exactly-one", options: ["message", "message-file"] },
          ],
          async run(input, ctx) {
            const { t } = await loadLang();
            const workspace = await resolveWorkspace(
              bb,
              input.options.project,
              ctx.projectId,
              t,
              ctx,
            );
            const wantedRole = input.positionals.role!;

            let text = input.options.message;
            if (!text) {
              const rel = input.options["message-file"]!;
              // A CLI-local path names a file on the invoking machine, so the
              // read goes through the files API with that host, not node:fs.
              let hostId: string | null = null;
              if (ctx.threadId) {
                try {
                  const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
                  if (thread.environmentId) {
                    const environment = await bb.sdk.environments.get({
                      environmentId: thread.environmentId,
                    });
                    hostId = environment.hostId;
                  }
                } catch {
                  // fall back to the server host below
                }
              }
              try {
                if (!hostId) hostId = (await bb.sdk.system.config()).primaryHostId;
              } catch {
                hostId = null;
              }
              const isAbsolute = rel.startsWith("/");
              const abs = isAbsolute ? rel : joinPath(workspace.path, rel);
              if (!isAbsolute) requireInsideWorkspace(workspace.path, abs);
              try {
                const file = await bb.sdk.files.read({ hostId: hostId ?? undefined, path: abs });
                text = file.content;
              } catch {
                throw new PluginCliError(t.tellFileReadFailed(rel), {
                  code: "message_file_missing",
                });
              }
            }
            if (!text || text.trim().length === 0) {
              throw new PluginCliError(t.tellMessageRequired.message, {
                code: "message_required",
                hint: t.tellMessageRequired.hint,
              });
            }

            const { sent, failed } = await tellRole(
              workspace,
              wantedRole,
              text,
              t,
              ctx.threadId,
            );
            const paused = (await readPause(workspace.projectId)) !== null;

            if (input.options.json) {
              return {
                exitCode: failed.length > 0 && sent.length === 0 ? 1 : 0,
                stdout: JSON.stringify({
                  ok: failed.length === 0,
                  project: workspace.projectId,
                  role: wantedRole,
                  sent,
                  failed,
                  paused,
                }),
              };
            }
            const out: string[] = [];
            for (const item of sent) out.push(t.tellSent(item.role, item.threadId));
            for (const item of failed) out.push(t.tellFailed(item.role, item.error));
            out.push("");
            out.push(t.tellSummary(sent.length, failed.length));
            if (paused && sent.length > 0) out.push(messages(currentLang).tellPausedNote);
            return { exitCode: sent.length > 0 ? 0 : 1, stdout: out.join("\n") };
          },
        }),

        /* ── bb team report: visual digest ── */
        report: cliCommand({
          summary: "Team digest: an inline-vis HTML page (--out) or Markdown on stdout",
          options: {
            project: PROJECT_OPTION,
            format: {
              type: "enum",
              values: ["html", "md"] as const,
              description: "html (default with --out) or md (default without)",
            },
            out: {
              type: "string",
              description:
                'File to write on the invoking machine, e.g. "$BB_THREAD_STORAGE/team-report.html"',
              placeholder: "<file>",
            },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { lang, t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const snapshot = await buildSnapshot(workspace, t);
            const nowMs = Date.now();
            const format = input.options.format ?? (input.options.out ? "html" : "md");
            const body =
              format === "html"
                ? renderReportHtml(snapshot, lang, nowMs)
                : renderReportMarkdown(snapshot, lang, nowMs);
            if (!input.options.out) {
              if (format === "html") {
                throw new PluginCliError(m.reportOutRequired.message, {
                  code: "out_required",
                  hint: m.reportOutRequired.hint,
                });
              }
              if (input.options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ ok: true, project: workspace.projectId, markdown: body }),
                };
              }
              return { exitCode: 0, stdout: body };
            }
            const base = ctx.cwd?.replace(/\/+$/, "") || workspace.path;
            const outPath = input.options.out.startsWith("/")
              ? input.options.out
              : joinPath(base, input.options.out);
            if (!/\.(html?|md|markdown)$/i.test(outPath)) {
              throw new PluginCliError(`--out must end in .html or .md: ${outPath}`, {
                code: "invalid_value",
              });
            }
            const hostId = await invokerHost(ctx);
            await bb.sdk.files.write({
              hostId: hostId ?? undefined,
              path: outPath,
              content: body,
              createParents: true,
            });
            // In a thread, point at the file with the inline-vis directive.
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
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  path: outPath,
                  format,
                  directive,
                }),
              };
            }
            const out = [m.reportWritten(outPath)];
            if (directive) out.push("", m.reportShow, directive);
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team task …: work packages ── */
        "task add": cliCommand({
          summary: "Add a work package for a role (--send hands it to the role's thread)",
          positionals: [
            { name: "role", required: true, description: "Role name" },
            { name: "title", required: true, variadic: true, description: "Package title" },
          ],
          options: {
            project: PROJECT_OPTION,
            note: {
              type: "string",
              description: "Details sent with the package; --note-stdin reads them from stdin",
              stdin: true,
            },
            send: {
              type: "boolean",
              description: "Send the package to the role's thread and mark it in-progress",
            },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const title = (input.positionals.title as string[]).join(" ");
            const result = await addPackage(
              workspace,
              {
                role: input.positionals.role!,
                title,
                note: input.options.note ?? null,
                send: input.options.send,
              },
              m,
              ctx.threadId,
            );
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
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
              out.push(
                `  ${m.taskBusy(result.task.role, result.busy.map((task) => `#${task.id}`).join(", "))}`,
              );
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        "task list": cliCommand({
          summary: "List work packages (open ones by default)",
          options: {
            project: PROJECT_OPTION,
            role: { type: "string", description: "Only this role", placeholder: "<role>" },
            all: { type: "boolean", description: "Include done and dropped packages" },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const store = await readTasks(workspace.projectId);
            const tasks = listTasks(store, {
              role: input.options.role,
              includeClosed: input.options.all,
            }).slice(-100);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, project: workspace.projectId, tasks }),
              };
            }
            if (tasks.length === 0) return { exitCode: 0, stdout: m.taskListEmpty };
            const nowMs = Date.now();
            const out = [m.taskListTitle(workspace.projectName)];
            for (const task of tasks) {
              out.push(
                `  #${task.id} [${task.status}] ${task.role} — ${task.title} · ${relativeAgo(task.updatedAtMs, nowMs)}`,
              );
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        "task update": cliCommand({
          summary: "Change a work package: status, title or note",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            status: {
              type: "string",
              description: `New status: ${TASK_STATUSES.join(" | ")}`,
              placeholder: "<status>",
            },
            title: { type: "string", description: "New title" },
            note: { type: "string", description: "New note (empty string clears it)", stdin: true },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          constraints: [{ kind: "at-least-one", options: ["status", "title", "note"] }],
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const id = parseTaskId(input.positionals.id!);
            let status: TaskStatus | undefined;
            try {
              status = input.options.status ? parseTaskStatus(input.options.status) : undefined;
            } catch (error) {
              return asCliError(error);
            }
            const result = await updatePackage(workspace, id, {
              status,
              title: input.options.title,
              note: input.options.note,
            });
            return taskUpdateOutput(result, input.options.json, workspace, m);
          },
        }),

        "task done": cliCommand({
          summary: "Accept a work package (status done)",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const result = await updatePackage(workspace, parseTaskId(input.positionals.id!), {
              status: "done",
            });
            return taskUpdateOutput(result, input.options.json, workspace, m);
          },
        }),

        "task remove": cliCommand({
          summary: "Delete a work package (use status dropped to keep a record)",
          positionals: [{ name: "id", required: true, description: "Package number" }],
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const id = parseTaskId(input.positionals.id!);
            const store = await readTasks(workspace.projectId);
            let next: TaskStore;
            try {
              ({ store: next } = removeTask(store, id));
            } catch (error) {
              return asCliError(error);
            }
            await writeTasks(workspace.projectId, next);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ok: true, removed: id }) };
            }
            return { exitCode: 0, stdout: m.taskRemoved(id) };
          },
        }),

        /* ── bb team doctor: pre-flight checks ── */
        doctor: cliCommand({
          summary: "Check config, providers, environments, prompts and team threads",
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const checks = await runDoctor(workspace, t, m);
            const fail = checks.filter((c) => c.level === "fail").length;
            const warn = checks.filter((c) => c.level === "warn").length;
            if (input.options.json) {
              return {
                exitCode: fail > 0 ? 1 : 0,
                stdout: JSON.stringify({
                  ok: fail === 0,
                  project: workspace.projectId,
                  fail,
                  warn,
                  checks,
                }),
              };
            }
            const out = [m.doctorTitle(workspace.projectName)];
            for (const check of checks) {
              const mark = check.level === "ok" ? "ok  " : check.level === "warn" ? "warn" : "FAIL";
              out.push(`  [${mark}] ${check.check}: ${check.detail}`);
            }
            out.push("");
            out.push(fail + warn === 0 ? m.doctorAllGood : m.doctorSummary(fail, warn));
            return { exitCode: fail > 0 ? 1 : 0, stdout: out.join("\n") };
          },
        }),

        /* ── bb team replace: fresh thread for a role, with a handoff ── */
        replace: cliCommand({
          summary: "Move a role onto a fresh thread: handoff of its last report and open packages",
          positionals: [{ name: "role", required: true, description: "Role name" }],
          options: {
            project: PROJECT_OPTION,
            thread: {
              type: "string",
              description: "The thread to replace when the role has several",
              placeholder: "<thr_…>",
            },
            keep: {
              type: "boolean",
              description: "Keep the old thread (unbound from the role) instead of archiving it",
            },
            "dry-run": { type: "boolean", description: "Show the plan without changing anything" },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const settingsValues = await settings.get();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const roleName = input.positionals.role!;
            const { config } = await readTeamConfig(bb, workspace, t);
            const { lead, roles } = semanticChecks(config, t);
            const role = roles.find((r) => r.name === roleName);
            if (!role) {
              const err = m.taskRoleUnknown(roleName);
              throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
            }
            const rows = await findTeamThreadRows(bb, workspace.projectId);
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
            if (!role.prompt && !role.promptFile) {
              const err = m.replaceNeedsPrompt(roleName);
              throw new PluginCliError(err.message, { code: "config_invalid", hint: err.hint });
            }
            const isLead = role.name === lead.name;
            if (input.options["dry-run"]) {
              const plan = m.replacePlan(roleName, old.threadId);
              if (input.options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ ok: true, dryRun: true, role: roleName, oldThreadId: old.threadId }),
                };
              }
              return { exitCode: 0, stdout: plan };
            }

            await validateProviders(bb, [role], t);
            const environment = await resolveEnvironment(
              bb,
              workspace,
              roleEnvironmentSpec(role, config),
              t,
            );
            let output: string | null = null;
            try {
              output = excerpt((await bb.sdk.threads.output({ threadId: old.threadId })).output, 4000);
            } catch {
              output = null;
            }
            const openTasks = listTasks(await readTasks(workspace.projectId), { role: roleName });
            const taskLines = openTasks
              .map((task) => `- #${task.id} ${task.title} [${task.status}]`)
              .join("\n");
            const roleThreads = new Map<string, string>();
            for (const [name, threads] of rows) {
              if (threads[0]) roleThreads.set(name, threads[0].threadId);
            }
            const leadThreadId = isLead ? null : roleThreads.get(lead.name) ?? null;
            const rawPrompt = await loadRolePrompt(bb, workspace, role, t);
            const prompt =
              applyPlaceholders(
                rawPrompt,
                { workspace, leadThreadId, roleThreads, teamVars: config.vars },
                t,
              ) + m.replaceHandoff(`@thread:${old.threadId}`, output, taskLines);
            const sectionId = settingsValues.teamSection ? await ensureTeamSection(bb, t) : null;
            const defaults = config.defaults ?? {};
            const spawnArgs = {
              projectId: workspace.projectId,
              title: role.title ?? role.name,
              providerId: role.provider,
              model: role.model,
              reasoningLevel: role.reasoningLevel,
              serviceTier: role.serviceTier,
              permissionMode: role.permissionMode ?? defaults.permissionMode,
              environment,
              sectionId,
              parentThreadId: leadThreadId ?? undefined,
              parentNotifications: leadThreadId
                ? role.parentNotifications ?? defaults.parentNotifications
                : undefined,
              pluginMetadata: teamMetadata(role),
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
              remove: ["teamRole", "teamNotifyOn"],
            });
            let reparented = 0;
            if (isLead) {
              for (const threads of rows.values()) {
                for (const row of threads) {
                  if (row.parentThreadId !== old.threadId || row.threadId === old.threadId) continue;
                  await bb.sdk.threads.update({ threadId: row.threadId, parentThreadId: fresh.id });
                  reparented += 1;
                }
              }
            }
            if (!input.options.keep) {
              await bb.sdk.threads.archive({ threadId: old.threadId });
            }
            const pauseState = await readPause(workspace.projectId);
            if (pauseState?.threadIds.includes(old.threadId)) {
              const threadIds = pauseState.threadIds.map((id) => (id === old!.threadId ? fresh.id : id));
              await bb.storage.kv.set(pauseKey(workspace.projectId), { ...pauseState, threadIds });
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
            publishChange(workspace.projectId);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
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
          positionals: [
            {
              name: "role",
              description: 'Role name, or "all"; default: every executor (not the lead)',
            },
          ],
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const { rows, lead } = await knownRoles(workspace);
            const wanted = input.positionals.role;
            if (wanted && wanted !== "all" && !rows.has(wanted)) {
              const err = t.tellRoleNotFound(wanted);
              throw new PluginCliError(err.message, { code: "role_not_found", hint: err.hint });
            }
            const stopped: Array<{ role: string; threadId: string }> = [];
            const failed: Array<{ role: string; error: string }> = [];
            for (const [role, list] of rows) {
              if (wanted && wanted !== "all" && role !== wanted) continue;
              if (!wanted && role === lead) continue;
              for (const row of list) {
                if (!["active", "starting", "pending"].includes(row.status)) continue;
                if (row.threadId === ctx.threadId) continue;
                try {
                  await bb.sdk.threads.stop({ threadId: row.threadId });
                  stopped.push({ role, threadId: row.threadId });
                } catch (error) {
                  failed.push({ role, error: (error as Error).message });
                }
              }
            }
            if (stopped.length > 0) publishChange(workspace.projectId);
            if (input.options.json) {
              return {
                exitCode: failed.length > 0 ? 1 : 0,
                stdout: JSON.stringify({ ok: failed.length === 0, stopped, failed }),
              };
            }
            if (stopped.length + failed.length === 0) return { exitCode: 0, stdout: m.stopNone };
            const out = [
              ...stopped.map((item) => m.stopped(item.role, item.threadId)),
              ...failed.map((item) => m.stopFailed(item.role, item.error)),
            ];
            return { exitCode: failed.length > 0 ? 1 : 0, stdout: out.join("\n") };
          },
        }),

        pause: cliCommand({
          summary: "Hold agent messages to every executor until bb team resume",
          options: {
            project: PROJECT_OPTION,
            stop: { type: "boolean", description: "Also stop executors that are running now" },
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const result = await pause(workspace);
            const stopped: string[] = [];
            if (input.options.stop) {
              const rows = await findTeamThreadRows(bb, workspace.projectId);
              for (const row of [...rows.values()].flat()) {
                if (!pausedThreads.has(row.threadId)) continue;
                if (!["active", "starting", "pending"].includes(row.status)) continue;
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
                stdout: JSON.stringify({
                  ok: true,
                  paused: true,
                  already: result.already,
                  count: result.count,
                  stopped,
                }),
              };
            }
            const out = [result.already ? m.pausedAlready : m.paused(result.count)];
            for (const id of stopped) out.push(m.stopped("", id).replace("  ", " "));
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),

        resume: cliCommand({
          summary: "Release a paused team: held messages are delivered",
          options: {
            project: PROJECT_OPTION,
            json: { type: "boolean", description: "Machine-readable output" },
          },
          async run(input, ctx) {
            const { t, m } = await loadMsgs();
            const workspace = await resolveWorkspace(bb, input.options.project, ctx.projectId, t, ctx);
            const count = await resume(workspace);
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, resumed: count !== null, count: count ?? 0 }),
              };
            }
            return { exitCode: 0, stdout: count === null ? m.notPaused : m.resumed(count) };
          },
        }),

        /* ── bb team status ── */
        status: cliCommand({
          summary: "Show the team config and the spawned threads",
          options: {
            project: {
              type: "string",
              description: "Project by ID or name; defaults to the thread's project",
              placeholder: "<id|name>",
            },
            json: {
              type: "boolean",
              description: "Machine-readable output",
            },
          },
          async run(input, ctx) {
            const { t } = await loadLang();
            const workspace = await resolveWorkspace(
              bb,
              input.options.project,
              ctx.projectId,
              t,
              ctx,
            );
            const snapshot = await buildSnapshot(workspace, t);
            const nowMs = Date.now();
            const configReport = snapshot.configSource
              ? {
                  source: snapshot.configSource,
                  lead: snapshot.leadRole,
                  roles: snapshot.roles
                    .filter((role) => role.inConfig)
                    .map((role) => `${role.name}${role.enabled ? "" : t.labels.disabledRole}`),
                }
              : null;

            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  config: configReport,
                  configError: snapshot.configError,
                  paused: snapshot.paused,
                  threads: Object.fromEntries(
                    snapshot.roles
                      .filter((role) => role.threads.length > 0)
                      .map((role) => [role.name, role.threads]),
                  ),
                  tasks: Object.fromEntries(
                    snapshot.roles
                      .filter((role) => role.tasks.length > 0)
                      .map((role) => [role.name, role.tasks]),
                  ),
                }),
              };
            }
            const m = messages(currentLang);
            const out = [t.statusTitle(workspace.projectName)];
            if (configReport) {
              out.push(`  ${t.labels.config}: ${configReport.source}`);
              out.push(`  ${t.labels.lead}: ${configReport.lead ?? "—"}`);
              out.push(`  ${t.labels.roles}: ${configReport.roles.join(", ")}`);
            } else {
              out.push(`  ${t.statusNoConfig}`);
            }
            if (snapshot.configError) out.push(`  ! ${snapshot.configError}`);
            if (snapshot.paused) out.push(`  ${m.doctorPaused}`);
            if (snapshot.roles.every((role) => role.threads.length === 0)) {
              out.push(`  ${t.statusThreadsEmpty}`);
            } else {
              out.push(`  ${t.statusThreads}`);
              for (const role of snapshot.roles) {
                if (!role.enabled && role.threads.length === 0) continue;
                const task = currentTask(role.tasks);
                const taskText = task ? ` · #${task.id} ${task.title} [${task.status}]` : "";
                if (role.threads.length === 0) {
                  out.push(`    ${role.name}: ${t.statusNoThread}${taskText}`);
                  continue;
                }
                for (const row of role.threads) {
                  out.push(
                    `    ${role.name}: ${row.threadId} [${row.status}] ${row.provider} — ${row.title || role.title} ${t.statusActivity(relativeAgo(row.updatedAtMs, nowMs))}${taskText}`,
                  );
                }
              }
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),
      },
    }),
  );
}