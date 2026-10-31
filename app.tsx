// bb-plugin-team — the Team panel: a live dashboard of a project's agent team.
//
// Hierarchy graph (lead → executors, colored by thread status), role cards
// with the current work package, quick "message" / "package" actions, the
// open packages with status controls, and a pause switch. Data comes from the
// plugin RPC (server.ts rpcContract); "team-changed" realtime signals refresh it.
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
import { reportLabels } from "./report";
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

/* ──────────────────────── Labels ──────────────────────── */

const PANEL_LABELS = {
  en: {
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
  },
  ru: {
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
    sent: (n: number) => `Отправлено тредов: ${n}.`,
    added: (id: number) => `Пакет #${id} добавлен.`,
    failed: "Ошибка",
    tip: "Подсказка: bb team report рисует эту картину в чате; bb team doctor проверяет настройку.",
  },
} as const;

type PanelLabels = (typeof PANEL_LABELS)[Language];

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

/* ──────────────────────── Data ──────────────────────── */

function useTeam(projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const result = await rpc.call("snapshot", { projectId });
      setSnapshot(result.snapshot);
      setLanguage(result.language);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("team-changed", (payload) => {
    const changed = (payload as { projectId?: string } | null)?.projectId;
    if (!changed || changed === projectId) void refresh();
  });

  return { rpc, snapshot, language, error, loading, refresh };
}

function useProjects() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("projects")
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  return projects;
}

/* ──────────────────────── Pieces ──────────────────────── */

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
  const cut = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
        <g
          key={node.key}
          onClick={() => node.threadId && onOpen(node.threadId)}
          style={{ cursor: node.threadId ? "pointer" : "default" }}
        >
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
            {cut(node.task ?? `${node.role} · ${node.status ?? l.missing}`, 26)}
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
  labels: PanelLabels;
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
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={labels.title}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              />
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={labels.note}
                rows={2}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
              />
              {hasThread && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={sendNow}
                    onChange={(event) => setSendNow(event.target.checked)}
                  />
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

/* ──────────────────────── Panel ──────────────────────── */

function TeamPanel({ subPath }: { subPath: string }) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const projects = useProjects();
  const fromPath = subPath ? decodeURIComponent(subPath.split("/")[0]!) : "";
  const projectId = fromPath || context.projectId || null;
  const { rpc, snapshot, language, error, loading, refresh } = useTeam(projectId);
  const labels = PANEL_LABELS[language];
  const l = reportLabels(language);
  const [flash, setFlash] = useState<string | null>(null);
  const nowMs = snapshot?.generatedAtMs ?? 0;

  const run = async (action: () => Promise<string>) => {
    try {
      setFlash(await action());
    } catch (cause) {
      setFlash(`${labels.failed}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    void refresh();
  };

  const onTell = (role: string, text: string) =>
    run(async () => {
      const result = await rpc.call("tell", { projectId: projectId!, role, text });
      return labels.sent(result.sent);
    });
  const onPackage = (role: string, title: string, note: string, send: boolean) =>
    run(async () => {
      const result = await rpc.call("taskAdd", {
        projectId: projectId!,
        role,
        title,
        ...(note ? { note } : {}),
        send,
      });
      return labels.added(result.task.id);
    });
  const onStatus = (id: number, status: TaskStatus) =>
    run(async () => {
      const result = await rpc.call("taskUpdate", { projectId: projectId!, id, status });
      return `#${result.task.id}: ${l.taskStatus[result.task.status] ?? result.task.status}`;
    });
  const onPause = (paused: boolean) =>
    run(async () => {
      const result = await rpc.call("pause", { projectId: projectId!, paused });
      return result.paused ? l.paused : `${labels.resume}: ${result.count}`;
    });

  const tasks = snapshot
    ? snapshot.roles.flatMap((role) => role.tasks).sort((a, b) => a.id - b.id)
    : [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-base font-semibold text-foreground">
          {snapshot ? l.title(snapshot.projectName) : labels.panelTitle}
        </h1>
        <select
          aria-label={labels.project}
          value={projectId ?? ""}
          onChange={(event) =>
            navigate.toPluginPanel("team", { subPath: encodeURIComponent(event.target.value) })
          }
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
        >
          {!projectId && <option value="">{labels.pickProject}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-1.5">
          {snapshot && (
            <Button onClick={() => onPause(!snapshot.paused)}>
              {snapshot.paused ? labels.resume : labels.pause}
            </Button>
          )}
          <Button onClick={() => void refresh()} disabled={loading || !projectId}>
            {loading ? labels.loading : labels.refresh}
          </Button>
        </div>
      </div>

      {!projectId && <Notice>{labels.noProject}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {flash && <Notice>{flash}</Notice>}

      {snapshot && (
        <>
          <div className="text-xs text-muted-foreground">
            {(() => {
              const running = snapshot.roles
                .flatMap((role) => role.threads)
                .filter((thread) => statusTone(thread.status) === "running").length;
              const errors = snapshot.roles
                .flatMap((role) => role.threads)
                .filter((thread) => statusTone(thread.status) === "error").length;
              return l.summary(
                snapshot.roles.filter((role) => role.enabled).length,
                running,
                errors,
                tasks.length,
              );
            })()}
          </div>
          {snapshot.paused && <Notice tone="warn">{l.paused}</Notice>}
          {!snapshot.configSource && <Notice>{l.noConfig}</Notice>}
          {snapshot.configError && <Notice tone="error">{l.configError(snapshot.configError)}</Notice>}

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {l.hierarchy}
            </h2>
            <Hierarchy snapshot={snapshot} language={language} onOpen={(id) => navigate.toThread(id)} />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {l.roles}
            </h2>
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
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {l.tasks}
            </h2>
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
          </section>
          <div className="text-xs text-muted-foreground">{labels.tip}</div>
        </>
      )}
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
});
