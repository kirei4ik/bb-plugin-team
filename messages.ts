// Localized strings for the v0.3+ commands: report, task, doctor, replace,
// stop / pause / resume, idle notifications, init templates.

import type { Language } from "./snapshot";

export interface Messages {
  reportWritten: (path: string) => string;
  reportShow: string;
  reportOutRequired: { message: string; hint: string };

  taskAdded: (id: number | string, role: string, title: string) => string;
  taskSent: (role: string, threadId: string) => string;
  taskSendFailed: (id: number | string, error: string) => string;
  taskUpdated: (id: number | string, from: string, to: string) => string;
  taskRemoved: (id: number | string) => string;
  taskListEmpty: string;
  taskListTitle: (project: string) => string;
  taskBusy: (role: string, ids: string) => string;
  taskRoleUnknown: (role: string) => { message: string; hint: string };
  taskNoThread: (role: string) => { message: string; hint: string };
  reviewSubmissionRequired: () => { message: string; hint: string };
  acceptanceReasonRequired: () => { message: string; hint: string };
  returnReasonRequired: () => { message: string; hint: string };
  submissionConflict: (expected: string, current: string) => { message: string; hint: string };
  taskBody: (id: number | string, title: string, note: string | null, leadRef: string | null) => string;
  taskStatusLine: (status: string) => string;

  doctorTitle: (project: string) => string;
  doctorSummary: (fail: number, warn: number) => string;
  doctorAllGood: string;
  check: {
    config: string;
    configMissing: string;
    providers: string;
    environments: string;
    prompts: string;
    vars: string;
    gitignore: string;
    adopted: string;
    threads: string;
  };
  doctorOk: string;
  doctorMissingThread: (role: string) => string;
  doctorDuplicate: (role: string, ids: string) => string;
  doctorOrphan: (role: string, id: string) => string;
  doctorWrongParent: (role: string, id: string) => string;
  doctorThreadError: (role: string, id: string) => string;
  doctorUnknownVar: (role: string, name: string) => string;
  doctorGitignored: string;
  doctorPaused: string;

  replaceNoThread: (role: string) => { message: string; hint: string };
  replaceAmbiguous: (role: string, ids: string) => { message: string; hint: string };
  replaceNeedsPrompt: (role: string) => { message: string; hint: string };
  replaceThreadMismatch: (role: string, id: string) => string;
  replaceHandoff: (oldRef: string, output: string | null, tasks: string) => string;
  replaceDone: (role: string, oldId: string, newId: string) => string;
  replaceArchived: (id: string) => string;
  replaceKept: (id: string) => string;
  replaceReparented: (count: number) => string;
  replaceConfigNote: (role: string, id: string) => string;
  replaceLeadNotice: (role: string, oldRef: string, newRef: string) => string;
  replacePlan: (role: string, oldId: string) => string;

  stopNone: string;
  stopped: (role: string, id: string) => string;
  stopFailed: (role: string, error: string) => string;
  paused: (count: number) => string;
  pausedAlready: string;
  resumed: (count: number) => string;
  notPaused: string;
  pauseWaitReason: string;
  tellPausedNote: string;

  notifyIdle: (role: string, threadId: string, excerpt: string | null) => string;
  notifyError: (role: string, threadId: string, error: string | null) => string;

  templateTitle: (name: string) => string;
  fromNoConfig: (name: string) => { message: string; hint: string };
  fromStripped: (count: number) => string;
  teamsTitle: (project: string) => string;
  teamLine: (team: string, title: string | null, versioned: boolean, roles: number, threads: number) => string;
  teamExists: (team: string) => { message: string; hint: string };
  versionOn: (team: string, files: string) => string;
  versionOff: (team: string, files: string) => string;
  versionBlocked: string;
  roleAdded: (role: string, team: string) => string;
  roleExists: (role: string, team: string) => { message: string; hint: string };
  threadTaken: (id: string, team: string, role: string) => { message: string; hint: string };
  configRewritten: string;
  templatesTitle: string;
  templateLine: (id: string, title: string, roles: string, builtin: boolean) => string;
  templateSaved: (id: string) => string;
  templateDeleted: (id: string) => string;
  templateNotFound: (id: string) => { message: string; hint: string };
  templateBuiltin: (id: string) => { message: string; hint: string };
  retitled: (count: number) => string;
  versionedYes: string;
  versionedNo: string;
  onlyLeadAccepts: (role: string) => { message: string; hint: string };
  relinked: (count: number) => string;
  overviewNoSource: string;
  overviewHostOffline: (host: string) => string;
  overviewUnreadable: (error: string) => string;
}

