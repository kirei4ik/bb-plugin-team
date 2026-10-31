// Localized strings for the v0.3+ commands: report, task, doctor, replace,
// stop / pause / resume, idle notifications, init templates.

import type { Language } from "./snapshot";

export interface Messages {
  reportWritten: (path: string) => string;
  reportShow: string;
  reportOutRequired: { message: string; hint: string };

  taskAdded: (id: number, role: string, title: string) => string;
  taskSent: (role: string, threadId: string) => string;
  taskUpdated: (id: number, from: string, to: string) => string;
  taskRemoved: (id: number) => string;
  taskListEmpty: string;
  taskListTitle: (project: string) => string;
  taskBusy: (role: string, ids: string) => string;
  taskRoleUnknown: (role: string) => { message: string; hint: string };
  taskNoThread: (role: string) => { message: string; hint: string };
  taskBody: (id: number, title: string, note: string | null, leadRef: string | null) => string;
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
  taskBody: (id, title, note, leadRef) =>
    [
      `Work package #${id}: ${title}`,
      ...(note ? ["", note] : []),
      "",
      leadRef
        ? `When it is done, report to the lead ${leadRef}. The lead accepts it with: bb team task done ${id}`
        : `When it is done, report back. Close it with: bb team task done ${id}`,
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
      ...(output ? ["Its last report:", "", output] : ["It left no final report."]),
      ...(tasks ? ["", "Open work packages of the role:", tasks] : []),
      "",
      "Read the previous thread if you need more context, then confirm readiness.",
    ].join("\n"),
  replaceDone: (role, oldId, newId) => `${role}: @thread:${oldId} → @thread:${newId}`,
  replaceArchived: (id) => `old thread archived: ${id}`,
  replaceKept: (id) => `old thread kept (unbound from the role): ${id}`,
  replaceReparented: (count) => `executors moved under the new lead: ${count}`,
  replaceConfigNote: (role, id) =>
    `note: .bb/team.yaml binds role "${role}" to threadId ${id} — update or remove that line`,
  replaceLeadNotice: (role, oldRef, newRef) =>
    `Team change: role "${role}" moved from ${oldRef} to a fresh thread ${newRef} (bb team replace). Send its next packages there.`,
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
  taskBody: (id, title, note, leadRef) =>
    [
      `Пакет работ #${id}: ${title}`,
      ...(note ? ["", note] : []),
      "",
      leadRef
        ? `По завершении отчитайся руководителю ${leadRef}. Руководитель принимает пакет: bb team task done ${id}`
        : `По завершении отчитайся. Закрыть пакет: bb team task done ${id}`,
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
      ...(output ? ["Его последний отчёт:", "", output] : ["Финального отчёта он не оставил."]),
      ...(tasks ? ["", "Открытые пакеты роли:", tasks] : []),
      "",
      "Если нужно больше контекста — прочитай предыдущий тред, затем подтверди готовность.",
    ].join("\n"),
  replaceDone: (role, oldId, newId) => `${role}: @thread:${oldId} → @thread:${newId}`,
  replaceArchived: (id) => `старый тред архивирован: ${id}`,
  replaceKept: (id) => `старый тред оставлен (отвязан от роли): ${id}`,
  replaceReparented: (count) => `исполнителей перенесено к новому руководителю: ${count}`,
  replaceConfigNote: (role, id) =>
    `заметка: .bb/team.yaml привязывает роль "${role}" к threadId ${id} — обновите или уберите строку`,
  replaceLeadNotice: (role, oldRef, newRef) =>
    `Изменение команды: роль "${role}" переехала из ${oldRef} в новый тред ${newRef} (bb team replace). Следующие пакеты отправляй туда.`,
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
};

export function messages(lang: Language): Messages {
  return lang === "ru" ? RU : EN;
}
