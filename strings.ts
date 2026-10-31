// Localized CLI strings for the core commands (en | ru).

import type { Language } from "./snapshot";

/* ──────────────────────── Strings (en | ru) ──────────────────────── */

export interface Strings {
  sectionName: string;
  projectNotResolved: { message: string; hint: string };
  projectNotFound: (name: string) => { message: string; hint: string };
  projectSourceMissing: (name: string) => string;
  pathOutsideWorkspace: (abs: string, ws: string) => string;
  configMissing: (team: string, projectId: string) => { message: string; hint: string };
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
  initTitle: (project: string, team: string) => string;
  initNext: (team: string, config: string) => string[];
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
  statusNoConfig: (team: string) => string;
  teamHeader: (team: string, title: string | null, versioned: boolean) => string;
  noTeams: string;
  teamAmbiguous: (teams: string) => { message: string; hint: string };
  helpers: (count: number) => string;
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
    header: (team: string, source: string) => string;
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
    configMissing: (team, projectId) => ({
      message: `team "${team}" has no config (.bb/teams/${team}.yaml): create it first`,
      hint: `bb team init --team ${team} --project ${projectId} — or the Team panel`,
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
      hint: `Enable: bb provider enable ${first} — or change the provider in the team config. Available now: ${avail}`,
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
    initTitle: (project, team) => `Team "${team}" config created in project "${project}":`,
    initNext: (team, config) => [
      "Next:",
      `  1) edit ${config}: roles, providers, models (prompts sit next to it)`,
      `  2) bb team doctor --team ${team} — check providers, environments, prompts`,
      `  3) bb team create --team ${team} — spawn the team threads`,
      `  versioning: the config stays out of git until bb team version on --team ${team}`,
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
    statusNoConfig: (team) => `no config (bb team init --team ${team})`,
    teamHeader: (team, title, versioned) =>
      `Team "${team}"${title ? ` — ${title}` : ""}${versioned ? " [versioned]" : " [not versioned]"}:`,
    noTeams: "No teams in this project yet. Create one: bb team init (or the Team panel)",
    teamAmbiguous: (teams) => ({
      message: `the project has several teams: ${teams}`,
      hint: "Pick one with --team <name>",
    }),
    helpers: (count) => `${count} helper thread(s)`,
    projectByPathNotFound: (cwd) => ({
      message: `no project found for path "${cwd}"`,
      hint: "cd into a project, or pass --project <id|name>. List projects: bb project list",
    }),
    gitignoreNote: [
      "note: the root .gitignore ignores the whole .bb/ directory, so team configs",
      "cannot be versioned. To version teams, replace that line with:",
      "  .bb/*   and   !.bb/teams/",
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
      header: (team, source) => `Team "${team}" was created by bb team create (config ${source}).`,
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
    configMissing: (team, projectId) => ({
      message: `у команды "${team}" нет конфига (.bb/teams/${team}.yaml): сначала создайте его`,
      hint: `bb team init --team ${team} --project ${projectId} — или панель Team`,
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
      hint: `Включить: bb provider enable ${first} — или заменить provider в конфиге команды. Доступны сейчас: ${avail}`,
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
    initTitle: (project, team) => `Конфиг команды "${team}" создан в проекте "${project}":`,
    initNext: (team, config) => [
      "Дальше:",
      `  1) отредактируйте ${config}: роли, провайдеры, модели (промпты лежат рядом)`,
      `  2) bb team doctor --team ${team} — проверить провайдеры, окружения, промпты`,
      `  3) bb team create --team ${team} — поднять треды команды`,
      `  версионирование: конфиг не попадает в git, пока не включите bb team version on --team ${team}`,
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
    statusNoConfig: (team) => `конфига нет (bb team init --team ${team})`,
    teamHeader: (team, title, versioned) =>
      `Команда "${team}"${title ? ` — ${title}` : ""}${versioned ? " [в git]" : " [не в git]"}:`,
    noTeams: "В проекте ещё нет команд. Создать: bb team init (или панель Team)",
    teamAmbiguous: (teams) => ({
      message: `в проекте несколько команд: ${teams}`,
      hint: "Укажите одну: --team <имя>",
    }),
    helpers: (count) => `тредов-помощников: ${count}`,
    projectByPathNotFound: (cwd) => ({
      message: `по пути "${cwd}" не найден проект`,
      hint: "перейдите в каталог проекта или укажите --project <id|имя>. Список: bb project list",
    }),
    gitignoreNote: [
      "замечание: корневой .gitignore игнорирует весь каталог .bb/, поэтому конфиги",
      "команд нельзя версионировать. Чтобы версионировать, замените эту строку на:",
      "  .bb/*   и   !.bb/teams/",
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
      header: (team, source) => `Команда "${team}" создана командой bb team create (конфиг ${source}).`,
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