const EN: Messages = {
  reportWritten: (path) => `Team report written: ${path}`,
  reportShow: "Show it inline in chat with the directive below:",
  reportOutRequired: {
    message: "--format html needs --out <file.html> (or use --format md)",
    hint: 'In a thread: bb team report --out "$BB_THREAD_STORAGE/team-report.html"',
  },

  taskAdded: (id, role, title) => `task #${id} → ${role}: ${title}`,
  taskSent: (role, threadId) => `sent to ${role} — @thread:${threadId}`,
  taskSendFailed: (id, error) => `package #${id} created, but sending it to the role failed: ${error}`,
  taskUpdated: (id, from, to) => `task #${id}: ${from} → ${to}`,
  taskRemoved: (id) => `task #${id} removed`,
  taskListEmpty: "No open work packages. Add one: bb team task add <role> <title>",
  taskListTitle: (project) => `Work packages of "${project}":`,
  taskBusy: (role, ids) =>
    `note: ${role} already has a package in work (${ids}) — one active package per executor`,
  taskRoleUnknown: (role) => ({
    message: `role "${role}" is neither in .bb/team.yaml nor bound to a team thread`,
    hint: "Roles: bb team status",
  }),
  taskNoThread: (role) => ({
    message: `role "${role}" has no team thread to send the package to`,
    hint: "Spawn the team first: bb team create — or add the task without --send",
  }),
  reviewSubmissionRequired: () => ({
    message:
      "this step needs a grounded review report: attach --review JSON with result, artifacts, actual checks and remaining problems (each check is {what,result} or {what,notApplicable} with a justification — never both)",
    hint: 'bb team task update <id> --status review --review \'{"result":"…","artifacts":[…],"checks":[{"what":"…","result":"…"}],"problems":[…]}\' — presence of text is not a passed check; a failed or not-run check stays a failure in its result',
  }),
  acceptanceReasonRequired: () => ({
    message:
      "accepting a package (done) needs grounds: a grounded review report on the task, and your reason stating what you checked and why it is enough; the manual path always requires a reason too",
    hint: "bb team task done <id> --reason <why you accept> — or return it: bb team task update <id> --status todo --return-reason <concrete remark>",
  }),
  returnReasonRequired: () => ({
    message: "returning a package from review needs a concrete remark for the executor (the manual path needs it too)",
    hint: "bb team task update <id> --status todo --return-reason <what exactly must change>",
  }),
  submissionConflict: (expected, current) => ({
    message: `the review report changed since it was reviewed: expected submission "${expected}", the task now carries ${current}; nothing was changed`,
    hint: "Re-read the current report (bb team task list --json shows the submission id), then accept or return with the new id in --expected-submission",
  }),
  taskBody: (id, title, note, leadRef) =>
    [
      `Work package #${id}: ${title}`,
      ...(note ? ["", note] : []),
      "",
      leadRef
        ? `When it is done: bb team task update ${id} --status review --review '<json: result, artifacts, checks[{what,result}|{what,notApplicable}], problems>' — then report to the lead role using bb team tell ${leadRef} --message-file -. Only the lead accepts packages (done).`
        : `When it is done: bb team task update ${id} --status review --review '<json: result, artifacts, checks[{what,result}|{what,notApplicable}], problems>' — then report back.`,
    ].join("\n"),
  taskStatusLine: (status) => `status: ${status}`,

  doctorTitle: (project) => `Team doctor — project "${project}"`,
  doctorSummary: (fail, warn) => `${fail} problem(s), ${warn} warning(s)`,
  doctorAllGood: "All checks passed.",
  check: {
    config: "config",
    configMissing: "no .bb/team.yaml — bb team init",
    providers: "providers",
    environments: "environments",
    prompts: "prompts",
    vars: "vars",
    gitignore: "git",
    adopted: "adopted threads",
    threads: "team threads",
  },
  doctorOk: "ok",
  doctorMissingThread: (role) => `${role}: no thread yet — bb team create`,
  doctorDuplicate: (role, ids) => `${role}: several threads (${ids}) — archive the extra ones`,
  doctorOrphan: (role, id) =>
    `${role}: thread ${id} carries a role missing from the config — re-add the role or archive the thread`,
  doctorWrongParent: (role, id) =>
    `${role}: thread ${id} is not a child of the lead — re-run bb team create to re-link`,
  doctorThreadError: (role, id) => `${role}: thread ${id} is in error — bb thread retry ${id}`,
  doctorUnknownVar: (role, name) => `${role}: prompt uses {{vars.${name}}}, not defined in vars:`,
  doctorGitignored:
    ".bb is gitignored — commit .bb/team.yaml and .bb/team/ if the team is shared",
  doctorPaused: "the team is paused — bb team resume",

  replaceNoThread: (role) => ({
    message: `role "${role}" has no team thread to replace`,
    hint: "Spawn it: bb team create",
  }),
  replaceAmbiguous: (role, ids) => ({
    message: `role "${role}" has several threads: ${ids}`,
    hint: "Pick one: bb team replace <role> --thread <thr_…>",
  }),
  replaceNeedsPrompt: (role) => ({
    message: `role "${role}" has no prompt/promptFile — a fresh thread needs one`,
    hint: "Add prompt or promptFile to the role in .bb/team.yaml",
  }),
  replaceThreadMismatch: (role, id) => `thread ${id} is not a "${role}" team thread`,
  replaceHandoff: (oldRef, output, tasks) =>
    [
      "",
      "---",
      `Handoff: you replace the previous thread of this role, ${oldRef}.`,
      ...(output ? ["Saved task checkpoint:", "", output] : ["It left no final report."]),
      ...(tasks ? ["", "Open work packages of the role:", tasks] : []),
      "",
      "Continue from the saved task checkpoint. Address roles with bb team tell <role>; do not reload the previous conversation.",
    ].join("\n"),
  replaceDone: (role, oldId, newId) => `${role}: @thread:${oldId} → @thread:${newId}`,
  replaceArchived: (id) => `old thread archived: ${id}`,
  replaceKept: (id) => `old thread kept (unbound from the role): ${id}`,
  replaceReparented: (count) => `executors moved under the new lead: ${count}`,
  replaceConfigNote: (role, id) =>
    `note: .bb/team.yaml binds role "${role}" to threadId ${id} — update or remove that line`,
  replaceLeadNotice: (role, oldRef, newRef) =>
    `Team change: role "${role}" moved from ${oldRef} to a fresh thread ${newRef} (bb team replace). Address the role using bb team tell <role>; it resolves the current session.`,
  replacePlan: (role, oldId) =>
    `would replace ${role}: ${oldId} → new thread (handoff: last report + open packages)`,

  stopNone: "No running team threads to stop.",
  stopped: (role, id) => `stopped ${role} — ${id}`,
  stopFailed: (role, error) => `${role}: stop failed — ${error}`,
  paused: (count) =>
    `Team paused: ${count} executor thread(s). Agent messages to them wait in their queues; bb team resume releases them.`,
  pausedAlready: "The team is already paused. Release it: bb team resume",
  resumed: (count) => `Team resumed: ${count} thread(s); held messages are being delivered.`,
  notPaused: "The team is not paused.",
  pauseWaitReason: "Team paused — bb team resume releases this message",
  tellPausedNote: "note: the team is paused — the message waits until bb team resume",

  notifyIdle: (role, threadId, excerpt) =>
    [
      `[team] ${role} (@thread:${threadId}) finished a turn.`,
      ...(excerpt ? ["", excerpt] : []),
    ].join("\n"),
  notifyError: (role, threadId, error) =>
    `[team] ${role} (@thread:${threadId}) stopped with an error${error ? `: ${error}` : ""}.`,

  templateTitle: (name) => `template: ${name}`,
  fromNoConfig: (name) => ({
    message: `project "${name}" has no .bb/team.yaml to copy`,
    hint: "Check the source: bb team status --project <name>",
  }),
  fromStripped: (count) =>
    `removed ${count} threadId binding(s): threads belong to the source project`,
  teamsTitle: (project) => `Teams of "${project}":`,
  teamLine: (team, title, versioned, roles, threads) =>
    `  ${team}${title ? ` — ${title}` : ""} · roles: ${roles} · threads: ${threads} · ${versioned ? "versioned" : "not versioned"}`,
  teamExists: (team) => ({
    message: `team "${team}" already has a config`,
    hint: "Pick another --team name, or --force to overwrite its files",
  }),
  versionOn: (team, files) => `team "${team}" is versioned now: commit ${files}`,
  versionOff: (team, files) => `team "${team}" is out of git now (${files} ignored); remove tracked copies with git rm --cached if needed`,
  versionBlocked:
    "the root .gitignore ignores .bb/ entirely — replace it with `.bb/*` and `!.bb/teams/` to version teams",
  roleAdded: (role, team) => `role "${role}" added to team "${team}"`,
  roleExists: (role, team) => ({
    message: `team "${team}" already has a role "${role}"`,
    hint: "Pick another --name, e.g. developer-2",
  }),
  threadTaken: (id, team, role) => ({
    message: `thread ${id} already belongs to team "${team}" as "${role}"`,
    hint: "A thread can be in one team only. Free threads: the Team panel → Add executor",
  }),
  configRewritten: "note: the config was rewritten (comments dropped) because roles: is not its last key",
  templatesTitle: "Team templates:",
  templateLine: (id, title, roles, builtin) => `  ${id}${builtin ? " (built-in)" : ""} — ${title}: ${roles}`,
  templateSaved: (id) => `template "${id}" saved`,
  templateDeleted: (id) => `template "${id}" deleted`,
  templateNotFound: (id) => ({
    message: `template "${id}" not found`,
    hint: "List: bb team template list",
  }),
  templateBuiltin: (id) => ({
    message: `"${id}" is a built-in template and cannot be changed`,
    hint: "Copy it under a new id: bb team template save <new-id> --from-template " + id,
  }),
  retitled: (count) => `threads renamed: ${count}`,
  versionedYes: "versioned (tracked in git)",
  versionedNo: "not versioned (kept out of git)",
  relinked: (count) => `executors re-linked under the lead: ${count}`,
  onlyLeadAccepts: (role) => ({
    message: `only the lead accepts packages; "${role}" is an executor`,
    hint: "Move it to review: bb team task update <id> --status review — and report to the lead",
  }),
  overviewNoSource: "The project has no folder (source) on a connected machine",
  overviewHostOffline: (host) => `Machine "${host}" is offline — team threads cannot start there`,
  overviewUnreadable: (error) => `The project folder cannot be read: ${error}`,
};

