// bb-plugin-team — UI: the Team panel and the template editor (Settings → Team).
//
// Panel: team tabs per project, a creation wizard (template → editable roles
// → create), live hierarchy, role cards with "message" / "package" actions,
// "add executor" (new role or an existing free thread), packages with status
// controls, pause and git-versioning switches, "save as template".
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { RoleSessionCard } from "./role-session-card";
import { ResourcePanel } from "./resource-panel";
import { ReviewForm } from "./review-form";
import {
  GENERATOR_SELECTION_META,
  type GeneratorSelection,
  stringsFor,
} from "./settings-localization";
import {
  findDuplicateFallback,
  type ExecutionFallbackSelection,
  type ExecutionPolicy,
} from "./execution-policy";
import { ExecutionModelPicker, useProjectModelRouting, type ExecutionModel, type ProjectModelRoutingState } from "./execution-picker";
import type { ExperimentalProviderModelPickerRouting } from "@get-bb/plugin-sdk/app";
import { reportLabels } from "./report";
import {
  TASK_STATUSES,
  currentTask,
  relativeAgo,
  statusTone,
  type Language,
  type SnapshotRole,
  type RoleExecutionState,
  type StatusTone,
  type TaskStatus,
  type TeamSnapshot,
  type TeamTask,
} from "./snapshot";
import { builtinPrompt, type TeamTemplate, type TemplateRole } from "./templates";

const EXECUTION_LABELS: Record<Language, Record<RoleExecutionState["kind"], string>> = {
  en: {
    working: "Working",
    "awaiting-acceptance": "Awaiting acceptance or decision",
    "awaiting-checkpoint": "Awaiting saved checkpoint",
    "awaiting-safe-boundary": "Waiting for operations to finish",
    "awaiting-package": "Waiting for a ready package",
    replacing: "Replacing session",
    error: "Needs attention",
  },
  ru: {
    working: "Работает",
    "awaiting-acceptance": "Ждёт приёмки или решения",
    "awaiting-checkpoint": "Ждёт сохранения состояния",
    "awaiting-safe-boundary": "Ждёт окончания операций",
    "awaiting-package": "Ждёт готовую задачу",
    replacing: "Меняет сессию",
    error: "Требует внимания",
  },
};

function recoveryAction(language: Language, role: string, state: RoleExecutionState): string | null {
  if (language !== "ru") return state.safeAction;
  if(state.errorCode==="resource_hold")return "Откройте ресурсы команды и укажите конкретное решение. Замена сессии не сбрасывает бюджет.";
  if (state.errorCode === "release_failed" || state.errorCode === "delivery_uncertain") {
    return "Выполните bb team resume, чтобы продолжить доставку уже созданного запроса. Не отправляйте его повторно.";
  }
  if (state.errorCode === "spawn_uncertain") {
    return `Проверьте, был ли создан новый тред: bb team replace ${role} --dry-run --json. Подтвердите найденный тред через --thread или отмените незавершённую замену через --abort.`;
  }
  if (state.errorCode === "replacement_unfinished") {
    return `Продолжите сохранённую передачу: bb team replace ${role}. До переключения её можно отменить через --abort.`;
  }
  return `Проверьте причину ошибки и bb team doctor. После исправления проверьте план: bb team replace ${role} --dry-run. Автоматический повтор остановлен.`;
}

/* ──────────────────────── Labels ──────────────────────── */

const EN = {
  panelTitle: "Team",
  project: "Project",
  pickProject: "Pick a project",
  refresh: "Refresh",
  pause: "Pause executors",
  resume: "Resume",
  open: "Open",
  message: "Message",
  package: "Package",
  send: "Send",
  cancel: "Cancel",
  title: "Title",
  note: "Details (optional)",
  sendNow: "Send to the role now",
  add: "Add package",
  messagePlaceholder: "Message to the role…",
  loading: "Loading…",
  noProject: "Open the panel from a project, or pick one above.",
  sent: (n: number) => `Sent to ${n} thread(s).`,
  added: (id: number | string) => `Package #${id} added.`,
  failed: "Failed",
  trackerAbsent: "The Beads database does not exist yet — packages cannot be stored.",
  createDatabase: "Create database",
  databaseCreated: "Beads database created.",
  databaseReady: "Beads database already exists.",
  tip: "Tip: bb team report draws this picture in chat; bb team doctor checks the setup.",
  newTeam: "+ New team",
  createTeam: "Create team",
  creating: "Creating…",
  template: "Template",
  teamName: "Team name",
  teamTitle: "Team title",
  roles: "Roles",
  roleName: "Role",
  kind: "Kind",
  provider: "Provider",
  model: "Model",
  defaultProvider: "(project default)",
  lead: "Lead",
  enabled: "On",
  addRole: "+ Role",
  remove: "Remove",
  versioned: "Track in git",
  versionBlocked: "The root .gitignore ignores .bb/ — versioning is impossible",
  providerOff: (ids: string) => `Disabled or unknown providers: ${ids} — enable them (bb provider enable) or pick another`,
  nameTaken: "This team already exists",
  nameInvalid: "Name: lowercase letters, digits, hyphens",
  noTeams: "No team in this project yet — create one from a template.",
  addExecutor: "+ Add executor",
  newRole: "New role",
  existingThread: "Existing thread",
  thread: "Thread",
  noFreeThreads: "No free threads in this project",
  addExecutorDo: "Add",
  roleAdded: (role: string) => `Role "${role}" added.`,
  saveTemplate: "Save as template",
  templateId: "Template id",
  saved: (id: string) => `Template "${id}" saved.`,
  helpers: "Helpers",
  versionedOn: "Config is tracked in git",
  versionedOff: "Config is out of git",
  teamCreated: (team: string) => `Team "${team}" created.`,
  // template editor
  templates: "Team templates",
  templatesHint: "Templates are shared by every project of this server. Built-in ones are read-only: duplicate to change.",
  builtin: "built-in",
  duplicate: "Duplicate",
  save: "Save",
  delete: "Delete",
  description: "Description",
  prompt: "Prompt",
  promptHint: "Empty — the built-in prompt of the role kind",
  newTemplate: "New template",
  kinds: "Role kinds (the first one is the lead)",
  createTemplate: "Create with prepared prompts",
  deleted: (id: string) => `Template "${id}" deleted.`,
  details: "Role details",
  helper: "helper",
  notUnderLead: "Not a child of the lead thread — re-run create to re-link",
  selectModel: "Select model",
  useDefault: "Use default",
  reasoningLevel: "Reasoning",
  serviceTier: "Tier",
  starterPrompt: "Starter prompt",
  insertStarter: "Insert starter",
  defaultTemplate: "Default template",
  defaultSaved: "Default template saved.",
  generatorSelection: "Prompt draft model",
  generatorSelectionHint: "Provider and model for AI prompt drafts. Stored separately from role models.",
  defaultTemplateMissing: (id: string) => `Default template "${id}" does not exist.`,
  resetEdits: "Reset edits",
  generatorSaved: "Prompt draft model saved.",
  settingsTitle: "Team templates",
  executionPolicy: "Fallback models",
  executionPolicyHint: "Ordered approved backups for quota errors; a safe checkpoint is required.",
  policyDraftIncomplete: "Complete every fallback selection and explicitly approve the list, or remove unfinished entries.",
  noAdditionalCost: "I confirm these models are allowed without additional payment",
  addFallback: "+ Fallback model",
  duplicateFallback: "Duplicate fallback model",
  removeFallback: "Remove fallback",
  fallbackOrderHint: (n: number) => `Fallback #${n}`,
  treeSummary: (roles: number, running: number, errors: number, open: number) =>
    `${roles} roles · ${running} working${errors ? ` · ${errors} in error` : ""} · ${open} packages`,
  pausedTag: "paused",
  missingRoles: (names: string) => `Not created yet: ${names}`,
  spawnMissing: "Create missing",
  spawned: (n: number) => `Threads created: ${n}.`,
  stop: "Stop",
  stopped: (n: number) => `Stopped: ${n}.`,
  allProjects: "← All projects",
  more: "More",
  searchPlaceholder: "Search projects and teams…",
  groupTeams: "Projects with teams",
  groupReady: "A team can be created",
  groupBlocked: "A team cannot be created now",
  createHere: "Create a team",
  nothingFound: "Nothing found",
  current: "current",
  projectStats: (threads: number, running: number, errors: number) =>
    `${threads} threads · ${running} working${errors ? ` · ${errors} in error` : ""}`,
};

