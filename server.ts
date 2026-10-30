// bb-plugin-team — role-based agent team for a project, configured in .bb/team.yaml.
//
// Commands (bb team --help):
//   bb team init    — write the team template (.bb/team.yaml + role prompts)
//   bb team create  — spawn the team threads (lead + executors)
//   bb team status  — show the config and the live team threads
//
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
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";

const CONFIG_PATH = ".bb/team.yaml";
const CONFIG_PATH_JSON = ".bb/team.json";
const ROLES_DIR = ".bb/team/roles";

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

export type Language = "en" | "ru";

/* ──────────────────────── Config schema ──────────────────────── */

const PARENT_NOTIFICATIONS = ["auto", "stuck", "off"] as const;
const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

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
  prompt: z.string().optional(),
  promptFile: z.string().optional(),
});

export const teamConfigSchema = z.object({
  version: z.literal(1).default(1),
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
      "  3) bb team create — spawn the team threads",
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
      tell: "Assign tasks with: bb thread tell <thread-id> --message-file -",
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
      "  3) bb team create — поднять команду тредов",
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
      tell: "Задачи выдавай так: bb thread tell <thread-id> --message-file -",
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

/* ──────────────────────── Templates (bb team init) ──────────────────────── */

const TEAM_YAML = {
  en: `\
# Agent team for this project. Spawn: bb team create
# Overview: bb team status
version: 1

# Defaults (any role may override its own).
defaults:
  # Thread environment:
  #   checkout   — the project checkout: every role shares one working tree
  #   default    — the project default environment (usually a worktree)
  #   worktree   — a managed worktree off the default branch per role
  #   env:<id>   — a specific environment by ID (bb environment list)
  environment: checkout
  # When children wake the lead: auto | stuck | off.
  # stuck — failures and blockers only; reports arrive as messages.
  parentNotifications: stuck

# Roles. The lead: lead: true, or the first role.
# Every other role becomes a child thread of the lead and reports to it.
# Prompt placeholders: {{leadThreadId}}, {{leadThreadRef}},
# {{role.<name>.threadId}}, {{role.<name>.ref}}, {{projectId}}, {{workspacePath}}
roles:
  - name: lead
    title: Development lead
    provider: codex
    promptFile: .bb/team/roles/lead.md
    # model: ...            # a concrete model for the role
    # permissionMode: auto  # accept-edits | auto | full
    # threadId: thr_...     # adopt an existing thread instead of spawning

  - name: developer
    title: Developer
    provider: pi
    promptFile: .bb/team/roles/developer.md

  - name: tester
    title: Tester
    provider: codex
    promptFile: .bb/team/roles/tester.md

  # New role — copy a block; disable without deleting: enabled: false
`,
  ru: `\
# Команда агентов для этого проекта. Запуск: bb team create
# Просмотр состава: bb team status
version: 1

# Общие настройки (любая роль может переопределить своё).
defaults:
  # Окружение тредов:
  #   checkout   — общий checkout проекта: все роли видят одно рабочее дерево
  #   default    — стандартное окружение проекта (обычно отдельный worktree)
  #   worktree   — отдельный управляемый worktree от ветки по умолчанию
  #   env:<id>   — конкретное окружение по ID (bb environment list)
  environment: checkout
  # Когда дети будят руководителя: auto | stuck | off.
  # stuck — только сбои и блокировки; отчёты приходят обычными сообщениями.
  parentNotifications: stuck

# Роли. Руководитель: lead: true или первая роль.
# Остальные роли становятся дочерними тредами руководителя и отчитываются ему.
# В промптах доступны подстановки: {{leadThreadId}}, {{leadThreadRef}},
# {{role.<имя>.threadId}}, {{role.<имя>.ref}}, {{projectId}}, {{workspacePath}}
roles:
  - name: lead
    title: Руководитель разработки
    provider: codex
    promptFile: .bb/team/roles/lead.md
    # model: ...            # модель роли, если нужна не по умолчанию
    # permissionMode: auto  # accept-edits | auto | full
    # threadId: thr_...     # привязать существующий тред вместо создания нового

  - name: developer
    title: Разработчик
    provider: pi
    promptFile: .bb/team/roles/developer.md

  - name: tester
    title: Тестировщик
    provider: codex
    promptFile: .bb/team/roles/tester.md

  # Новая роль — скопируйте блок; выключить без удаления: enabled: false
`,
};

const ROLE_PROMPTS: Record<Language, Record<"lead" | "developer" | "tester", string>> = {
  en: {
    lead: `\
You are the development lead on this project.

You are the head thread of a team: the executors are your child threads
and report to you by message. A "Team roster" message with their thread IDs
arrives right after team creation.

Your responsibilities:
- take the task from the user, clarify the scope, break it into work packages;
- assign packages to executors: bb thread tell <thread-id> --message-file -
- review diffs (by reading code; no heavy runs unless agreed otherwise);
- own acceptance: a package closes when review remarks are fixed and checks pass;
- integration checks and test runs belong to the tester — do not run them yourself
  unless necessary.

Rules:
- one active package per executor; the next one goes out after the current is accepted;
- commits only by explicit agreement, as a separate decision;
- the acceptance summary: status (in work / review / tested / accepted),
  changed files, risks.

Confirm readiness in one line and wait for the user's task.
`,
    developer: `\
You are a developer on this project.

The development lead is thread {{leadThreadRef}} ({{leadThreadId}}).
Tasks and reviews come from them; send your results to them.

Working rules:
- clarify the package scope with the lead before starting;
- keep changes in the working tree without commits until a commit is explicitly agreed;
- when a package is done, report to the lead:
  bb thread tell {{leadThreadId}} --message-file -
  report contents: changed files and what they do; what was verified locally;
  what needs integration checks; risks and assumptions;
- do not start the next package until the current one is accepted.

Confirm readiness in one line and wait for your task.
`,
    tester: `\
You are a tester on this project.

The development lead is thread {{leadThreadRef}} ({{leadThreadId}}).
They hand packages to you for verification; send your results to them.

Your area:
- integration and server runs: tests, migrations, smoke checks;
- browser/UI checks — as instructed by the lead;
- a verdict per package: what was checked, what failed, environment and
  reproduction steps.

Rules:
- report blockers immediately, do not wait for a full run;
- never edit the executors' code: found an issue — report to the lead
  with reproduction steps;
- use the agreed environment/VM; do not spin up heavy environments
  without agreement.

Confirm readiness in one line and wait for a package to verify.
`,
  },
  ru: {
    lead: `\
Ты — руководитель разработки в этом проекте.

Ты — головной тред команды: исполнители созданы твоими дочерними тредами
и отчитываются тебе сообщениями. Состав команды придёт следующим сообщением
«Состав команды» с готовыми ID тредов.

Твоя зона ответственности:
- принимаешь постановку от пользователя, уточняешь границы, декомпозируешь на пакеты работ;
- выдаёшь задачи исполнителям: bb thread tell <thread-id> --message-file -
- ревьюишь диффы (чтением кода, без тяжёлых прогонов, если не оговорено иное);
- ведёшь приёмку: пакет закрыт, когда исправлены замечания ревью и подтверждены проверки;
- интеграционные проверки и прогоны — зона тестировщика; не выполняй их сам без необходимости.

Правила:
- у исполнителя один активный пакет; следующий выдаётся после приёмки предыдущего;
- коммиты только по явной договорённости, отдельным решением;
- итог приёмки пакета: статус (в работе / ревью / проверено / принято), изменённые файлы, риски.

Подтверди готовность одной строкой и жди постановку от пользователя.
`,
    developer: `\
Ты — разработчик в этом проекте.

Руководитель разработки — тред {{leadThreadRef}} ({{leadThreadId}}).
Задачи и ревью приходят от него; результаты отправляешь ему.

Правила работы:
- перед началом уточни границы пакета у руководителя;
- изменения держи в рабочем дереве без коммитов, пока коммит явно не согласован;
- по завершении пакета отправь руководителю отчёт:
  bb thread tell {{leadThreadId}} --message-file -
  состав отчёта: изменённые файлы и суть правок; что проверено локально;
  что проверить интеграционно; риски и допущения;
- не начинай следующий пакет до приёмки текущего.

Подтверди готовность одной строкой и жди задачу.
`,
    tester: `\
Ты — тестировщик в этом проекте.

Руководитель разработки — тред {{leadThreadRef}} ({{leadThreadId}}).
Он передаёт тебе пакеты на проверку; результаты отправляешь ему.

Твоя зона:
- интеграционные и серверные прогоны: тесты, миграции, smoke-проверки;
- браузерные/UI проверки — по постановке руководителя;
- вердикт по каждому пакету: что проверено, что упало, окружение и шаги воспроизведения.

Правила:
- сообщай о блокерах сразу, не дожидаясь полного прогона;
- не правь код исполнителей: нашёл проблему — отчёт руководителю со шагами воспроизведения;
- используй согласованное окружение/VM; свои тяжёлые среды не поднимай без согласования.

Подтверди готовность одной строкой и жди пакет на проверку.
`,
  },
};

function scaffoldFiles(lang: Language): ReadonlyArray<{ rel: string; content: string }> {
  const prompts = ROLE_PROMPTS[lang];
  return [
    { rel: CONFIG_PATH, content: TEAM_YAML[lang] },
    { rel: `${ROLES_DIR}/lead.md`, content: prompts.lead },
    { rel: `${ROLES_DIR}/developer.md`, content: prompts.developer },
    { rel: `${ROLES_DIR}/tester.md`, content: prompts.tester },
  ];
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

/** Prompt placeholder substitution. */
export function applyPlaceholders(
  text: string,
  vars: {
    workspace: Workspace;
    leadThreadId: string | null;
    roleThreads: Map<string, string>;
  },
  t: Strings = strings("en"),
): string {
  const { workspace, leadThreadId, roleThreads } = vars;
  return text
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

/** Threads already bound to team roles: role → thread ids (not archived). */
async function findExistingTeamThreads(
  bb: BbPluginApi,
  projectId: string,
): Promise<Map<string, string[]>> {
  // Adopted threads are manually created, so do not filter by origin:
  // take the project threads and read the teamRole metadata marker.
  const threads = await bb.sdk.threads.list({
    projectId,
    includeHidden: true,
    limit: 200,
  });
  const active = threads.filter((t) => t.archivedAt === null);
  const map = new Map<string, string[]>();
  if (active.length === 0) return map;
  const meta = await bb.sdk.threads.experimental_listPluginMetadata({
    threadIds: active.map((t) => t.id),
  });
  for (const entry of meta.threads) {
    const role = (entry.metadata as Record<string, unknown>).teamRole;
    if (typeof role === "string") {
      const list = map.get(role) ?? [];
      list.push(entry.threadId);
      map.set(role, list);
    }
  }
  return map;
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
    return { lang, t: strings(lang) };
  };

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
            json: {
              type: "boolean",
              description: "Machine-readable output",
            },
          },
          async run(input, ctx) {
            const { lang, t } = await loadLang();
            const workspace = await resolveWorkspace(
              bb,
              input.options.project,
              ctx.projectId,
              t,
              ctx,
            );
            const files = scaffoldFiles(lang);
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
                  written,
                  gitignored,
                }),
              };
            }
            const out = [
              t.initTitle(workspace.projectName),
              ...written.map((rel) => `  ${joinPath(workspace.path, rel)}`),
              "",
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
                role.environment ?? defaults.environment ?? "default",
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
                { workspace, leadThreadId, roleThreads },
                t,
              );
              const thread = await bb.sdk.threads.spawn({
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
                pluginMetadata: { teamRole: entry.role.name },
                prompt,
              });
              return { threadId: thread.id, providerId: thread.providerId };
            };

            const adoptRole = async (
              entry: PlanEntry,
              parentThreadId: string | undefined,
            ): Promise<SpawnOutcome> => {
              const id = entry.role.threadId!;
              const thread = await getAdoptableThread(entry);
              await bb.sdk.threads.updatePluginMetadata({
                threadId: id,
                set: { teamRole: entry.role.name },
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
            let configReport:
              | { source: string; lead: string; roles: string[] }
              | null = null;
            try {
              const { config, source } = await readTeamConfig(bb, workspace, t);
              const { lead, roles } = semanticChecks(config, t);
              configReport = {
                source,
                lead: lead.name,
                roles: config.roles.map(
                  (r) => `${r.name}${r.enabled === false ? t.labels.disabledRole : ""}`,
                ),
              };
            } catch {
              // no config — show the threads only
            }
            const existing = await findExistingTeamThreads(bb, workspace.projectId);

            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ok: true,
                  project: workspace.projectId,
                  config: configReport,
                  threads: Object.fromEntries(existing),
                }),
              };
            }
            const out = [t.statusTitle(workspace.projectName)];
            if (configReport) {
              out.push(`  ${t.labels.config}: ${configReport.source}`);
              out.push(`  ${t.labels.lead}: ${configReport.lead}`);
              out.push(`  ${t.labels.roles}: ${configReport.roles.join(", ")}`);
            } else {
              out.push(`  ${t.statusNoConfig}`);
            }
            if (existing.size === 0) {
              out.push(`  ${t.statusThreadsEmpty}`);
            } else {
              out.push(`  ${t.statusThreads}`);
              for (const [role, ids] of existing) {
                out.push(`    ${role}: ${ids.join(", ")}`);
              }
            }
            return { exitCode: 0, stdout: out.join("\n") };
          },
        }),
      },
    }),
  );
}