const RU: Messages = {
  reportWritten: (path) => `Отчёт команды записан: ${path}`,
  reportShow: "Показать его в чате — директивой ниже:",
  reportOutRequired: {
    message: "для --format html нужен --out <файл.html> (или --format md)",
    hint: 'В треде: bb team report --out "$BB_THREAD_STORAGE/team-report.html"',
  },

  taskAdded: (id, role, title) => `пакет #${id} → ${role}: ${title}`,
  taskSent: (role, threadId) => `отправлен ${role} — @thread:${threadId}`,
  taskSendFailed: (id, error) => `пакет #${id} создан, но отправить его роли не удалось: ${error}`,
  taskUpdated: (id, from, to) => `пакет #${id}: ${from} → ${to}`,
  taskRemoved: (id) => `пакет #${id} удалён`,
  taskListEmpty: "Открытых пакетов нет. Добавить: bb team task add <роль> <название>",
  taskListTitle: (project) => `Пакеты работ проекта «${project}»:`,
  taskBusy: (role, ids) =>
    `заметка: у ${role} уже есть пакет в работе (${ids}) — один активный пакет на исполнителя`,
  taskRoleUnknown: (role) => ({
    message: `роли "${role}" нет ни в .bb/team.yaml, ни среди тредов команды`,
    hint: "Роли: bb team status",
  }),
  taskNoThread: (role) => ({
    message: `у роли "${role}" нет треда, чтобы отправить пакет`,
    hint: "Сначала создайте команду: bb team create — или добавьте пакет без --send",
  }),
  reviewSubmissionRequired: () => ({
    message:
      "этот шаг требует содержательного отчёта ревью: приложите --review JSON с результатом, артефактами, фактическими проверками и оставшимися проблемами (каждая проверка — {what,result} или {what,notApplicable} с обоснованием, но не оба сразу)",
    hint: 'bb team task update <id> --status review --review \'{"result":"…","artifacts":[…],"checks":[{"what":"…","result":"…"}],"problems":[…]}\' — наличие текста не равносильно пройденной проверке; проваленная или невыполнявшаяся проверка остаётся провалом в result',
  }),
  acceptanceReasonRequired: () => ({
    message:
      "приёмка пакета (done) требует оснований: содержательный отчёт ревью у задачи и ваша причина — что именно проверено и почему этого достаточно; для ручного пути причина также обязательна",
    hint: "bb team task done <id> --reason <почему принимаете> — или верните: bb team task update <id> --status todo --return-reason <конкретное замечание>",
  }),
  returnReasonRequired: () => ({
    message: "возврат пакета из review требует конкретного замечания исполнителю (для ручного пути тоже)",
    hint: "bb team task update <id> --status todo --return-reason <что именно нужно исправить>",
  }),
  submissionConflict: (expected, current) => ({
    message: `отчёт ревью изменился с момента просмотра: ожидался submission «${expected}», в задаче сейчас ${current}; ничего не изменено`,
    hint: "Перечитайте текущий отчёт (id submission виден в bb team task list --json) и повторите приёмку/возврат с новым id в --expected-submission",
  }),
  taskBody: (id, title, note, leadRef) =>
    [
      `Пакет работ #${id}: ${title}`,
      ...(note ? ["", note] : []),
      "",
      leadRef
        ? `По завершении: bb team task update ${id} --status review --review '<json: result, artifacts, checks[{what,result}|{what,notApplicable}], problems>' — и отчёт роли руководителя через bb team tell ${leadRef} --message-file -. Принимает пакет (done) только руководитель.`
        : `По завершении: bb team task update ${id} --status review --review '<json: result, artifacts, checks[{what,result}|{what,notApplicable}], problems>' — и отчёт.`,
    ].join("\n"),
  taskStatusLine: (status) => `статус: ${status}`,

  doctorTitle: (project) => `Проверка команды — проект «${project}»`,
  doctorSummary: (fail, warn) => `проблем: ${fail}, предупреждений: ${warn}`,
  doctorAllGood: "Все проверки пройдены.",
  check: {
    config: "конфиг",
    configMissing: "нет .bb/team.yaml — bb team init",
    providers: "провайдеры",
    environments: "окружения",
    prompts: "промпты",
    vars: "переменные",
    gitignore: "git",
    adopted: "привязанные треды",
    threads: "треды команды",
  },
  doctorOk: "ок",
  doctorMissingThread: (role) => `${role}: треда ещё нет — bb team create`,
  doctorDuplicate: (role, ids) => `${role}: несколько тредов (${ids}) — лишние архивируйте`,
  doctorOrphan: (role, id) =>
    `${role}: тред ${id} помечен ролью, которой нет в конфиге — верните роль или архивируйте тред`,
  doctorWrongParent: (role, id) =>
    `${role}: тред ${id} не дочерний для руководителя — повторите bb team create`,
  doctorThreadError: (role, id) => `${role}: тред ${id} в ошибке — bb thread retry ${id}`,
  doctorUnknownVar: (role, name) => `${role}: промпт использует {{vars.${name}}}, которой нет в vars:`,
  doctorGitignored:
    ".bb в .gitignore — закоммитьте .bb/team.yaml и .bb/team/, если команда общая",
  doctorPaused: "команда на паузе — bb team resume",

  replaceNoThread: (role) => ({
    message: `у роли "${role}" нет треда для замены`,
    hint: "Создайте его: bb team create",
  }),
  replaceAmbiguous: (role, ids) => ({
    message: `у роли "${role}" несколько тредов: ${ids}`,
    hint: "Укажите один: bb team replace <роль> --thread <thr_…>",
  }),
  replaceNeedsPrompt: (role) => ({
    message: `у роли "${role}" нет prompt/promptFile — новому треду нужен промпт`,
    hint: "Добавьте prompt или promptFile роли в .bb/team.yaml",
  }),
  replaceThreadMismatch: (role, id) => `тред ${id} не является тредом роли "${role}"`,
  replaceHandoff: (oldRef, output, tasks) =>
    [
      "",
      "---",
      `Передача дел: ты заменяешь предыдущий тред этой роли, ${oldRef}.`,
      ...(output ? ["Сохранённый checkpoint задачи:", "", output] : ["Финального отчёта он не оставил."]),
      ...(tasks ? ["", "Открытые пакеты роли:", tasks] : []),
      "",
      "Продолжай по checkpoint задачи. Адресуй сообщения через bb team tell <роль>; прежнюю беседу не загружай.",
    ].join("\n"),
  replaceDone: (role, oldId, newId) => `${role}: @thread:${oldId} → @thread:${newId}`,
  replaceArchived: (id) => `старый тред архивирован: ${id}`,
  replaceKept: (id) => `старый тред оставлен (отвязан от роли): ${id}`,
  replaceReparented: (count) => `исполнителей перенесено к новому руководителю: ${count}`,
  replaceConfigNote: (role, id) =>
    `заметка: .bb/team.yaml привязывает роль "${role}" к threadId ${id} — обновите или уберите строку`,
  replaceLeadNotice: (role, oldRef, newRef) =>
    `Изменение команды: роль "${role}" переехала из ${oldRef} в новый тред ${newRef} (bb team replace). Сообщения отправляй через bb team tell <роль>: он определяет актуальную сессию.`,
  replacePlan: (role, oldId) =>
    `заменит ${role}: ${oldId} → новый тред (передача: последний отчёт + открытые пакеты)`,

  stopNone: "Работающих тредов команды нет.",
  stopped: (role, id) => `остановлен ${role} — ${id}`,
  stopFailed: (role, error) => `${role}: остановить не удалось — ${error}`,
  paused: (count) =>
    `Команда на паузе: тредов исполнителей ${count}. Сообщения агентов им ждут в очереди; bb team resume их отпустит.`,
  pausedAlready: "Команда уже на паузе. Снять: bb team resume",
  resumed: (count) => `Пауза снята: тредов ${count}; придержанные сообщения доставляются.`,
  notPaused: "Команда не на паузе.",
  pauseWaitReason: "Команда на паузе — bb team resume отпустит это сообщение",
  tellPausedNote: "заметка: команда на паузе — сообщение дождётся bb team resume",

  notifyIdle: (role, threadId, excerpt) =>
    [
      `[команда] ${role} (@thread:${threadId}) завершил ход.`,
      ...(excerpt ? ["", excerpt] : []),
    ].join("\n"),
  notifyError: (role, threadId, error) =>
    `[команда] ${role} (@thread:${threadId}) остановился с ошибкой${error ? `: ${error}` : ""}.`,

  templateTitle: (name) => `шаблон: ${name}`,
  fromNoConfig: (name) => ({
    message: `у проекта "${name}" нет .bb/team.yaml для копирования`,
    hint: "Проверьте источник: bb team status --project <имя>",
  }),
  fromStripped: (count) =>
    `убрано привязок threadId: ${count} — треды принадлежат исходному проекту`,
  teamsTitle: (project) => `Команды проекта «${project}»:`,
  teamLine: (team, title, versioned, roles, threads) =>
    `  ${team}${title ? ` — ${title}` : ""} · ролей: ${roles} · тредов: ${threads} · ${versioned ? "в git" : "не в git"}`,
  teamExists: (team) => ({
    message: `у команды "${team}" уже есть конфиг`,
    hint: "Выберите другое имя --team или --force для перезаписи её файлов",
  }),
  versionOn: (team, files) => `команда "${team}" теперь версионируется: закоммитьте ${files}`,
  versionOff: (team, files) => `команда "${team}" выведена из git (${files} игнорируются); уже закоммиченные копии уберите git rm --cached`,
  versionBlocked:
    "корневой .gitignore игнорирует весь .bb/ — замените строку на `.bb/*` и `!.bb/teams/`, чтобы версионировать команды",
  roleAdded: (role, team) => `роль "${role}" добавлена в команду "${team}"`,
  roleExists: (role, team) => ({
    message: `в команде "${team}" уже есть роль "${role}"`,
    hint: "Выберите другое --name, например developer-2",
  }),
  threadTaken: (id, team, role) => ({
    message: `тред ${id} уже состоит в команде "${team}" как "${role}"`,
    hint: "Тред может быть только в одной команде. Свободные треды: панель Team → «Добавить исполнителя»",
  }),
  configRewritten: "заметка: конфиг переписан целиком (комментарии потеряны), так как roles: — не последний ключ",
  templatesTitle: "Шаблоны команд:",
  templateLine: (id, title, roles, builtin) => `  ${id}${builtin ? " (встроенный)" : ""} — ${title}: ${roles}`,
  templateSaved: (id) => `шаблон "${id}" сохранён`,
  templateDeleted: (id) => `шаблон "${id}" удалён`,
  templateNotFound: (id) => ({
    message: `шаблон "${id}" не найден`,
    hint: "Список: bb team template list",
  }),
  templateBuiltin: (id) => ({
    message: `"${id}" — встроенный шаблон, его нельзя менять`,
    hint: "Скопируйте под новым id: bb team template save <новый-id> --from-template " + id,
  }),
  retitled: (count) => `переименовано тредов: ${count}`,
  versionedYes: "в git (версионируется)",
  versionedNo: "вне git (не версионируется)",
  relinked: (count) => `исполнителей заново привязано к руководителю: ${count}`,
  onlyLeadAccepts: (role) => ({
    message: `принимает пакеты только руководитель; "${role}" — исполнитель`,
    hint: "Переведите в ревью: bb team task update <id> --status review — и отчитайтесь руководителю",
  }),
  overviewNoSource: "У проекта нет папки (источника) на подключённой машине",
  overviewHostOffline: (host) => `Машина «${host}» не в сети — треды команды там не запустятся`,
  overviewUnreadable: (error) => `Папка проекта недоступна: ${error}`,
};