const RU: typeof EN = {
  panelTitle: "Команда",
  project: "Проект",
  pickProject: "Выберите проект",
  refresh: "Обновить",
  pause: "Пауза исполнителей",
  resume: "Снять паузу",
  open: "Открыть",
  message: "Сообщение",
  package: "Пакет",
  send: "Отправить",
  cancel: "Отмена",
  title: "Название",
  note: "Детали (необязательно)",
  sendNow: "Сразу отправить роли",
  add: "Добавить пакет",
  messagePlaceholder: "Сообщение роли…",
  loading: "Загрузка…",
  noProject: "Откройте панель из проекта или выберите проект выше.",
  sent: (n) => `Отправлено тредов: ${n}.`,
  added: (id) => `Пакет #${id} добавлен.`,
  failed: "Ошибка",
  trackerAbsent: "Базы Beads ещё нет — пакеты некуда сохранять.",
  createDatabase: "Создать базу",
  databaseCreated: "База Beads создана.",
  databaseReady: "База Beads уже есть.",
  tip: "Подсказка: bb team report рисует эту картину в чате; bb team doctor проверяет настройку.",
  newTeam: "+ Новая команда",
  createTeam: "Создать команду",
  creating: "Создаю…",
  template: "Шаблон",
  teamName: "Имя команды",
  teamTitle: "Название команды",
  roles: "Роли",
  roleName: "Роль",
  kind: "Вид",
  provider: "Провайдер",
  model: "Модель",
  defaultProvider: "(по умолчанию проекта)",
  lead: "Рук.",
  enabled: "Вкл",
  addRole: "+ Роль",
  remove: "Убрать",
  versioned: "Хранить в git",
  versionBlocked: "Корневой .gitignore игнорирует .bb/ — версионирование невозможно",
  providerOff: (ids) => `Выключенные или неизвестные провайдеры: ${ids} — включите (bb provider enable) или выберите другой`,
  nameTaken: "Такая команда уже есть",
  nameInvalid: "Имя: строчные латинские буквы, цифры, дефис",
  noTeams: "В проекте ещё нет команды — создайте её из шаблона.",
  addExecutor: "+ Добавить исполнителя",
  newRole: "Новая роль",
  existingThread: "Существующий тред",
  thread: "Тред",
  noFreeThreads: "Свободных тредов в проекте нет",
  addExecutorDo: "Добавить",
  roleAdded: (role) => `Роль «${role}» добавлена.`,
  saveTemplate: "Сохранить как шаблон",
  templateId: "Id шаблона",
  saved: (id) => `Шаблон «${id}» сохранён.`,
  helpers: "Помощники",
  versionedOn: "Конфиг хранится в git",
  versionedOff: "Конфиг вне git",
  teamCreated: (team) => `Команда «${team}» создана.`,
  templates: "Шаблоны команд",
  templatesHint: "Шаблоны общие для всех проектов сервера. Встроенные только для чтения — дублируйте, чтобы изменить.",
  builtin: "встроенный",
  duplicate: "Дублировать",
  save: "Сохранить",
  delete: "Удалить",
  description: "Описание",
  prompt: "Промпт",
  promptHint: "Пусто — встроенный промпт вида роли",
  newTemplate: "Новый шаблон",
  kinds: "Виды ролей (первая — руководитель)",
  createTemplate: "Создать с готовыми промптами",
  deleted: (id) => `Шаблон «${id}» удалён.`,
  details: "Роль подробно",
  helper: "помощник",
  notUnderLead: "Не дочерний тред руководителя — повторите create, чтобы восстановить связь",
  selectModel: "Выбрать модель",
  useDefault: "По умолчанию",
  reasoningLevel: "Рассуждение",
  serviceTier: "Тир",
  starterPrompt: "Стартовый промпт",
  insertStarter: "Вставить стартовый",
  defaultTemplate: "Шаблон по умолчанию",
  defaultSaved: "Шаблон по умолчанию сохранён.",
  generatorSelection: "Модель черновиков",
  generatorSelectionHint: "Провайдер и модель для ИИ-черновиков промптов. Хранится отдельно от моделей ролей.",
  defaultTemplateMissing: (id: string) => `Шаблона по умолчанию «${id}» не существует.`,
  resetEdits: "Сбросить правки",
  generatorSaved: "Модель черновиков сохранена.",
  settingsTitle: "Шаблоны команд",
  executionPolicy: "Резервные модели",
  executionPolicyHint: "Разрешённые резервы для ошибок квоты; требуется пригодный checkpoint.",
  policyDraftIncomplete: "Заполните все резервные модели и явно подтвердите список либо удалите незавершённые строки.",
  noAdditionalCost: "Я подтверждаю, что эти модели разрешены без дополнительной оплаты",
  addFallback: "+ Резервная модель",
  duplicateFallback: "Дублирующаяся резервная модель",
  removeFallback: "Убрать резерв",
  fallbackOrderHint: (n: number) => `Резерв ${n}`,
  treeSummary: (roles, running, errors, open) =>
    `ролей: ${roles} · в работе: ${running}${errors ? ` · с ошибкой: ${errors}` : ""} · пакетов: ${open}`,
  pausedTag: "пауза",
  missingRoles: (names) => `Ещё не созданы: ${names}`,
  spawnMissing: "Создать недостающих",
  spawned: (n) => `Создано тредов: ${n}.`,
  stop: "Остановить",
  stopped: (n) => `Остановлено: ${n}.`,
  allProjects: "← Все проекты",
  more: "Ещё",
  searchPlaceholder: "Поиск проекта или команды…",
  groupTeams: "Проекты с командами",
  groupReady: "Можно создать команду",
  groupBlocked: "Сейчас нельзя создать команду",
  createHere: "Создать команду",
  nothingFound: "Ничего не найдено",
  current: "текущий",
  projectStats: (threads, running, errors) =>
    `тредов: ${threads} · в работе: ${running}${errors ? ` · с ошибкой: ${errors}` : ""}`,
};

type Labels = typeof EN;
const LABELS: Record<Language, Labels> = { en: EN, ru: RU };

export interface EditorSettings {
  language: Language;
  defaultTemplate: string;
  defaultTemplateExists: boolean;
  generatorSelection: GeneratorSelection | null;
  reloadHint: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROLE_RE = /^[a-z0-9][a-z0-9-]*$/;

const TONE_CLASS: Record<StatusTone, string> = {
  running: "bg-primary",
  idle: "bg-green-500",
  error: "bg-destructive",
  missing: "bg-muted-foreground/40",
  other: "bg-amber-500",
};


const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function cleanTemplate(template: TeamTemplate): TeamTemplate {
  const { builtin: _builtin, description, ...rest } = template;
  void _builtin;
  return { ...rest, ...(description ? { description } : {}), roles: template.roles.map(cleanRole) };
}

/** RPC input must be strict JSON: drop fields left undefined by the editors. */
function cleanRole(role: TemplateRole): TemplateRole {
  const entries = Object.entries(role).filter(([, value]) => value !== undefined);
  // executionPolicy is an object and must be preserved when present.
  return Object.fromEntries(entries) as TemplateRole;
}

/* ──────────────────────── Small pieces ──────────────────────── */

function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
}) {
  const tone =
    variant === "primary"
      ? "bg-primary text-primary-foreground hover:opacity-90"
      : variant === "ghost"
        ? "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        : "border border-border bg-card text-foreground hover:bg-accent";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  );
}

const inputClass = "h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground";

function TeamIcon() {
  return <Icon name="team/team" fallback="Users" className="inline-block size-3.5 shrink-0" aria-hidden />;
}

function Dot({ tone }: { tone: StatusTone }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[tone]}`} />;
}

function Tag({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        strong ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
      }`}
    >
      {children}
    </span>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "warn" | "error" }) {
  const color =
    tone === "error" ? "text-destructive" : tone === "warn" ? "text-amber-600" : "text-muted-foreground";
  return <div className={`rounded-md bg-muted px-3 py-2 text-sm ${color}`}>{children}</div>;
}

/* ──────────────────────── Data hooks ──────────────────────── */

function useProviders() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ enabled: string[]; disabled: string[] }>({ enabled: [], disabled: [] });
  useEffect(() => {
    rpc.call("providers").then(setState).catch(() => undefined);
  }, [rpc]);
  return state;
}

function useTemplates() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    templates: TeamTemplate[];
    kinds: Array<{ kind: string; title: string }>;
    language: Language;
    defaultTemplate: string;
  } | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await rpc.call("templates"));
    } catch {
      setData(null);
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, refresh };
}

/* ──────────────────────── Execution policy editor ──────────────────────── */

function fallbackToModel(fb: ExecutionFallbackSelection): ExecutionModel {
  return {
    providerId: fb.provider,
    model: fb.model,
    reasoningLevel: fb.reasoningLevel,
    serviceTier: fb.serviceTier,
  };
}

function modelToFallback(model: ExecutionModel): ExecutionFallbackSelection {
  const fallback: ExecutionFallbackSelection = {
    provider: model.providerId || "",
    model: model.model || "",
  };
  if (model.reasoningLevel) fallback.reasoningLevel = model.reasoningLevel;
  if (model.serviceTier) fallback.serviceTier = model.serviceTier;
  return fallback;
}

