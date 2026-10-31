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
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { reportLabels, teamLabel } from "./report";
import {
  TASK_STATUSES,
  currentTask,
  layoutHierarchy,
  relativeAgo,
  statusTone,
  type Language,
  type SnapshotRole,
  type StatusTone,
  type TaskStatus,
  type TeamSnapshot,
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

const TONE_FILL: Record<StatusTone, string> = {
  running: "var(--brand, var(--primary))",
  idle: "var(--success, #22c55e)",
  error: "var(--destructive)",
  missing: "var(--muted-foreground)",
  other: "var(--warning, #f59e0b)",
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

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <div className="ml-auto flex gap-1.5">{actions}</div>
      </div>
      {children}
    </section>
  );
}

/* ──────────────────────── Data hooks ──────────────────────── */

function useProjects() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("projects")
      .then((result) => !cancelled && setProjects(result.projects))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  return projects;
}

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

/* ──────────────────────── Hierarchy graph ──────────────────────── */

function Hierarchy({
  snapshot,
  language,
  onOpen,
}: {
  snapshot: TeamSnapshot;
  language: Language;
  onOpen: (threadId: string) => void;
}) {
  const l = reportLabels(language);
  const layout = useMemo(() => layoutHierarchy(snapshot), [snapshot]);
  if (layout.nodes.length === 0) return <Notice>{l.noThreads}</Notice>;
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      style={{ maxWidth: layout.width, height: "auto", display: "block" }}
      role="img"
      aria-label={l.hierarchy}
    >
      {layout.edges.map((edge) => {
        const from = byKey.get(edge.from)!;
        const to = byKey.get(edge.to)!;
        const x1 = from.x + layout.nodeWidth / 2;
        const y1 = from.y + layout.nodeHeight;
        const x2 = to.x + layout.nodeWidth / 2;
        const y2 = to.y;
        const midY = (y1 + y2) / 2;
        return (
          <path
            key={`${edge.from}->${edge.to}`}
            d={`M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`}
            fill="none"
            stroke="var(--border)"
            strokeWidth={1.5}
            strokeDasharray={edge.linked ? undefined : "4 3"}
          />
        );
      })}
      {layout.nodes.map((node) => (
        <g key={node.key} onClick={() => node.threadId && onOpen(node.threadId)} style={{ cursor: node.threadId ? "pointer" : "default" }}>
          <title>{`${node.title} — ${node.role} — ${node.status ?? l.missing}${node.task ? ` — ${node.task}` : ""}`}</title>
          <rect
            x={node.x}
            y={node.y}
            width={layout.nodeWidth}
            height={layout.nodeHeight}
            rx={8}
            fill="var(--card)"
            stroke={node.lead ? "var(--brand, var(--primary))" : "var(--border)"}
            strokeDasharray={node.tone === "missing" ? "4 3" : undefined}
          />
          <circle cx={node.x + 14} cy={node.y + 18} r={5} fill={TONE_FILL[node.tone]} />
          <text x={node.x + 26} y={node.y + 22} fontSize={12} fontWeight={600} fill="var(--foreground)">
            {cut(node.title, 20)}
          </text>
          <text x={node.x + 12} y={node.y + 40} fontSize={11} fill="var(--muted-foreground)">
            {cut((node.task ?? `${node.role} · ${node.status ?? l.missing}`) + (node.helpers > 0 ? ` ${l.helpers(node.helpers)}` : ""), 26)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ──────────────────────── Role card ──────────────────────── */

function RoleCard({
  role,
  language,
  labels,
  nowMs,
  onOpen,
  onTell,
  onPackage,
}: {
  role: SnapshotRole;
  language: Language;
  labels: Labels;
  nowMs: number;
  onOpen: (threadId: string) => void;
  onTell: (role: string, text: string) => Promise<void>;
  onPackage: (role: string, title: string, note: string, send: boolean) => Promise<void>;
}) {
  const l = reportLabels(language);
  const [mode, setMode] = useState<"none" | "message" | "package">("none");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const task = currentTask(role.tasks);
  const hasThread = role.threads.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (mode === "message") await onTell(role.name, text.trim());
      else await onPackage(role.name, text.trim(), note.trim(), sendNow && hasThread);
      setText("");
      setNote("");
      setMode("none");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5">
        <strong className="truncate text-sm text-foreground">{role.title}</strong>
        {role.lead && <Tag strong>{l.lead}</Tag>}
        {!role.inConfig && <Tag>{l.notInConfig}</Tag>}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {role.name} · {role.threads[0]?.provider ?? role.provider ?? "—"}
        {role.model ? ` · ${role.model}` : ""}
      </div>
      {hasThread ? (
        role.threads.map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            onClick={() => onOpen(thread.threadId)}
            className="flex items-center gap-1.5 text-left text-xs text-foreground hover:underline"
          >
            <Dot tone={statusTone(thread.status)} />
            <span>{thread.status}</span>
            <span className="text-muted-foreground">· {l.ago(relativeAgo(thread.updatedAtMs, nowMs))}</span>
          </button>
        ))
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Dot tone="missing" />
          {l.missing}
        </div>
      )}
      {role.helpers.length > 0 && (
        <div className="flex flex-col gap-0.5 border-l border-border pl-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{labels.helpers}</span>
          {role.helpers.map((helper) => (
            <button
              key={helper.threadId}
              type="button"
              onClick={() => onOpen(helper.threadId)}
              className="flex items-center gap-1.5 truncate text-left text-xs text-foreground hover:underline"
            >
              <Dot tone={statusTone(helper.status)} />
              <span className="truncate">{helper.title || helper.threadId}</span>
            </button>
          ))}
        </div>
      )}
      <div className="text-xs text-foreground">
        {task ? (
          <span className="flex items-center gap-1.5">
            <Tag>{l.taskStatus[task.status] ?? task.status}</Tag>#{task.id} {task.title}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
      {mode === "none" ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {hasThread && (
            <Button variant="ghost" onClick={() => onOpen(role.threads[0]!.threadId)}>
              {labels.open}
            </Button>
          )}
          {hasThread && <Button onClick={() => setMode("message")}>{labels.message}</Button>}
          <Button onClick={() => setMode("package")}>{labels.package}</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-1.5 pt-1">
          {mode === "message" ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={labels.messagePlaceholder}
              rows={3}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            />
          ) : (
            <>
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder={labels.title} className={inputClass} />
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={labels.note}
                rows={2}
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
            <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
              {mode === "message" ? labels.send : labels.add}
            </Button>
            <Button variant="ghost" onClick={() => setMode("none")}>
              {labels.cancel}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ──────────────────────── Team view ──────────────────────── */

function TeamView({
  projectId,
  team,
  onFlash,
}: {
  projectId: string;
  team: string;
  onFlash: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const labels = LABELS[language];
  const l = reportLabels(language);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("snapshot", { projectId, team });
      setSnapshot(result.snapshot);
      setLanguage(result.language);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, projectId, team]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("team-changed", (payload) => {
    const changed = (payload as { projectId?: string } | null)?.projectId;
    if (!changed || changed === projectId) void refresh();
  });

  const run = async (action: () => Promise<string>) => {
    try {
      onFlash(await action());
    } catch (cause) {
      onFlash(`${labels.failed}: ${errorText(cause)}`);
    }
    void refresh();
  };

  const onTell = (role: string, text: string) =>
    run(async () => labels.sent((await rpc.call("tell", { projectId, team, role, text })).sent));
  const onPackage = (role: string, title: string, note: string, send: boolean) =>
    run(async () => {
      const result = await rpc.call("taskAdd", { projectId, team, role, title, ...(note ? { note } : {}), send });
      return labels.added(result.task.id);
    });
  const onStatus = (id: number, status: TaskStatus) =>
    run(async () => {
      const result = await rpc.call("taskUpdate", { projectId, team, id, status });
      return `#${result.task.id}: ${l.taskStatus[result.task.status] ?? result.task.status}`;
    });
  const onPause = (paused: boolean) =>
    run(async () => {
      const result = await rpc.call("pause", { projectId, team, paused });
      return result.paused ? l.paused : `${labels.resume}: ${result.count}`;
    });
  const onVersioned = (versioned: boolean) =>
    run(async () => {
      const result = await rpc.call("setVersioned", { projectId, team, versioned });
      return result.blocked ? labels.versionBlocked : result.versioned ? labels.versionedOn : labels.versionedOff;
    });
  const onSaveTemplate = (id: string) =>
    run(async () => {
      await rpc.call("templateFromTeam", { projectId, team, id, title: snapshot?.teamTitle ?? id });
      setTemplateId(null);
      return labels.saved(id);
    });

  if (error && !snapshot) return <Notice tone="error">{error}</Notice>;
  if (!snapshot) return <Notice>{labels.loading}</Notice>;
  const tasks = snapshot.roles.flatMap((role) => role.tasks).sort((a, b) => a.id - b.id);
  const threads = snapshot.roles.flatMap((role) => role.threads);
  const nowMs = snapshot.generatedAtMs;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-base font-semibold text-foreground">
          {l.title(teamLabel(snapshot))}
          {snapshot.teamTitle ? <span className="ml-2 text-sm font-normal text-muted-foreground">{snapshot.teamTitle}</span> : null}
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {snapshot.configSource && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground" title={snapshot.versioningBlocked ? labels.versionBlocked : undefined}>
              <input
                type="checkbox"
                aria-label={labels.versioned}
                checked={snapshot.versioned === true}
                disabled={snapshot.versioningBlocked}
                onChange={(event) => void onVersioned(event.target.checked)}
              />
              {labels.versioned}
            </label>
          )}
          {snapshot.configSource && <Button onClick={() => setTemplateId(snapshot.team)}>{labels.saveTemplate}</Button>}
          <Button onClick={() => void onPause(!snapshot.paused)}>{snapshot.paused ? labels.resume : labels.pause}</Button>
          <Button onClick={() => void refresh()} disabled={loading}>
            {loading ? labels.loading : labels.refresh}
          </Button>
        </div>
      </div>
      {templateId !== null && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (NAME_RE.test(templateId)) void onSaveTemplate(templateId);
          }}
          className="flex items-end gap-2"
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
      <div className="text-xs text-muted-foreground">
        {l.summary(
          snapshot.roles.filter((role) => role.enabled).length,
          threads.filter((thread) => statusTone(thread.status) === "running").length,
          threads.filter((thread) => statusTone(thread.status) === "error").length,
          tasks.length,
        )}
      </div>
      {snapshot.paused && <Notice tone="warn">{l.paused}</Notice>}
      {!snapshot.configSource && <Notice>{l.noConfig}</Notice>}
      {snapshot.configError && <Notice tone="error">{l.configError(snapshot.configError)}</Notice>}

      <Section title={l.hierarchy}>
        <Hierarchy snapshot={snapshot} language={language} onOpen={(id) => navigate.toThread(id)} />
      </Section>

      <Section
        title={l.roles}
        actions={snapshot.configSource && !adding ? <Button onClick={() => setAdding(true)}>{labels.addExecutor}</Button> : null}
      >
        {adding && (
          <AddExecutor
            projectId={projectId}
            team={team}
            existingRoles={snapshot.roles.map((role) => role.name)}
            labels={labels}
            onDone={(message) => {
              setAdding(false);
              onFlash(message);
              void refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {snapshot.roles
            .filter((role) => role.enabled || role.threads.length > 0)
            .map((role) => (
              <RoleCard
                key={role.name}
                role={role}
                language={language}
                labels={labels}
                nowMs={nowMs}
                onOpen={(id) => navigate.toThread(id)}
                onTell={onTell}
                onPackage={onPackage}
              />
            ))}
        </div>
      </Section>

      <Section title={l.tasks}>
        {tasks.length === 0 ? (
          <div className="text-sm text-muted-foreground">{l.noTasks}</div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-border">
                  <td className="py-1.5 pr-2 text-muted-foreground">#{task.id}</td>
                  <td className="py-1.5 pr-2 text-foreground">{task.role}</td>
                  <td className="py-1.5 pr-2 text-foreground">{task.title}</td>
                  <td className="py-1.5 text-right">
                    <select
                      aria-label={`#${task.id}`}
                      value={task.status}
                      onChange={(event) => void onStatus(task.id, event.target.value as TaskStatus)}
                      className="h-6 rounded-md border border-input bg-background px-1 text-xs text-foreground"
                    >
                      {TASK_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {l.taskStatus[status] ?? status}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <div className="text-xs text-muted-foreground">{labels.tip}</div>
    </div>
  );
}

/* ──────────────────────── Panel ──────────────────────── */

function TeamPanel({ subPath }: { subPath: string }) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const projects = useProjects();
  const parts = subPath ? subPath.split("/").map((part) => decodeURIComponent(part)) : [];
  const projectId = parts[0] || context.projectId || null;
  const [teams, setTeams] = useState<string[] | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const labels = LABELS[language];
  const team = parts[1] && teams?.includes(parts[1]) ? parts[1] : teams?.[0] ?? null;

  const loadTeams = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await rpc.call("teams", { projectId });
      setTeams(result.teams);
      setLanguage(result.language);
    } catch (cause) {
      setFlash(errorText(cause));
      setTeams([]);
    }
  }, [rpc, projectId]);

  useEffect(() => {
    setTeams(null);
    void loadTeams();
  }, [loadTeams]);

  const go = (nextProject: string, nextTeam?: string) =>
    navigate.toPluginPanel("team", {
      subPath: [nextProject, nextTeam].filter(Boolean).map((part) => encodeURIComponent(part!)).join("/"),
    });

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={labels.project}
          value={projectId ?? ""}
          onChange={(event) => go(event.target.value)}
          className={inputClass}
        >
          {!projectId && <option value="">{labels.pickProject}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {teams && teams.length > 0 && (
          <div role="tablist" className="flex flex-wrap gap-1">
            {teams.map((name) => (
              <button
                key={name}
                role="tab"
                type="button"
                aria-selected={!creating && name === team}
                onClick={() => {
                  setCreating(false);
                  go(projectId!, name);
                }}
                className={`h-7 rounded-md px-2.5 text-xs font-medium ${
                  !creating && name === team ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                👥 {name}
              </button>
            ))}
            <Button variant="ghost" onClick={() => setCreating(true)}>
              {labels.newTeam}
            </Button>
          </div>
        )}
      </div>
      {!projectId && <Notice>{labels.noProject}</Notice>}
      {flash && <Notice>{flash}</Notice>}
      {projectId && teams === null && <Notice>{labels.loading}</Notice>}
      {projectId && teams !== null && (teams.length === 0 || creating) && (
        <>
          {teams.length === 0 && <Notice>{labels.noTeams}</Notice>}
          <CreateTeam
            projectId={projectId}
            existingTeams={teams}
            onCreated={(created) => {
              setCreating(false);
              setFlash(labels.teamCreated(created));
              void loadTeams().then(() => go(projectId, created));
            }}
            onCancel={teams.length > 0 ? () => setCreating(false) : undefined}
          />
        </>
      )}
      {projectId && team && !creating && <TeamView key={`${projectId}/${team}`} projectId={projectId} team={team} onFlash={setFlash} />}
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
    icon: "Users",
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