const EN_LEAD_POLICY = `Autonomous lead operating rules (keep after session replacement):
- Accept an ordinary goal, define the minimal sufficient solution for it, and run the work through the project's selected tracker by default. Do not ask "should this go to Beads?" and do not maintain a second tracker.
- Plan work as small tracked packages. For each one set acceptance criteria, dependencies, order, and an assignee role. Create epics only when they genuinely group substantial work; never force an epic for trivial tasks.
- Delegate by minimal cost: first try a ready-made command or script (no LLM); then give a narrow simple errand to the junior or an existing helper; only genuinely complex work goes to a stronger role. Reuse an existing helper for one-off errands, use the junior with a replaceable session for recurring simple work, and never keep a permanently thinking observer. Do not do executors' work yourself.
- Make technical decisions yourself and record the reasons (decisions, checkpoint, or bb team tell lead). Choose models only from the team's approved roster; no arbitrary fallbacks and no unapproved extra paid calls. Do not promise features that are not implemented.
- Verify by evidence, not by the presence of text: accept a package only with a grounded review report — result/artifacts, actual checks with results or a justified not-applicable, remaining problems. Filled-in fields are not a passed check; a model's self-report is not a test result.
- Resource limits are enforced in code across lead, workers, helpers and retries. A failed attempt needs a concrete changed approach; do not bypass a hold with another card/session or blind model cycling. Check Team resources/report. Quota handoff only uses approved independent backups and a fresh verified checkpoint; without it, stop and explain. Context is not cumulative spend, unknown usage is not zero, and provider-internal retries/cost may be unavailable.
- Accept or return concretely: accept with your reason (bb team task done <id> --reason … --expected-submission <report-id>), or return the package with a concrete remark (bb team task update <id> --status in-progress --return-reason … --expected-submission <report-id>). Executors never accept packages; your decision and the return reason stay recorded on the task. Escalate to the user only product priorities, scope boundaries, and significant costs.
- A request to discuss or plan does not grant permission to write code. An instruction to implement does; preserve existing authorization and do not ask for it again.
- Keep a coordination task linked to your session with a checkpoint when managing work. Reuse a suitable existing lead task or epic; do not create duplicate coordination cards.
- Before a handoff or session rotation, save a substantive checkpoint with bb team checkpoint <id> --file <absolute-json-path>.`;