function ExecutionPolicyEditor({
  role,
  policy,
  onChange,
  labels,
  providers,
  routing,
  readOnly,
  onValidityChange,
}: {
  role: TemplateRole;
  policy: ExecutionPolicy | undefined;
  onChange: (next: ExecutionPolicy | undefined) => void;
  onValidityChange?: (problem: string | null) => void;
  labels: Labels;
  providers: { enabled: string[]; disabled: string[] };
  routing?: ProjectModelRoutingState;
  readOnly?: boolean;
}) {
  const lang = labels === LABELS.ru ? "ru" : "en";
  // The editor owns the draft list, including not-yet-complete slots.
  const [fallbacks, setFallbacks] = useState<ExecutionFallbackSelection[]>(policy?.fallbacks ?? []);
  const [approved, setApproved] = useState<boolean>(policy?.noAdditionalCost === true);

  const policyKey = JSON.stringify(policy ?? null);
  useEffect(() => {
    setFallbacks(policy?.fallbacks ?? []);
    setApproved(policy?.noAdditionalCost === true);
  }, [policyKey]);
  const problemFor = (items: ExecutionFallbackSelection[], consent: boolean) => {
    if (!items.length) return null;
    if (items.some(item => !item.provider || !item.model) || !consent) return labels.policyDraftIncomplete;
    const duplicate = findDuplicateFallback(items);
    return duplicate ? `${labels.duplicateFallback}: ${duplicate.provider} · ${duplicate.model}` : null;
  };
  const problem = problemFor(fallbacks, approved);
  useEffect(() => { onValidityChange?.(problem); }, [problem, onValidityChange]);
  const emit = (next: ExecutionFallbackSelection[], consent: boolean) => {
    const issue = problemFor(next, consent);
    onValidityChange?.(issue);
    // Invalid drafts stay visible locally; never silently save a partial/empty list.
    if (!issue) onChange(next.length ? { noAdditionalCost: true, fallbacks: next } : undefined);
  };
  const addFallback = () => {
    const next = [...fallbacks, { provider: "", model: "" }];
    setFallbacks(next); setApproved(false); emit(next, false);
  };
  const updateFallback = (index: number, model: ExecutionModel | undefined) => {
    if (!model) {
      const next = fallbacks.filter((_, i) => i !== index);
      setFallbacks(next); emit(next, approved); return;
    }
    const selection = modelToFallback(model);
    const changed = JSON.stringify(selection) !== JSON.stringify(fallbacks[index]);
    const next = fallbacks.map((fb, i) => i === index ? selection : fb);
    const consent = changed ? false : approved;
    setFallbacks(next); setApproved(consent); emit(next, consent);
  };
  const toggleApproved = (consent: boolean) => {
    setApproved(consent); emit(fallbacks, consent);
  };
  const duplicate = findDuplicateFallback(fallbacks.filter(fb => fb.provider && fb.model));

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
        <span>
          {labels.executionPolicy}: {role.name}
        </span>
        <span className="text-[10px] uppercase tracking-wide">{labels.executionPolicyHint}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {fallbacks.map((fb, index) => {
          const off = fb.provider && !providers.enabled.includes(fb.provider);
          return (
            <div key={index} className="flex flex-wrap items-start gap-2">
              <span className="pt-1 text-muted-foreground">{labels.fallbackOrderHint(index + 1)}</span>
              <div className="flex-1">
                <ExecutionModelPicker
                  value={fb.provider ? fallbackToModel(fb) : undefined}
                  onChange={(next) => updateFallback(index, next)}
                  routing={routing}
                  disabled={readOnly}
                  language={lang}
                  defaultLabel={labels.defaultProvider}
                  selectLabel={labels.selectModel}
                  useDefaultLabel={labels.useDefault}
                />
                {off && (
                  <div className="pt-1 text-[10px] text-destructive">{labels.providerOff(fb.provider)}</div>
                )}
              </div>
              {!readOnly && (
                <Button variant="ghost" onClick={() => updateFallback(index, undefined)}>
                  {labels.removeFallback}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => toggleApproved(event.target.checked)}
            disabled={fallbacks.length === 0}
          />
          {labels.noAdditionalCost}
        </label>
      )}
      {readOnly && approved && (
        <div className="text-[11px] text-muted-foreground">{labels.noAdditionalCost}</div>
      )}
      {problem && !duplicate && <p role="alert" className="text-destructive">{problem}</p>}
      {duplicate && (
        <div className="text-[10px] text-destructive">
          {labels.duplicateFallback}: {duplicate.provider} · {duplicate.model}
        </div>
      )}
      {!readOnly && (
        <Button variant="ghost" onClick={addFallback}>
          {labels.addFallback}
        </Button>
      )}
    </div>
  );
}

/* ──────────────────────── Roles editor (wizard + template editor) ──────────────────────── */

function RolesEditor({
  roles,
  onChange,
  labels,
  kinds,
  providers,
  withPrompt,
  readOnly,
  routing,
  onPolicyDraftValidityChange,
}: {
  roles: TemplateRole[];
  onPolicyDraftValidityChange?: (valid: boolean) => void;
  onChange: (roles: TemplateRole[]) => void;
  labels: Labels;
  kinds: Array<{ kind: string; title: string }>;
  providers: { enabled: string[]; disabled: string[] };
  withPrompt?: boolean;
  readOnly?: boolean;
  routing?: ProjectModelRoutingState;
}) {
  const [policyProblems, setPolicyProblems] = useState<Record<string, string | null>>({});
  const policyValid = roles.every(role => !policyProblems[role.name]);
  useEffect(() => { onPolicyDraftValidityChange?.(policyValid); }, [policyValid, onPolicyDraftValidityChange]);
  const policyValidity = (name: string, problem: string | null) => setPolicyProblems(old =>
    old[name] === problem ? old : { ...old, [name]: problem });
  const update = (index: number, patch: Partial<TemplateRole>) =>
    onChange(roles.map((role, i) => (i === index ? cleanRole({ ...role, ...patch }) : role)));
  const setLead = (index: number) =>
    onChange(roles.map((role, i) => cleanRole({ ...role, lead: i === index ? true : undefined })));
  const addRole = (kind: string) => {
    const base = kind || "role";
    let name = base;
    for (let n = 2; roles.some((role) => role.name === name); n += 1) name = `${base}-${n}`;
    const title = kinds.find((k) => k.kind === kind)?.title ?? name;
    onChange([...roles, { name, kind, title }]);
  };
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 pr-1 font-medium">{labels.lead}</th>
            <th className="pb-1 pr-1 font-medium">{labels.roleName}</th>
            <th className="pb-1 pr-1 font-medium">{labels.title}</th>
            <th className="pb-1 pr-1 font-medium">{labels.kind}</th>
            <th className="pb-1 pr-1 font-medium" colSpan={2}>
              {labels.provider} · {labels.model}
            </th>
            <th className="pb-1 pr-1 font-medium">{labels.enabled}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roles.map((role, index) => {
            const off = role.provider && !providers.enabled.includes(role.provider);
            const modelValue: ExecutionModel | undefined =
              role.provider || role.model || role.reasoningLevel || role.serviceTier
                ? {
                    providerId: role.provider,
                    model: role.model,
                    reasoningLevel: role.reasoningLevel,
                    serviceTier: role.serviceTier,
                  }
                : undefined;
            return (
              <tr key={index} className="align-top">
                <td className="py-1 pr-1">
                  <input
                    type="radio"
                    aria-label={`${labels.lead} ${role.name}`}
                    checked={role.lead === true || (!roles.some((r) => r.lead) && index === 0)}
                    onChange={() => setLead(index)}
                    disabled={readOnly}
                  />
                </td>
                <td className="py-1 pr-1">
                  <input
                    aria-label={`${labels.roleName} ${index + 1}`}
                    value={role.name}
                    disabled={readOnly}
                    onChange={(event) => update(index, { name: event.target.value.toLowerCase() })}
                    className={`${inputClass} w-28 ${ROLE_RE.test(role.name) ? "" : "border-destructive"}`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <input
                    aria-label={`${labels.title} ${index + 1}`}
                    value={role.title ?? ""}
                    disabled={readOnly}
                    onChange={(event) => update(index, { title: event.target.value || undefined })}
                    className={`${inputClass} w-36`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <select
                    aria-label={`${labels.kind} ${index + 1}`}
                    value={role.kind ?? ""}
                    disabled={readOnly}
                    onChange={(event) => update(index, { kind: event.target.value || undefined })}
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {kinds.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.title}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-1" colSpan={2}>
                  <ExecutionModelPicker
                    value={modelValue}
                    onChange={(next) =>
                      update(index, {
                        provider: next?.providerId,
                        model: next?.model,
                        reasoningLevel: next?.reasoningLevel,
                        serviceTier: next?.serviceTier,
                      })
                    }
                    routing={routing}
                    disabled={readOnly}
                    language={labels === LABELS.ru ? "ru" : "en"}
                    defaultLabel={labels.defaultProvider}
                    selectLabel={labels.selectModel}
                    useDefaultLabel={labels.useDefault}
                  />
                  {off && (
                    <div className="pt-1 text-[10px] text-destructive">
                      {labels.providerOff(role.provider!)}
                    </div>
                  )}
                </td>
                <td className="py-1 pr-1">
                  <input
                    type="checkbox"
                    aria-label={`${labels.enabled} ${role.name}`}
                    checked={role.enabled !== false}
                    disabled={readOnly}
                    onChange={(event) => update(index, { enabled: event.target.checked ? undefined : false })}
                  />
                </td>
                <td className="py-1">
                  {!readOnly && (
                    <Button variant="ghost" onClick={() => onChange(roles.filter((_, i) => i !== index))}>
                      {labels.remove}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {roles.map((role, index) => (
        <ExecutionPolicyEditor
          key={role.name}
          role={role}
          policy={role.executionPolicy}
          onValidityChange={problem => policyValidity(role.name, problem)}
          onChange={(next) => update(index, { executionPolicy: next })}
          labels={labels}
          providers={providers}
          routing={routing}
          readOnly={readOnly}
        />
      ))}
      {withPrompt &&
        roles.map((role, index) => {
          const starter = builtinPrompt(labels === RU ? "ru" : "en", role);
          return (
            <div key={`p${index}`} className="flex flex-col gap-1 rounded-md border border-border bg-background p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                <span>
                  {labels.prompt}: {role.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide">{labels.starterPrompt}</span>
              </div>
              <textarea
                aria-label={`${labels.prompt} ${role.name}`}
                value={role.prompt ?? ""}
                placeholder={labels.promptHint}
                rows={4}
                disabled={readOnly}
                onChange={(event) => update(index, { prompt: event.target.value || undefined })}
                className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground disabled:opacity-60"
              />
              {!role.prompt && (
                <div className="flex flex-col gap-1">
                  <div className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    {starter}
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => update(index, { prompt: starter })}
                      className="self-start rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
                    >
                      {labels.insertStarter}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label={labels.addRole}
            value=""
            onChange={(event) => event.target.value && addRole(event.target.value)}
            className={inputClass}
          >
            <option value="">{labels.addRole}</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.title}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** Problems that block creating a team from these roles. */
function rolesProblems(roles: TemplateRole[], providers: { enabled: string[] }, labels: Labels): string[] {
  const problems: string[] = [];
  const active = roles.filter((role) => role.enabled !== false);
  const names = roles.map((role) => role.name);
  if (active.length === 0) problems.push(labels.roles);
  if (names.some((name) => !ROLE_RE.test(name)) || new Set(names).size !== names.length) {
    problems.push(labels.nameInvalid);
  }
  const off = [...new Set(active.map((r) => r.provider).filter((p): p is string => !!p && !providers.enabled.includes(p)))];
  if (off.length > 0) problems.push(labels.providerOff(off.join(", ")));
  for (const role of active) {
    const duplicate = role.executionPolicy ? findDuplicateFallback(role.executionPolicy.fallbacks) : undefined;
    if (duplicate) problems.push(`${labels.duplicateFallback}: ${duplicate.provider} · ${duplicate.model} (${role.name})`);
  }
  return problems;
}

/* ──────────────────────── Create team wizard ──────────────────────── */

function CreateTeam({
  projectId,
  existingTeams,
  onCreated,
  onCancel,
}: {
  projectId: string;
  existingTeams: string[];
  onCreated: (team: string) => void;
  onCancel?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { data } = useTemplates();
  const providers = useProviders();
  const routing = useProjectModelRouting(projectId);
  const labels = LABELS[data?.language ?? "en"];
  const [selectedTemplateId, setTemplateId] = useState<string | null>(null);
  const templateId = selectedTemplateId ?? data?.defaultTemplate ?? "dev";
  const [team, setTeam] = useState(existingTeams.length === 0 ? "main" : "");
  const [title, setTitle] = useState("");
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [versioned, setVersioned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [policyDraftValid, setPolicyDraftValid] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const template = data?.templates.find((tpl) => tpl.id === templateId);
    if (!template) return;
    setRoles(template.roles.map((role) => ({ ...role })));
    setTitle(template.title);
    if (existingTeams.length > 0) setTeam((current) => current || template.id);
  }, [data, templateId, existingTeams.length]);

  const nameProblem = !NAME_RE.test(team)
    ? labels.nameInvalid
    : existingTeams.includes(team)
      ? labels.nameTaken
      : null;
  const templateProblem = data && !data.templates.some((tpl) => tpl.id === templateId)
    ? (data.language === "ru" ? `Шаблон «${templateId}» не найден. Выберите существующий шаблон.` : `Template "${templateId}" is missing. Select an existing template.`)
    : null;
  const problems = [...(nameProblem ? [nameProblem] : []), ...(templateProblem ? [templateProblem] : []), ...rolesProblems(roles, providers, labels), ...(!policyDraftValid ? [labels.policyDraftIncomplete] : [])];

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("teamCreate", { projectId, team, title: title || team, roles: roles.map(cleanRole), versioned });
      onCreated(team);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Notice>{labels.loading}</Notice>;
  return (
    <form onSubmit={create} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.template}
          <select
            aria-label={labels.template}
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            className={inputClass}
          >
            {data.templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.teamName}
          <input
            aria-label={labels.teamName}
            value={team}
            onChange={(event) => setTeam(event.target.value.toLowerCase())}
            className={`${inputClass} w-32`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.teamTitle}
          <input
            aria-label={labels.teamTitle}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={`${inputClass} w-56`}
          />
        </label>
        <label className="flex items-center gap-1.5 pb-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={versioned} onChange={(event) => setVersioned(event.target.checked)} />
          {labels.versioned}
        </label>
      </div>
      {data.templates.find((tpl) => tpl.id === templateId)?.description && (
        <div className="text-xs text-muted-foreground">
          {data.templates.find((tpl) => tpl.id === templateId)?.description}
        </div>
      )}
      <RolesEditor key={templateId} onPolicyDraftValidityChange={setPolicyDraftValid} roles={roles} onChange={setRoles} labels={labels} kinds={data.kinds} providers={providers} routing={routing} />
      {problems.map((problem) => (
        <Notice key={problem} tone="warn">
          {problem}
        </Notice>
      ))}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" disabled={busy || problems.length > 0}>
          {busy ? labels.creating : labels.createTeam}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {labels.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}

/* ──────────────────────── Add executor ──────────────────────── */

function AddExecutor({
  projectId,
  team,
  existingRoles,
  labels,
  onDone,
  onCancel,
}: {
  projectId: string;
  team: string;
  existingRoles: string[];
  labels: Labels;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { data } = useTemplates();
  const providers = useProviders();
  const routing = useProjectModelRouting(projectId);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [kind, setKind] = useState("junior");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [executionModel, setExecutionModel] = useState<ExecutionModel | undefined>(undefined);
  const [executionPolicy, setExecutionPolicy] = useState<ExecutionPolicy | undefined>(undefined);
  const [threadId, setThreadId] = useState("");
  const [free, setFree] = useState<Array<{ id: string; title: string; status: string; provider: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc
      .call("freeThreads", { projectId })
      .then((result) => setFree(result.threads))
      .catch(() => setFree([]));
  }, [rpc, projectId]);

  const suggested = useMemo(() => {
    let candidate = kind || "role";
    for (let n = 2; existingRoles.includes(candidate); n += 1) candidate = `${kind}-${n}`;
    return candidate;
  }, [kind, existingRoles]);
  const roleName = name || suggested;
  const kindTitle = data?.kinds.find((k) => k.kind === kind)?.title ?? roleName;
  const [policyDraftValid, setPolicyDraftValid] = useState(true);
  const problems: string[] = [];
  if (mode === "new" && !policyDraftValid) problems.push(labels.policyDraftIncomplete);
  if (!ROLE_RE.test(roleName) || existingRoles.includes(roleName)) problems.push(labels.nameInvalid);
  if (mode === "new" && executionModel?.providerId && !providers.enabled.includes(executionModel.providerId)) {
    problems.push(labels.providerOff(executionModel.providerId));
  }
  if (mode === "new" && executionPolicy) {
    const duplicate = findDuplicateFallback(executionPolicy.fallbacks);
    if (duplicate) problems.push(`${labels.duplicateFallback}: ${duplicate.provider} · ${duplicate.model}`);
  }
  if (mode === "existing" && !threadId) problems.push(labels.noFreeThreads);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const role: TemplateRole = {
        name: roleName,
        ...(kind ? { kind } : {}),
        title: title || kindTitle,
        ...(mode === "new" && executionModel?.providerId ? { provider: executionModel.providerId } : {}),
        ...(mode === "new" && executionModel?.model ? { model: executionModel.model } : {}),
        ...(mode === "new" && executionModel?.reasoningLevel ? { reasoningLevel: executionModel.reasoningLevel } : {}),
        ...(mode === "new" && executionModel?.serviceTier ? { serviceTier: executionModel.serviceTier } : {}),
        ...(mode === "new" && executionPolicy ? { executionPolicy } : {}),
      };
      await rpc.call("roleAdd", { projectId, team, role, ...(mode === "existing" ? { threadId } : {}) });
      onDone(labels.roleAdded(roleName));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex gap-3 text-xs text-foreground">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
          {labels.newRole}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} />
          {labels.existingThread}
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.kind}
          <select aria-label={labels.kind} value={kind} onChange={(event) => setKind(event.target.value)} className={inputClass}>
            {(data?.kinds ?? []).map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.roleName}
          <input
            aria-label={labels.roleName}
            value={name}
            placeholder={suggested}
            onChange={(event) => setName(event.target.value.toLowerCase())}
            className={`${inputClass} w-32`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.title}
          <input
            aria-label={labels.title}
            value={title}
            placeholder={kindTitle}
            onChange={(event) => setTitle(event.target.value)}
            className={`${inputClass} w-40`}
          />
        </label>
        {mode === "new" ? (
          <ExecutionModelPicker
            value={executionModel}
            onChange={setExecutionModel}
            routing={routing}
            language={labels === LABELS.ru ? "ru" : "en"}
            defaultLabel={labels.defaultProvider}
            selectLabel={labels.selectModel}
            useDefaultLabel={labels.useDefault}
          />
        ) : (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {labels.thread}
            <select aria-label={labels.thread} value={threadId} onChange={(event) => setThreadId(event.target.value)} className={`${inputClass} w-64`}>
              <option value="">{free.length === 0 ? labels.noFreeThreads : "—"}</option>
              {free.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title} · {thread.provider} · {thread.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode === "new" && (
        <ExecutionPolicyEditor
          role={{ name: roleName }}
          policy={executionPolicy}
          onValidityChange={problem => setPolicyDraftValid(!problem)}
          onChange={setExecutionPolicy}
          labels={labels}
          providers={providers}
          routing={routing}
        />
      )}
      {problems.map((problem) => (
        <Notice key={problem} tone="warn">
          {problem}
        </Notice>
      ))}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" disabled={busy || problems.length > 0}>
          {labels.addExecutorDo}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}

/* ──────────────────────── Team tree ──────────────────────── */

interface Selection {
  team: string;
  role: string;
}

function TreeRow({
  depth,
  last,
  tone,
  title,
  meta,
  badge,
  warn,
  selected,
  onClick,
}: {
  depth: number;
  last?: boolean;
  tone: StatusTone;
  title: string;
  meta: string;
  badge?: ReactNode;
  warn?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{ paddingLeft: 8 + depth * 18 }}
      className={`group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs transition-colors ${
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
      }`}
    >
      {depth > 0 && <span className="text-muted-foreground/60">{last ? "└" : "├"}</span>}
      <Dot tone={tone} />
      <span className={`truncate font-medium ${tone === "missing" ? "text-muted-foreground" : "text-foreground"}`}>{title}</span>
      <span className="truncate text-muted-foreground">{meta}</span>
      {warn && (
        <span title={warn} className="text-amber-600">
          ⚠
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">{badge}</span>
    </button>
  );
}

function TeamBlock({
  snapshot,
  language,
  labels,
  expanded,
  onToggle,
  selection,
  onSelect,
  onAction,
  adding,
  onAdding,
}: {
  snapshot: TeamSnapshot;
  language: Language;
  labels: Labels;
  expanded: boolean;
  onToggle: () => void;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onAction: (action: () => Promise<string>) => Promise<void>;
  adding: boolean;
  onAdding: (adding: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const l = reportLabels(language);
  const projectId = snapshot.projectId;
  const team = snapshot.team;
  const threads = snapshot.roles.flatMap((role) => role.threads);
  const running = threads.filter((thread) => statusTone(thread.status) === "running").length;
  const errors = threads.filter((thread) => statusTone(thread.status) === "error").length;
  const tasks = snapshot.roles.flatMap((role) => role.tasks).sort((a, b) => a.createdAtMs - b.createdAtMs);
  const lead = snapshot.roles.find((role) => role.lead);
  const leadThread = lead?.threads[0]?.threadId ?? null;
  const executors = snapshot.roles.filter((role) => !role.lead && (role.enabled || role.threads.length > 0));
  const missing = snapshot.roles.filter((role) => role.enabled && role.inConfig && role.threads.length === 0);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [menu, setMenu] = useState(false);
  const nowMs = snapshot.generatedAtMs;

  const roleRow = (role: SnapshotRole, depth: number, last = false) => {
    const thread = role.threads[0];
    const task = currentTask(role.tasks);
    const tone: StatusTone = thread ? statusTone(thread.status) : "missing";
    const status = thread ? l.threadStatus[thread.status] ?? thread.status : l.missing;
    const provider = thread?.provider ?? role.provider ?? labels.defaultProvider;
    const broken =
      !role.lead && thread && leadThread && thread.parentThreadId !== leadThread ? labels.notUnderLead : undefined;
    return (
      <div key={role.name}>
        <TreeRow
          depth={depth}
          last={last && role.helpers.length === 0}
          tone={tone}
          title={role.title}
          meta={`${role.name} · ${provider}${role.model ? ` · ${role.model}` : ""} · ${status}${
            thread ? ` · ${relativeAgo(thread.updatedAtMs, nowMs)}` : ""
          }`}
          warn={broken}
          selected={selection?.team === team && selection.role === role.name}
          onClick={() => onSelect({ team, role: role.name })}
          badge={
            <>
              {role.executionState && <Tag>{EXECUTION_LABELS[language][role.executionState.kind]}</Tag>}
              {role.threads.length > 1 && <Tag>×{role.threads.length}</Tag>}
              {task && (
                <span className="max-w-48 truncate rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
                  #{task.id} {task.title} · {l.taskStatus[task.status] ?? task.status}
                </span>
              )}
              {!role.inConfig && <Tag>{l.notInConfig}</Tag>}
            </>
          }
        />
        {role.executionState?.kind === "error" && (
          <div role="alert" className="px-3 py-1 text-xs text-destructive">
            {role.executionState.errorCode==="resource_hold"?(language==="ru"?"Работа ждёт решения по ресурсам.":"Work awaits a resource decision."):(language === "ru" ? "Передача сессии остановлена." : "Session handoff stopped.")}
            {role.executionState.errorMessage && ` ${role.executionState.errorMessage}`}
            {recoveryAction(language, role.name, role.executionState) && ` · ${recoveryAction(language, role.name, role.executionState)}`}
          </div>
        )}
        {role.helpers.map((helper, index) => (
          <TreeRow
            key={helper.threadId}
            depth={depth + 1}
            last={index === role.helpers.length - 1}
            tone={statusTone(helper.status)}
            title={helper.title || helper.threadId}
            meta={`${labels.helper} · ${helper.provider} · ${l.threadStatus[helper.status] ?? helper.status}`}
            selected={selection?.team === team && selection.role === role.name}
            onClick={() => onSelect({ team, role: role.name })}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className="w-3 text-muted-foreground">{expanded ? "▾" : "▸"}</span>
          <TeamIcon /> {team}
          {snapshot.teamTitle && <span className="font-normal text-muted-foreground">— {snapshot.teamTitle}</span>}
        </button>
        <span className="text-xs text-muted-foreground">
          {labels.treeSummary(snapshot.roles.filter((r) => r.enabled).length, running, errors, tasks.length)}
        </span>
        {snapshot.paused && <Tag>{labels.pausedTag}</Tag>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {snapshot.configSource && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground" title={snapshot.versioningBlocked ? labels.versionBlocked : undefined}>
              <input
                type="checkbox"
                aria-label={`${labels.versioned} ${team}`}
                checked={snapshot.versioned === true}
                disabled={snapshot.versioningBlocked}
                onChange={(event) =>
                  void onAction(async () => {
                    const result = await rpc.call("setVersioned", { projectId, team, versioned: event.target.checked });
                    return result.blocked ? labels.versionBlocked : result.versioned ? labels.versionedOn : labels.versionedOff;
                  })
                }
              />
              {labels.versioned}
            </label>
          )}
          <Button
            onClick={() =>
              void onAction(async () => {
                const result = await rpc.call("pause", { projectId, team, paused: !snapshot.paused });
                return result.paused ? l.paused : `${labels.resume}: ${result.count}`;
              })
            }
          >
            {snapshot.paused ? labels.resume : labels.pause}
          </Button>
          {snapshot.configSource && !adding && <Button onClick={() => onAdding(true)}>{labels.addExecutor}</Button>}
          {snapshot.configSource && (
            <span className="relative">
              <Button variant="ghost" onClick={() => setMenu(!menu)}>
                <span aria-label={labels.more}>⋯</span>
              </Button>
              {menu && (
                <span role="menu" className="absolute right-0 top-8 z-10 flex w-56 flex-col rounded-md border border-border bg-popover p-1 shadow-md">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setTemplateId(team);
                    }}
                    className="rounded px-2 py-1.5 text-left text-xs text-popover-foreground hover:bg-accent"
                  >
                    {labels.saveTemplate}
                  </button>
                  {snapshot.configSource && (
                    <span className="px-2 py-1.5 text-[11px] text-muted-foreground">{snapshot.configSource}</span>
                  )}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {expanded && (
        <>
          {snapshot.configError && <Notice tone="error">{l.configError(snapshot.configError)}</Notice>}
          {!snapshot.configSource && <Notice>{l.noConfig}</Notice>}
          {templateId !== null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!NAME_RE.test(templateId)) return;
                void onAction(async () => {
                  await rpc.call("templateFromTeam", { projectId, team, id: templateId, title: snapshot.teamTitle ?? templateId });
                  setTemplateId(null);
                  return labels.saved(templateId);
                });
              }}
              className="flex items-end gap-2 px-1"
            >
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {labels.templateId}
                <input aria-label={labels.templateId} value={templateId} onChange={(event) => setTemplateId(event.target.value.toLowerCase())} className={inputClass} />
              </label>
              <Button type="submit" variant="primary" disabled={!NAME_RE.test(templateId)}>
                {labels.save}
              </Button>
              <Button variant="ghost" onClick={() => setTemplateId(null)}>
                {labels.cancel}
              </Button>
            </form>
          )}
          {adding && (
            <AddExecutor
              projectId={projectId}
              team={team}
              existingRoles={snapshot.roles.map((role) => role.name)}
              labels={labels}
              onDone={(message) => {
                onAdding(false);
                void onAction(async () => message);
              }}
              onCancel={() => onAdding(false)}
            />
          )}
          <ResourcePanel snapshot={snapshot} language={language} onChanged={async()=>{await onAction(async()=>language==="ru"?"Решение по ресурсам сохранено.":"Resource decision saved.");}}/>
          <div className="flex flex-col">
            {lead && roleRow(lead, 0)}
            {executors.map((role, index) => roleRow(role, lead ? 1 : 0, index === executors.length - 1))}
          </div>
          {missing.length > 0 && snapshot.configSource && (
            <div className="flex items-center gap-2 px-1 pt-1">
              <span className="text-xs text-muted-foreground">{labels.missingRoles(missing.map((r) => r.name).join(", "))}</span>
              <Button
                onClick={() =>
                  void onAction(async () => labels.spawned((await rpc.call("teamSpawn", { projectId, team })).spawned))
                }
              >
                {labels.spawnMissing}
              </Button>
            </div>
          )}
          <div className="px-1 pt-1">
            <button type="button" onClick={() => setShowTasks(!showTasks)} className="text-xs text-muted-foreground hover:text-foreground">
              {showTasks ? "▾" : "▸"} {l.tasks} ({tasks.length})
            </button>
            {showTasks &&
              (tasks.length === 0 ? (
                <div className="py-1 text-xs text-muted-foreground">{l.noTasks}</div>
              ) : (
                <table className="mt-1 w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th scope="col" className="py-1 pr-2">ID</th>
                      <th scope="col" className="py-1 pr-2">{language === "ru" ? "Назначена роли" : "Assigned role"}</th>
                      <th scope="col" className="py-1 pr-2">{language === "ru" ? "Задача" : "Task"}</th>
                      <th scope="col" className="py-1 text-right">{language === "ru" ? "Статус" : "Status"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id} className="border-b border-border">
                        <td className="py-1 pr-2 text-muted-foreground">#{task.id}</td>
                        <td className="py-1 pr-2 text-foreground" title={`${team} · ${task.role || "—"}`}>{task.role || (language === "ru" ? "Не назначена" : "Unassigned")}</td>
                        <td className="py-1 pr-2 text-foreground"><TaskContext task={task} language={language} /></td>
                        <td className="py-1 text-right">
                          <TaskStatusSelect projectId={projectId} team={team} task={task} language={language} onAction={onAction} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function TaskContext({task,language}:{task:TeamTask;language:Language}) {
  const ru=language==="ru";
  const fields=[
    [ru?"Описание":"Description",task.note],
    [ru?"Критерии приёмки":"Acceptance criteria",task.criteria],
    [ru?"Зависимости":"Dependencies",task.dependencies?.join(", ")],
    [ru?"Решения":"Decisions",task.decisions],
    [ru?"Результат":"Result",task.result],
  ].filter(([,value])=>value);
  return <details className="text-xs"><summary>{task.title}{task.priority!==undefined?` · P${task.priority}`:""}</summary>
    {fields.map(([label,value])=><div key={label} className="mt-1 whitespace-pre-wrap"><strong>{label}: </strong>{value}</div>)}
  </details>;
}

function TaskStatusSelect({
  projectId,
  team,
  task,
  language,
  onAction,
}: {
  projectId: string;
  team: string;
  task: TeamTask;
  language: Language;
  onAction: (action: () => Promise<string>) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const l = reportLabels(language);
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
    <select
      aria-label={`#${task.id}`}
      value={task.status}
      onChange={(event) => {
        const status = event.target.value as TaskStatus;
        if (status === "done" || (task.status === "review" && (status === "todo" || status === "in-progress"))) {
          setReviewOpen(true); return;
        }
        void onAction(async () => {
          const result = await rpc.call("taskUpdate", { projectId, team, id: task.id, status });
          return `#${result.task.id}: ${l.taskStatus[result.task.status] ?? result.task.status}`;
        });
      }}
      className="h-6 rounded-md border border-input bg-background px-1 text-xs text-foreground"
    >
      {TASK_STATUSES.map((status) => (
        <option key={status} value={status}>
          {l.taskStatus[status] ?? status}
        </option>
      ))}
    </select>
    <button type="button" onClick={() => setReviewOpen(value => !value)} className="text-xs underline">
      {language === "ru" ? "Отчёт и приёмка" : "Report and acceptance"}
    </button>
    {reviewOpen && <div className="w-full min-w-64 rounded-md border border-border bg-card p-2 text-left">
      <ReviewForm key={`${task.id}:${task.review?.submission?.id ?? "none"}`} projectId={projectId} team={team} task={task} language={language}
        onChanged={() => onAction(async () => language === "ru" ? `Состояние задачи #${task.id} обновлено.` : `Task #${task.id} updated.`)} />
      <button type="button" className="mt-2 text-xs underline" onClick={() => setReviewOpen(false)}>{language === "ru" ? "Закрыть отчёт" : "Close report"}</button>
    </div>}
    </div>
  );
}

/* ──────────────────────── Role details (actions) ──────────────────────── */

function ExistingRolePolicy({projectId,team,role,labels,onAction}: {
  projectId:string;team:string;role:string;labels:Labels;onAction:(action:()=>Promise<string>)=>Promise<void>;
}) {
  const rpc=useRpc<typeof rpcContract>(); const routing=useProjectModelRouting(projectId);
  const [data,setData]=useState<{role:TemplateRole;source:string;revision:string}|null>(null);
  const [providers,setProviders]=useState<{enabled:string[];disabled:string[]}>({enabled:[],disabled:[]});
  const [policy,setPolicy]=useState<ExecutionPolicy|undefined>();
  const [primary,setPrimary]=useState<ExecutionModel|undefined>();
  const [problem,setProblem]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const ru=labels===LABELS.ru;
  useEffect(()=>{let active=true;Promise.all([rpc.call("rolePolicy",{projectId,team,role}),rpc.call("providers",null)]).then(([d,p])=>{
    if(active){setData(d);setPolicy(d.role.executionPolicy);setProviders(p);setPrimary({providerId:d.role.provider,model:d.role.model,reasoningLevel:d.role.reasoningLevel,serviceTier:d.role.serviceTier});}
  },e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[rpc,projectId,team,role]);
  if(error) return <Notice>{error}</Notice>;
  if(!data) return <p>{ru?"Загрузка профиля…":"Loading profile…"}</p>;
  return <section aria-label={ru?"Профиль моделей сотрудника":"Employee model profile"} className="flex flex-col gap-2 border-t border-border pt-2 text-xs">
    <p>{ru?"Источник: конфиг команды":"Source: team config"} · {data.source}</p>
    <p>{ru?"Основная модель":"Primary model"}</p>
    <ExecutionModelPicker value={primary} onChange={setPrimary} routing={routing} language={ru?"ru":"en"} defaultLabel={labels.defaultProvider} selectLabel={labels.selectModel} useDefaultLabel={labels.useDefault}/>

    <p>{ru?"Шаблон скопирован при создании команды; последующие правки шаблона сюда не наследуются. Очистка списка означает отсутствие резервов, а не автоматический выбор модели.":"Templates are copied when creating a team; later template edits are not inherited. Clearing the list means no backups, not automatic model selection."}</p>
    <ExecutionPolicyEditor role={data.role} policy={policy} onChange={setPolicy} onValidityChange={setProblem} providers={providers} routing={routing} labels={labels}/>
    <p>{ru?"Сохранение переформатирует конфиг и удалит YAML-комментарии. Профиль получат новые и заменённые сессии; текущая сессия не меняется.":"Saving reformats the config and removes YAML comments. New and replacement sessions receive the profile; the current session is unchanged."}</p>
    <Button disabled={busy||!!problem} onClick={()=>{setBusy(true);void onAction(async()=>{
      const result=await rpc.call("rolePolicy",{projectId,team,role,primary:Object.fromEntries(Object.entries({provider:primary?.providerId,model:primary?.model,reasoningLevel:primary?.reasoningLevel,serviceTier:primary?.serviceTier}).filter(([,value])=>value!==undefined)),policy:policy??null,expectedRevision:data.revision});setData(result);
      return ru?"Профиль сохранён для новых сессий.":"Profile saved for new sessions.";
    }).finally(()=>setBusy(false));}}>{labels.save}</Button>
  </section>;
}

function RoleDetails({
  snapshot,
  role,
  language,
  labels,
  onAction,
  onClose,
}: {
  snapshot: TeamSnapshot;
  role: SnapshotRole;
  language: Language;
  labels: Labels;
  onAction: (action: () => Promise<string>) => Promise<void>;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const l = reportLabels(language);
  const [mode, setMode] = useState<"none" | "message" | "package">("none");
  const [editingPolicy,setEditingPolicy]=useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const { projectId, team } = snapshot;
  const hasThread = role.threads.length > 0;
  const running = [...role.threads, ...role.helpers].some((thread) => statusTone(thread.status) === "running");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    const body = text.trim();
    void onAction(async () => {
      if (mode === "message") return labels.sent((await rpc.call("tell", { projectId, team, role: role.name, text: body })).sent);
      const result = await rpc.call("taskAdd", {
        projectId,
        team,
        role: role.name,
        title: body,
        ...(note.trim() ? { note: note.trim() } : {}),
        send: sendNow && hasThread,
      });
      return labels.added(result.task.id);
    }).then(() => {
      setText("");
      setNote("");
      setMode("none");
    });
  };

  return (
    <aside aria-label={labels.details} className="flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-3 lg:w-80 lg:shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col">
          <strong className="truncate text-sm text-foreground">{role.title}</strong>
          <span className="truncate text-xs text-muted-foreground">
            {team} · {role.name}
            {role.lead ? ` · ${l.lead}` : ""}
          </span>
        </div>
        <button type="button" aria-label={labels.cancel} onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">
          {labels.provider}: <span className="text-foreground">{role.threads[0]?.provider ?? role.provider ?? labels.defaultProvider}</span>
          {role.model ? ` · ${role.model}` : ""}
        </span>
        {role.threads.map((thread) => (
          <button key={thread.threadId} type="button" onClick={() => navigate.toThread(thread.threadId)} className="flex items-center gap-1.5 text-left text-foreground hover:underline">
            <Dot tone={statusTone(thread.status)} /> {l.threadStatus[thread.status] ?? thread.status} · {l.ago(relativeAgo(thread.updatedAtMs, snapshot.generatedAtMs))} · {thread.threadId}
          </button>
        ))}
        {!hasThread && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Dot tone="missing" /> {l.missing}
          </span>
        )}
        {role.helpers.length > 0 && <span className="pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{labels.helpers}</span>}
        {role.helpers.map((helper) => (
          <button key={helper.threadId} type="button" onClick={() => navigate.toThread(helper.threadId)} className="flex items-center gap-1.5 truncate text-left text-foreground hover:underline">
            <Dot tone={statusTone(helper.status)} /> <span className="truncate">{helper.title || helper.threadId}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {hasThread && (
          <Button variant="primary" onClick={() => navigate.toThread(role.threads[0]!.threadId)}>
            {labels.open}
          </Button>
        )}
        {hasThread && <Button onClick={() => setMode("message")}>{labels.message}</Button>}
        <Button onClick={() => setMode("package")}>{labels.package}</Button>
        {running && (
          <Button
            variant="ghost"
            onClick={() => void onAction(async () => labels.stopped((await rpc.call("stop", { projectId, team, role: role.name })).stopped))}
          >
            {labels.stop}
          </Button>
        )}
      </div>
      {role.inConfig && <Button onClick={()=>setEditingPolicy(value=>!value)}>{labels.executionPolicy}</Button>}
      {editingPolicy && <ExistingRolePolicy key={`${projectId}:${team}:${role.name}`} projectId={projectId} team={team} role={role.name} labels={labels} onAction={onAction}/>}
      <RoleSessionCard
        key={`${projectId}:${team}:${role.name}:${role.threads.map(thread => thread.threadId).join(",")}`}
        projectId={projectId} team={team} role={role.name}
        threadId={role.threads.length === 1 ? role.threads[0]!.threadId : null}
        revision={`${snapshot.paused}:${role.threads[0]?.updatedAtMs}:${role.executionState?.atMs}`}
        language={language}
        onChanged={() => onAction(async () => language === "ru" ? "Состояние передачи обновлено." : "Handoff state updated.")}
      />
      {mode !== "none" && (
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          {mode === "message" ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={labels.messagePlaceholder}
              rows={4}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            />
          ) : (
            <>
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder={labels.title} className={inputClass} />
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={labels.note}
                rows={3}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
              />
              {hasThread && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={sendNow} onChange={(event) => setSendNow(event.target.checked)} />
                  {labels.sendNow}
                </label>
              )}
            </>
          )}
          <div className="flex gap-1.5">
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              {mode === "message" ? labels.send : labels.add}
            </Button>
            <Button variant="ghost" onClick={() => setMode("none")}>
              {labels.cancel}
            </Button>
          </div>
        </form>
      )}
      {role.tasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{l.tasks}</span>
          {role.tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-2 text-xs text-foreground">
              <span className="text-muted-foreground">#{task.id}</span>
              <TaskContext task={task} language={language} />
              <div className="ml-auto">
                <TaskStatusSelect projectId={projectId} team={team} task={task} language={language} onAction={onAction} />
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* ──────────────────────── Project overview (panel root) ──────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  path: string | null;
  teams: string[];
  threads: number;
  running: number;
  errors: number;
  state: "teams" | "ready" | "blocked";
  reason: string | null;
}

function ProjectOverview({
  currentProjectId,
  onOpen,
}: {
  currentProjectId: string | null;
  onOpen: (projectId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const labels = LABELS[language];

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("overview");
      setRows(result.projects);
      setLanguage(result.language);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime("team-changed", () => void refresh());

  const q = query.trim().toLowerCase();
  const visible = (rows ?? [])
    .filter((row) => !q || [row.name, row.path ?? "", ...row.teams].some((value) => value.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, language));
  const groups: Array<{ key: ProjectRow["state"]; title: string }> = [
    { key: "teams", title: labels.groupTeams },
    { key: "ready", title: labels.groupReady },
    { key: "blocked", title: labels.groupBlocked },
  ];

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 text-base font-semibold text-foreground">{labels.panelTitle}</h1>
        <input
          type="search"
          autoFocus
          aria-label={labels.searchPlaceholder}
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 min-w-0 grow rounded-md border border-input bg-background px-3 text-sm text-foreground sm:max-w-md"
        />
        <Button onClick={() => void refresh()}>{labels.refresh}</Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {rows === null && !error && <Notice>{labels.loading}</Notice>}
      {rows !== null && visible.length === 0 && <Notice>{labels.nothingFound}</Notice>}
      {groups.map((group) => {
        const items = visible.filter((row) => row.state === group.key);
        if (items.length === 0) return null;
        return (
          <section key={group.key} aria-label={group.title} className="flex flex-col gap-1">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title} · {items.length}
            </h2>
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {items.map((row) => {
                const blocked = row.state === "blocked";
                return (
                  <button
                    key={row.id}
                    type="button"
                    disabled={blocked}
                    onClick={() => onOpen(row.id)}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        {row.name}
                        {row.id === currentProjectId && <Tag>{labels.current}</Tag>}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {blocked ? row.reason : row.path}
                      </span>
                    </span>
                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      {row.state === "teams" && (
                        <>
                          {row.teams.map((team) => (
                            <span key={team} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                              <span className="inline-flex items-center gap-1"><TeamIcon /> {team}</span>
                            </span>
                          ))}
                          <span className="text-xs text-muted-foreground">
                            {labels.projectStats(row.threads, row.running, row.errors)}
                          </span>
                        </>
                      )}
                      {row.state === "ready" && <span className="text-xs text-primary">{labels.createHere} →</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ──────────────────────── Panel ──────────────────────── */

function ProjectTracker({projectId, language, onChanged}: {projectId:string;language:Language;onChanged:()=>Promise<void>}) {
  const rpc = useRpc<typeof rpcContract>();
  const [config,setConfig] = useState<{kind:"beads"|"builtin";override:"beads"|"builtin"|null}|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  useEffect(()=> {
    let active=true;
    setConfig(null);setError(null);
    void rpc.call("trackerConfig",{projectId}).then(value=>{if(active)setConfig(value);}).catch(cause=>{if(active)setError(errorText(cause));});
    return ()=>{active=false;};
  },[rpc,projectId]);
  useRealtime("team-changed", (payload) => {
    const changed = (payload as {projectId?:string} | null)?.projectId;
    if (!changed || changed === projectId) {
      void rpc.call("trackerConfig", {projectId}).then(setConfig).catch(cause=>setError(errorText(cause)));
    }
  });
  const ru=language==="ru";
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <label>{ru?"Трекер проекта":"Project tracker"} <select aria-label={ru?"Трекер проекта":"Project tracker"} disabled={busy||!config} value={config?.override ?? "default"} onChange={async event=>{
      const kind=event.target.value;setBusy(true);setError(null);
      try {await rpc.call("trackerSet",{projectId,kind:kind==="default"?null:kind as "beads"|"builtin"});setConfig(await rpc.call("trackerConfig",{projectId}));await onChanged();}
      catch(cause){setError(errorText(cause));}finally{setBusy(false);}
    }}>
      <option value="default">{ru?"Настройка плагина":"Plugin default"}{config?` (${config.kind})`:""}</option>
      <option value="beads">Beads</option><option value="builtin">{ru?"Встроенный":"Built-in"}</option>
    </select></label>
    <span>{ru?"Для всех команд проекта":"Applies to every team in the project"}</span>
    {error&&<span role="alert">{error}</span>}
  </div>;
}

function TeamPanel({ subPath }: { subPath: string }) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const parts = subPath ? subPath.split("/").map((part) => decodeURIComponent(part)) : [];
  const projectId = parts[0] || null;
  const [projectName, setProjectName] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<TeamSnapshot[] | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const labels = LABELS[language];
  const trackerIssue = snapshots?.find((snapshot) => snapshot.trackerError !== null && snapshot.trackerError !== undefined);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await rpc.call("tree", { projectId });
      setSnapshots(result.snapshots);
      setLanguage(result.language);
      setProjectName(result.projectName);
    } catch (cause) {
      setFlash(errorText(cause));
      setSnapshots(null);
    } finally {
      setLoading(false);
    }
  }, [rpc, projectId]);

  useEffect(() => {
    setSnapshots(null);
    setSelection(null);
    void refresh();
  }, [refresh]);

  useRealtime("team-changed", (payload) => {
    const changed = (payload as { projectId?: string } | null)?.projectId;
    if (!changed || changed === projectId) void refresh();
  });

  const onAction = async (action: () => Promise<string>) => {
    try {
      setFlash(await action());
    } catch (cause) {
      setFlash(`${labels.failed}: ${errorText(cause)}`);
    }
    await refresh();
  };

  const teams = snapshots?.map((snapshot) => snapshot.team) ?? [];
  const selectedSnapshot = selection ? snapshots?.find((snapshot) => snapshot.team === selection.team) : undefined;
  const selectedRole = selection ? selectedSnapshot?.roles.find((role) => role.name === selection.role) : undefined;

  if (!projectId) {
    return (
      <ProjectOverview
        currentProjectId={context.projectId}
        onOpen={(id) => navigate.toPluginPanel("team", { subPath: encodeURIComponent(id) })}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => navigate.toPluginPanel("team", { subPath: "" })}>
          {labels.allProjects}
        </Button>
        <h1 className="mr-1 text-base font-semibold text-foreground">{projectName ?? labels.panelTitle}</h1>
        <div className="ml-auto flex gap-1.5">
          {snapshots && snapshots.length > 0 && !creating && <Button onClick={() => setCreating(true)}>{labels.newTeam}</Button>}
          <Button onClick={() => void refresh()} disabled={loading || !projectId}>
            {loading ? labels.loading : labels.refresh}
          </Button>
        </div>
      </div>
      <ProjectTracker projectId={projectId} language={language} onChanged={refresh} />
      {trackerIssue?.trackerError && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <span role="alert" className="grow">
            <span className="text-amber-600">{labels.trackerAbsent}</span>
            <span className="block text-xs text-muted-foreground">{trackerIssue.trackerError.message}</span>
          </span>
          <Button
            disabled={preparing}
            onClick={async () => {
              setPreparing(true);
              try {
                await onAction(async () => {
                  const { status } = await rpc.call("trackerPrepare", { projectId, team: trackerIssue.team });
                  return status === "created" ? labels.databaseCreated : labels.databaseReady;
                });
              } finally {
                setPreparing(false);
              }
            }}
          >
            {preparing ? labels.loading : labels.createDatabase}
          </Button>
        </div>
      )}
      {flash && (
        <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          <span className="grow">{flash}</span>
          <button type="button" aria-label={labels.cancel} onClick={() => setFlash(null)}>
            ✕
          </button>
        </div>
      )}
      {projectId && loading && snapshots === null && <Notice>{labels.loading}</Notice>}
      {projectId && snapshots !== null && (snapshots.length === 0 || creating) && (
        <>
          {snapshots.length === 0 && <Notice>{labels.noTeams}</Notice>}
          <CreateTeam
            projectId={projectId}
            existingTeams={teams}
            onCreated={(created) => {
              setCreating(false);
              void onAction(async () => labels.teamCreated(created));
            }}
            onCancel={snapshots.length > 0 ? () => setCreating(false) : undefined}
          />
        </>
      )}
      {snapshots && snapshots.length > 0 && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div role="tree" aria-label={labels.panelTitle} className="flex min-w-0 grow flex-col gap-3">
            {snapshots.map((snapshot) => (
              <TeamBlock
                key={snapshot.team}
                snapshot={snapshot}
                language={language}
                labels={labels}
                expanded={!collapsed.has(snapshot.team)}
                onToggle={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(snapshot.team)) next.delete(snapshot.team);
                    else next.add(snapshot.team);
                    return next;
                  })
                }
                selection={selection}
                onSelect={setSelection}
                onAction={onAction}
                adding={adding === snapshot.team}
                onAdding={(value) => setAdding(value ? snapshot.team : null)}
              />
            ))}
            <div className="text-xs text-muted-foreground">{labels.tip}</div>
          </div>
          {selectedSnapshot && selectedRole && (
            <RoleDetails
              key={`${selectedSnapshot.team}/${selectedRole.name}`}
              snapshot={selectedSnapshot}
              role={selectedRole}
              language={language}
              labels={labels}
              onAction={onAction}
              onClose={() => setSelection(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────── Settings: template editor ──────────────────────── */

function useEditorSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<EditorSettings | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSettings(await rpc.call("editorSettings", null));
    } catch {
      setSettings(null);
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { settings, setSettings, refresh };
}

function TemplatesSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const { data, refresh: refreshTemplates } = useTemplates();
  const { settings, setSettings, refresh: refreshSettings } = useEditorSettings();
  const providers = useProviders();
  const language = settings?.language ?? data?.language ?? "en";
  const labels = LABELS[language];
  const settingLabels = stringsFor("defaultTemplate", language);
  const generatorMeta = GENERATOR_SELECTION_META.generatorSelection[language];
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TeamTemplate>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [policyDraftValid, setPolicyDraftValid] = useState(true);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newKinds, setNewKinds] = useState<string[]>(["lead", "developer", "junior", "tester"]);

  // Initialize a draft for the selected template only when we do not already have one.
  useEffect(() => {
    if (!data || !selected) return;
    const template = data.templates.find((tpl) => tpl.id === selected);
    if (!template) {
      setSelected(null);
      return;
    }
    setDrafts((current) => {
      if (current[selected]) return current;
      return { ...current, [selected]: structuredClone(template) };
    });
  }, [data, selected]);

  // If the selected template disappears from the catalog, deselect it.
  useEffect(() => {
    if (!data || !selected) return;
    if (!data.templates.some((tpl) => tpl.id === selected)) setSelected(null);
  }, [data, selected]);

  const draft = selected ? drafts[selected] ?? null : null;
  const readOnly = Boolean(draft?.builtin);

  const updateDraft = (patch: Partial<TeamTemplate> | ((prev: TeamTemplate) => TeamTemplate)) => {
    if (!selected || !drafts[selected]) return;
    setDrafts((current) => ({
      ...current,
      [selected]: typeof patch === "function" ? patch(current[selected]!) : { ...current[selected]!, ...patch },
    }));
  };

  const act = async (action: () => Promise<string>) => {
    try {
      setFlash(await action());
    } catch (cause) {
      setFlash(`${labels.failed}: ${errorText(cause)}`);
    }
  };

  const saveDefaultTemplate = async (id: string) => {
    try {
      const next = await rpc.call("editorSettingsSet", { defaultTemplate: id });
      setSettings(next);
      await refreshTemplates();
      setFlash(labels.defaultSaved);
    } catch (cause) {
      setFlash(`${labels.failed}: ${errorText(cause)}`);
    }
  };

  const saveGeneratorSelection = async (next: ExecutionModel | undefined) => {
    try {
      const generatorSelection: GeneratorSelection | null = next
        ? {
            providerId: next.providerId ?? "",
            model: next.model ?? "",
            ...(next.reasoningLevel ? { reasoningLevel: next.reasoningLevel as GeneratorSelection["reasoningLevel"] } : {}),
            ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}),
          }
        : null;
      const result = await rpc.call("editorSettingsSet", { generatorSelection });
      setSettings(result);
      setFlash(labels.generatorSaved);
    } catch (cause) {
      setFlash(`${labels.failed}: ${errorText(cause)}`);
    }
  };

  const onSaveTemplate = async () => {
    if (!draft) return;
    if (!policyDraftValid || draft.roles.some(role => role.executionPolicy && findDuplicateFallback(role.executionPolicy.fallbacks))) {
      setFlash(labels.policyDraftIncomplete); return;
    }
    const { builtin: _builtin, ...body } = draft;
    void _builtin;
    await act(async () => {
      await rpc.call("templateSave", { template: cleanTemplate(body) });
      return labels.saved(draft.id);
    });
    await refreshTemplates();
  };

  const onDeleteTemplate = async () => {
    if (!draft || draft.builtin) return;
    await act(async () => {
      await rpc.call("templateDelete", { id: draft.id });
      setSelected(null);
      return labels.deleted(draft.id);
    });
    await refreshTemplates();
    await refreshSettings();
  };

  const onDuplicateTemplate = async () => {
    if (!draft) return;
    if (!policyDraftValid || draft.roles.some(role => role.executionPolicy && findDuplicateFallback(role.executionPolicy.fallbacks))) { setFlash(labels.policyDraftIncomplete); return; }
    const { builtin: _builtin, ...body } = draft;
    void _builtin;
    await act(async () => {
      let id = `${draft.id}-copy`;
      for (let n = 2; data?.templates.some((tpl) => tpl.id === id); n += 1) id = `${draft.id}-copy-${n}`;
      await rpc.call("templateSave", { template: cleanTemplate({ ...body, id }) });
      setSelected(id);
      return labels.saved(id);
    });
    await refreshTemplates();
  };

  if (!data) return <Notice>{labels.loading}</Notice>;

  const defaultTemplateId = settings?.defaultTemplate ?? data.defaultTemplate;
  const generatorValue: ExecutionModel | undefined = settings?.generatorSelection
    ? {
        providerId: settings.generatorSelection.providerId,
        model: settings.generatorSelection.model,
        reasoningLevel: settings.generatorSelection.reasoningLevel,
        serviceTier: settings.generatorSelection.serviceTier,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">{labels.settingsTitle}</h2>
      <div className="text-xs text-muted-foreground">{labels.templatesHint}</div>
      {flash && <Notice>{flash}</Notice>}

      {/* Default template picker */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {settingLabels.label}
          <select
            value={defaultTemplateId}
            onChange={(event) => void saveDefaultTemplate(event.target.value)}
            className={inputClass}
          >
            {data.templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.title}
              </option>
            ))}
          </select>
        </label>
        {settings && !settings.defaultTemplateExists && (
          <Notice tone="warn">{labels.defaultTemplateMissing(settings.defaultTemplate)}</Notice>
        )}
        {settings?.reloadHint && <Notice tone="warn">{settings.reloadHint}</Notice>}
        {settingLabels.description && (
          <div className="text-xs text-muted-foreground">{settingLabels.description}</div>
        )}
      </div>

      {/* Template tabs */}
      <div className="flex flex-wrap gap-1">
        {data.templates.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            onClick={() => setSelected(tpl.id)}
            className={`h-7 rounded-md px-2.5 text-xs ${
              tpl.id === selected ? "bg-primary text-primary-foreground" : "border border-border text-foreground hover:bg-accent"
            }`}
          >
            {tpl.title}
            {tpl.builtin ? ` · ${labels.builtin}` : ""}
          </button>
        ))}
      </div>

      {/* Selected template editor (same form for builtin and user) */}
      {draft && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {labels.templateId}
              <input value={draft.id} disabled className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {labels.title}
              <input
                aria-label={labels.title}
                value={draft.title}
                disabled={readOnly}
                onChange={(event) => updateDraft({ title: event.target.value })}
                className={`${inputClass} w-56`}
              />
            </label>
            <label className="flex grow flex-col gap-1 text-xs text-muted-foreground">
              {labels.description}
              <input
                value={draft.description ?? ""}
                disabled={readOnly}
                onChange={(event) => updateDraft({ description: event.target.value || undefined })}
                className={inputClass}
              />
            </label>
          </div>
          <RolesEditor
            key={selected}
            onPolicyDraftValidityChange={setPolicyDraftValid}
            roles={draft.roles}
            onChange={(roles) => updateDraft({ roles })}
            labels={labels}
            kinds={data.kinds}
            providers={providers}
            withPrompt
            readOnly={readOnly}
          />
          <div className="flex gap-1.5">
            {readOnly ? (
              <Button onClick={() => void onDuplicateTemplate()}>{labels.duplicate}</Button>
            ) : (
              <>
                <Button variant="primary" disabled={!policyDraftValid || Boolean(draft.roles.some(role => role.executionPolicy && findDuplicateFallback(role.executionPolicy.fallbacks)))} onClick={() => void onSaveTemplate()}>
                  {labels.save}
                </Button>
                <Button variant="ghost" onClick={() => void onDeleteTemplate()}>
                  {labels.delete}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Prompt-draft generator connection point */}
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
        <strong className="text-xs text-foreground">{generatorMeta.label}</strong>
        {generatorMeta.description && (
          <div className="text-xs text-muted-foreground">{generatorMeta.description}</div>
        )}
        <ExecutionModelPicker
          value={generatorValue}
          onChange={(next) => void saveGeneratorSelection(next)}
          language={labels === LABELS.ru ? "ru" : "en"}
                    defaultLabel={labels.defaultProvider}
          selectLabel={labels.selectModel}
          useDefaultLabel={labels.useDefault}
        />
      </div>

      {/* Create new template */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!NAME_RE.test(newId) || newKinds.length === 0) return;
          void act(async () => {
            await rpc.call("templateNew", { id: newId, title: newTitle || newId, kinds: newKinds });
            setSelected(newId);
            setNewId("");
            setNewTitle("");
            return labels.saved(newId);
          }).then(() => refreshTemplates());
        }}
        className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3"
      >
        <strong className="text-xs text-foreground">{labels.newTemplate}</strong>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={labels.templateId}
            placeholder={labels.templateId}
            value={newId}
            onChange={(event) => setNewId(event.target.value.toLowerCase())}
            className={inputClass}
          />
          <input
            aria-label={labels.title}
            placeholder={labels.title}
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            className={`${inputClass} w-56`}
          />
        </div>
        <div className="text-xs text-muted-foreground">{labels.kinds}</div>
        <div className="flex flex-wrap gap-2">
          {data.kinds.map((k) => (
            <label key={k.kind} className="flex items-center gap-1 text-xs text-foreground">
              <input
                type="checkbox"
                checked={newKinds.includes(k.kind)}
                onChange={(event) =>
                  setNewKinds(event.target.checked ? [...newKinds, k.kind] : newKinds.filter((kind) => kind !== k.kind))
                }
              />
              {k.title}
            </label>
          ))}
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={!NAME_RE.test(newId) || newKinds.length === 0}>
            {labels.createTemplate}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "team",
    title: "Team",
    icon: "team/team",
    path: "team",
    component: TeamPanel,
  });
  app.slots.settingsSection({
    id: "templates",
    component: TemplatesSettings,
  });
});
