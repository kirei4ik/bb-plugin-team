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
import { reportLabels } from "./report";
import {
  TASK_STATUSES,
  currentTask,
  relativeAgo,
  statusTone,
  type Language,
  type SnapshotRole,
  type StatusTone,
  type TaskStatus,
  type TeamSnapshot,
  type TeamTask,
} from "./snapshot";
import type { TeamTemplate, TemplateRole } from "./templates";

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
  added: (id: number) => `Package #${id} added.`,
  failed: "Failed",
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
  return Object.fromEntries(Object.entries(role).filter(([, value]) => value !== undefined)) as TemplateRole;
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

/* ──────────────────────── Roles editor (wizard + template editor) ──────────────────────── */

function RolesEditor({
  roles,
  onChange,
  labels,
  kinds,
  providers,
  withPrompt,
}: {
  roles: TemplateRole[];
  onChange: (roles: TemplateRole[]) => void;
  labels: Labels;
  kinds: Array<{ kind: string; title: string }>;
  providers: { enabled: string[]; disabled: string[] };
  withPrompt?: boolean;
}) {
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
  const providerOptions = [...new Set([...providers.enabled, ...providers.disabled, ...roles.map((r) => r.provider ?? "")])]
    .filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 pr-1 font-medium">{labels.lead}</th>
            <th className="pb-1 pr-1 font-medium">{labels.roleName}</th>
            <th className="pb-1 pr-1 font-medium">{labels.title}</th>
            <th className="pb-1 pr-1 font-medium">{labels.kind}</th>
            <th className="pb-1 pr-1 font-medium">{labels.provider}</th>
            <th className="pb-1 pr-1 font-medium">{labels.model}</th>
            <th className="pb-1 pr-1 font-medium">{labels.enabled}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roles.map((role, index) => {
            const off = role.provider && !providers.enabled.includes(role.provider);
            return (
              <tr key={index} className="align-top">
                <td className="py-1 pr-1">
                  <input
                    type="radio"
                    aria-label={`${labels.lead} ${role.name}`}
                    checked={role.lead === true || (!roles.some((r) => r.lead) && index === 0)}
                    onChange={() => setLead(index)}
                  />
                </td>
                <td className="py-1 pr-1">
                  <input
                    aria-label={`${labels.roleName} ${index + 1}`}
                    value={role.name}
                    onChange={(event) => update(index, { name: event.target.value.toLowerCase() })}
                    className={`${inputClass} w-28 ${ROLE_RE.test(role.name) ? "" : "border-destructive"}`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <input
                    aria-label={`${labels.title} ${index + 1}`}
                    value={role.title ?? ""}
                    onChange={(event) => update(index, { title: event.target.value || undefined })}
                    className={`${inputClass} w-36`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <select
                    aria-label={`${labels.kind} ${index + 1}`}
                    value={role.kind ?? ""}
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
                <td className="py-1 pr-1">
                  <select
                    aria-label={`${labels.provider} ${index + 1}`}
                    value={role.provider ?? ""}
                    onChange={(event) => update(index, { provider: event.target.value || undefined })}
                    className={`${inputClass} ${off ? "border-destructive text-destructive" : ""}`}
                  >
                    <option value="">{labels.defaultProvider}</option>
                    {providerOptions.map((id) => (
                      <option key={id} value={id}>
                        {providers.enabled.includes(id) ? id : `${id} ✕`}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-1">
                  <input
                    aria-label={`${labels.model} ${index + 1}`}
                    value={role.model ?? ""}
                    onChange={(event) => update(index, { model: event.target.value || undefined })}
                    className={`${inputClass} w-28`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <input
                    type="checkbox"
                    aria-label={`${labels.enabled} ${role.name}`}
                    checked={role.enabled !== false}
                    onChange={(event) => update(index, { enabled: event.target.checked ? undefined : false })}
                  />
                </td>
                <td className="py-1">
                  <Button variant="ghost" onClick={() => onChange(roles.filter((_, i) => i !== index))}>
                    {labels.remove}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {withPrompt &&
        roles.map((role, index) => (
          <label key={`p${index}`} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {labels.prompt}: {role.name}
            <textarea
              value={role.prompt ?? ""}
              placeholder={labels.promptHint}
              rows={4}
              onChange={(event) => update(index, { prompt: event.target.value || undefined })}
              className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
        ))}
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
  const labels = LABELS[data?.language ?? "en"];
  const [templateId, setTemplateId] = useState("dev");
  const [team, setTeam] = useState(existingTeams.length === 0 ? "main" : "");
  const [title, setTitle] = useState("");
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [versioned, setVersioned] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const problems = [...(nameProblem ? [nameProblem] : []), ...rolesProblems(roles, providers, labels)];

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
      <RolesEditor roles={roles} onChange={setRoles} labels={labels} kinds={data.kinds} providers={providers} />
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
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [kind, setKind] = useState("junior");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
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
  const problems: string[] = [];
  if (!ROLE_RE.test(roleName) || existingRoles.includes(roleName)) problems.push(labels.nameInvalid);
  if (mode === "new" && provider && !providers.enabled.includes(provider)) problems.push(labels.providerOff(provider));
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
        ...(mode === "new" && provider ? { provider } : {}),
        ...(mode === "new" && model ? { model } : {}),
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
          <>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {labels.provider}
              <select aria-label={labels.provider} value={provider} onChange={(event) => setProvider(event.target.value)} className={inputClass}>
                <option value="">{labels.defaultProvider}</option>
                {[...providers.enabled, ...providers.disabled].map((id) => (
                  <option key={id} value={id}>
                    {providers.enabled.includes(id) ? id : `${id} ✕`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {labels.model}
              <input aria-label={labels.model} value={model} onChange={(event) => setModel(event.target.value)} className={`${inputClass} w-32`} />
            </label>
          </>
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
  const tasks = snapshot.roles.flatMap((role) => role.tasks).sort((a, b) => a.id - b.id);
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
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id} className="border-b border-border">
                        <td className="py-1 pr-2 text-muted-foreground">#{task.id}</td>
                        <td className="py-1 pr-2 text-foreground">{task.role}</td>
                        <td className="py-1 pr-2 text-foreground">{task.title}</td>
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
  return (
    <select
      aria-label={`#${task.id}`}
      value={task.status}
      onChange={(event) =>
        void onAction(async () => {
          const result = await rpc.call("taskUpdate", { projectId, team, id: task.id, status: event.target.value as TaskStatus });
          return `#${result.task.id}: ${l.taskStatus[result.task.status] ?? result.task.status}`;
        })
      }
      className="h-6 rounded-md border border-input bg-background px-1 text-xs text-foreground"
    >
      {TASK_STATUSES.map((status) => (
        <option key={status} value={status}>
          {l.taskStatus[status] ?? status}
        </option>
      ))}
    </select>
  );
}

/* ──────────────────────── Role details (actions) ──────────────────────── */

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
              <span className="truncate">{task.title}</span>
              <span className="ml-auto">
                <TaskStatusSelect projectId={projectId} team={team} task={task} language={language} onAction={onAction} />
              </span>
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
  const labels = LABELS[language];

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
      setSnapshots((current) => current ?? []);
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
      {flash && (
        <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          <span className="grow">{flash}</span>
          <button type="button" aria-label={labels.cancel} onClick={() => setFlash(null)}>
            ✕
          </button>
        </div>
      )}
      {projectId && snapshots === null && <Notice>{labels.loading}</Notice>}
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

function TemplatesSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const { data, refresh } = useTemplates();
  const providers = useProviders();
  const labels = LABELS[data?.language ?? "en"];
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamTemplate | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newKinds, setNewKinds] = useState<string[]>(["lead", "developer", "junior", "tester"]);

  useEffect(() => {
    const template = data?.templates.find((tpl) => tpl.id === selected) ?? null;
    setDraft(template ? structuredClone(template) : null);
  }, [data, selected]);

  const act = async (action: () => Promise<string>) => {
    try {
      setFlash(await action());
      await refresh();
    } catch (cause) {
      setFlash(`${labels.failed}: ${errorText(cause)}`);
    }
  };

  if (!data) return <Notice>{labels.loading}</Notice>;
  const readOnly = Boolean(draft?.builtin);
  const { builtin: _builtin, ...draftBody } = draft ?? ({} as TeamTemplate);
  void _builtin;

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-muted-foreground">{labels.templatesHint}</div>
      {flash && <Notice>{flash}</Notice>}
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
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                className={`${inputClass} w-56`}
              />
            </label>
            <label className="flex grow flex-col gap-1 text-xs text-muted-foreground">
              {labels.description}
              <input
                value={draft.description ?? ""}
                disabled={readOnly}
                onChange={(event) => setDraft({ ...draft, description: event.target.value || undefined })}
                className={inputClass}
              />
            </label>
          </div>
          {readOnly ? (
            <div className="text-xs text-foreground">{draft.roles.map((role) => role.title ?? role.name).join(" · ")}</div>
          ) : (
            <RolesEditor
              roles={draft.roles}
              onChange={(roles) => setDraft({ ...draft, roles })}
              labels={labels}
              kinds={data.kinds}
              providers={providers}
              withPrompt
            />
          )}
          <div className="flex gap-1.5">
            {readOnly ? (
              <Button
                onClick={() =>
                  void act(async () => {
                    let id = `${draft.id}-copy`;
                    for (let n = 2; data.templates.some((tpl) => tpl.id === id); n += 1) id = `${draft.id}-copy-${n}`;
                    await rpc.call("templateSave", { template: cleanTemplate({ ...draftBody, id }) });
                    setSelected(id);
                    return labels.saved(id);
                  })
                }
              >
                {labels.duplicate}
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  onClick={() =>
                    void act(async () => {
                      await rpc.call("templateSave", { template: cleanTemplate(draftBody) });
                      return labels.saved(draft.id);
                    })
                  }
                >
                  {labels.save}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void act(async () => {
                      await rpc.call("templateDelete", { id: draft.id });
                      setSelected(null);
                      return labels.deleted(draft.id);
                    })
                  }
                >
                  {labels.delete}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
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
          });
        }}
        className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3"
      >
        <strong className="text-xs text-foreground">{labels.newTemplate}</strong>
        <div className="flex flex-wrap gap-2">
          <input aria-label={labels.templateId} placeholder={labels.templateId} value={newId} onChange={(event) => setNewId(event.target.value.toLowerCase())} className={inputClass} />
          <input aria-label={labels.title} placeholder={labels.title} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} className={`${inputClass} w-56`} />
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
    title: "Team templates / Шаблоны команд",
    description: "Teams to create from: roles, providers, models, prompts",
    component: TemplatesSettings,
  });
});