const RU_LEAD_POLICY = `Правила автономного руководителя (сохраняй после замены сессии):
- Принимай обычную цель, определяй минимально достаточное решение и по умолчанию веди работу в выбранном для проекта трекере. Не спрашивай «в Beads?» и не поддерживай второй трекер.
- Планируй работу небольшими пакетами с учётом. Для каждого пакета задавай критерии приёмки, зависимости, порядок и роль-исполнителя. Создавай эпики только когда они действительно объединяют существенную работу; никогда не требуй эпика для мелочей.
- Делегируй по минимальной достаточности: сначала готовая команда или скрипт без LLM; узкое простое поручение — джуну или существующему helper; действительно сложное — сильной роли. Для разовых поручений используй существующего helper, для повторяющихся простых — джуна со сменяемой сессией; не держи постоянно думающего наблюдателя. Работу исполнителей не делай сам.
- Технические решения принимай сам и фиксируй причины (decisions, checkpoint или сообщение роли lead). Выбирай модели только из утверждённого roster команды; никаких произвольных fallback и несогласованных дополнительных платных вызовов. Не обещай ещё не реализованные возможности.
- Проверяй по доказательствам, а не по наличию текста: принимай пакет только с содержательным отчётом ревью — результат/артефакты, фактические проверки с результатами или обоснованный not-applicable, оставшиеся проблемы. Заполненные поля — не прошедшая проверка; самоотчёт модели — не результат теста.
- Лимиты ресурсов проверяет код для lead, исполнителей, helpers и повторов. После ошибки нужно конкретное изменение подхода; не обходи блокировку новой карточкой/сессией или перебором моделей. Смотри ресурсы Team/отчёт. Замена при квоте — только разрешённый независимый резерв и свежий проверенный checkpoint; без него остановись с объяснением. Контекст не равен накопленному расходу, неизвестный расход не равен нулю; внутренние retry/стоимость провайдера могут быть недоступны.
- Принимай или возвращай конкретно: принимай с причиной (bb team task done <id> --reason … --expected-submission <report-id>) или возвращай пакет с конкретным замечанием (bb team task update <id> --status in-progress --return-reason … --expected-submission <report-id>). Исполнители никогда не принимают пакеты; твоё решение и причина возврата сохраняются в задаче. Эскалируй пользователю только продуктовые приоритеты, границы scope и существенные затраты.
- Просьба обсудить или спланировать не даёт разрешения писать код. Поручение реализовать даёт такое разрешение; сохраняй уже полученное разрешение и не спрашивай его повторно.
- При руководстве работой свяжи сессию с задачей координации через checkpoint. Используй подходящую существующую задачу или эпик руководителя, не создавай дублирующую карточку координации.
- Перед передачей дела или сменой сессии сохраняй содержательный checkpoint: bb team checkpoint <id> --file <абсолютный-путь.json>.`;

/** Persistent autonomous-lead policy text, localized. */
export function leadAutonomyPolicy(lang: Language): string {
  return lang === "ru" ? RU_LEAD_POLICY : EN_LEAD_POLICY;
}

/** True when the text already carries the lead policy for the language. */
export function hasLeadPolicy(text: string, lang: Language): boolean {
  return text.includes("Правила автономного руководителя") || text.includes("Autonomous lead operating rules");
}

/**
 * bbt-iwi.2: review/acceptance rules for executor sessions. loadRolePrompt does
 * not append it automatically; template authors embed it once (templates.ts
 * is owned by the roster worker, so the insertion is handed to the parent):
 *   `${prompt}\n\n${executorReviewPolicy(lang)}`
 */
export function executorReviewPolicy(lang: Language): string {
  return lang === "ru"
    ? `Отчёт и приёмка пакета Team:
- Завершив пакет, переведи его в review с содержательным отчётом: bb team task update <id> --status review --review '<json>'. JSON: result (что фактически сделано), artifacts[], checks[] — каждая запись {"what":…,"result": фактический результат} или {"what":…,"notApplicable": обоснование}, problems[] (оставшиеся проблемы).
- Не выдавай наличие текста за выполненную проверку: описывай только то, что реально запускал/проверял; для непрограммной работы допустим обоснованный not-applicable. Самоотчёт не заменяет проверку.
- Никогда не принимай свой пакет сам (статус done/dropped — только руководитель или пользователь). При возврате с замечанием исправь конкретику из return-reason и снова подай отчёт в review.`
    : `Team package review and acceptance:
- When your package is done, move it to review with a grounded report: bb team task update <id> --status review --review '<json>'. JSON: result (what was actually produced), artifacts[], checks[] — each {"what":…,"result": actual outcome} or {"what":…,"notApplicable": justification}, problems[] (remaining issues).
- Never pass the presence of text off as a performed check: describe only what you actually ran/verified; for non-programmatic work a justified not-applicable is fine. A self-report is not a check.
- Never accept your own package (done/dropped is for the lead or the user only). When it is returned with a remark, address the concrete return-reason and submit a fresh review report.`;
}

/** Shared with custom role prompts so estimated context usage has an agent path. */
export function sessionHandoffPolicy(lang: Language): string {
  return lang === "ru"
    ? `Передача сессии Team:
- Продолжай один пакет в текущей сессии, включая связанные исправления. Если контекст мешает надёжному продолжению, сохрани содержательный checkpoint и запроси передачу: bb team checkpoint <id> --file <абсолютный-json-путь> --rotate. Для руководителя используй его задачу координации.
- Поля JSON: goal, criteria[], progress, decisions[{what,why}], checks[{what,result}], blockers[], nextAction, files[]. Не выдумывай проверки и не копируй последний output вместо состояния. Заверши текущие операции; Team дождётся безопасной границы и сохранит окружение. Не создавай новый worktree или вторую задачу ради передачи.
- Если цель, состояние или безопасное продолжение неясны — спроси руководителя, а руководитель пользователя. Не повторяй spawn/send при неоднозначном результате.`
    : `Team session handoff:
- Keep one package in its session, including related fixes. When growing context prevents reliable continuation, save a substantive checkpoint and request handoff: bb team checkpoint <id> --file <absolute-json-path> --rotate. A lead uses its coordination task.
- JSON fields: goal, criteria[], progress, decisions[{what,why}], checks[{what,result}], blockers[], nextAction, files[]. Never invent checks or copy the last output as state. Finish current operations; Team waits for a safe boundary and preserves the environment. Do not create another worktree or task just for handoff.
- If the goal, state or safe continuation is unclear, ask the lead (the lead asks the user). Never repeat a spawn/send after an ambiguous result.`;
}

export function messages(lang: Language): Messages {
  return lang === "ru" ? RU : EN;
}
