// bb team report: render a TeamSnapshot as an inline-vis HTML page or Markdown.
// Pure module: no SDK calls.

import {
  currentTask,
  layoutHierarchy,
  relativeAgo,
  statusTone,
  type Language,
  type StatusTone,
  type TeamSnapshot,
} from "./snapshot";

interface ReportLabels {
  title: (project: string) => string;
  generated: (when: string) => string;
  noConfig: string;
  configError: (error: string) => string;
  paused: string;
  hierarchy: string;
  roles: string;
  tasks: string;
  noTasks: string;
  noThreads: string;
  role: string;
  thread: string;
  status: string;
  provider: string;
  activity: string;
  task: string;
  idleRoles: (names: string) => string;
  blocked: (names: string) => string;
  summary: (roles: number, running: number, errors: number, open: number) => string;
  missing: string;
  lead: string;
  notInConfig: string;
  ago: (age: string) => string;
  taskStatus: Record<string, string>;
  helpers: (count: number) => string;
}

const LABELS: Record<Language, ReportLabels> = {
  en: {
    title: (project) => `Team · ${project}`,
    generated: (when) => `generated ${when}`,
    noConfig: "No .bb/team.yaml in this project — bb team init",
    configError: (error) => `Config problem: ${error}`,
    paused: "Team paused — agent messages to executors are held (bb team resume)",
    hierarchy: "Hierarchy",
    roles: "Roles",
    tasks: "Open work packages",
    noTasks: "No open work packages (bb team task add <role> <title>)",
    noThreads: "No team threads yet — bb team create",
    role: "Role",
    thread: "Thread",
    status: "Status",
    provider: "Provider",
    activity: "Activity",
    task: "Current package",
    idleRoles: (names) => `Idle without a package: ${names}`,
    blocked: (names) => `Needs attention (error): ${names}`,
    summary: (roles, running, errors, open) =>
      `${roles} roles · ${running} working · ${errors} in error · ${open} open packages`,
    missing: "not created",
    lead: "lead",
    notInConfig: "not in config",
    ago: (age) => `${age} ago`,
    helpers: (count) => `+${count} helper${count === 1 ? "" : "s"}`,
    taskStatus: {
      todo: "todo",
      "in-progress": "in progress",
      review: "review",
      done: "done",
      dropped: "dropped",
    },
  },
  ru: {
    title: (project) => `Команда · ${project}`,
    generated: (when) => `сформировано ${when}`,
    noConfig: "В проекте нет .bb/team.yaml — bb team init",
    configError: (error) => `Проблема конфига: ${error}`,
    paused: "Команда на паузе — сообщения агентов исполнителям придерживаются (bb team resume)",
    hierarchy: "Иерархия",
    roles: "Роли",
    tasks: "Открытые пакеты работ",
    noTasks: "Открытых пакетов нет (bb team task add <роль> <название>)",
    noThreads: "Тредов команды ещё нет — bb team create",
    role: "Роль",
    thread: "Тред",
    status: "Статус",
    provider: "Провайдер",
    activity: "Активность",
    task: "Текущий пакет",
    idleRoles: (names) => `Простаивают без пакета: ${names}`,
    blocked: (names) => `Требуют внимания (ошибка): ${names}`,
    summary: (roles, running, errors, open) =>
      `ролей: ${roles} · в работе: ${running} · с ошибкой: ${errors} · открытых пакетов: ${open}`,
    missing: "не создан",
    lead: "руководитель",
    notInConfig: "нет в конфиге",
    ago: (age) => `${age} назад`,
    helpers: (count) => `+${count} помощн.`,
    taskStatus: {
      todo: "к выполнению",
      "in-progress": "в работе",
      review: "ревью",
      done: "принято",
      dropped: "снято",
    },
  },
};

export function reportLabels(lang: Language): ReportLabels {
  return LABELS[lang] ?? LABELS.en;
}

/** "demo" for the main team, "demo · qa" otherwise. */
export function teamLabel(snapshot: Pick<TeamSnapshot, "projectName" | "team">): string {
  return !snapshot.team || snapshot.team === "main"
    ? snapshot.projectName
    : `${snapshot.projectName} · ${snapshot.team}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const TONE_COLOR: Record<StatusTone, string> = {
  running: "var(--brand, var(--primary))",
  idle: "var(--success, var(--chart-2))",
  error: "var(--destructive)",
  missing: "var(--muted-foreground)",
  other: "var(--warning, var(--chart-4))",
};

interface Digest {
  roleCount: number;
  running: number;
  errors: string[];
  idleWithoutTask: string[];
  openTasks: number;
}

export function digest(snapshot: TeamSnapshot): Digest {
  let running = 0;
  const errors: string[] = [];
  const idleWithoutTask: string[] = [];
  let openTasks = 0;
  for (const role of snapshot.roles) {
    openTasks += role.tasks.length;
    for (const thread of role.threads) {
      const tone = statusTone(thread.status);
      if (tone === "running") running += 1;
      if (tone === "error") errors.push(role.name);
    }
    if (
      !role.lead &&
      role.threads.length > 0 &&
      role.threads.every((thread) => statusTone(thread.status) === "idle") &&
      !currentTask(role.tasks)
    ) {
      idleWithoutTask.push(role.name);
    }
  }
  return {
    roleCount: snapshot.roles.filter((role) => role.enabled).length,
    running,
    errors: [...new Set(errors)],
    idleWithoutTask,
    openTasks,
  };
}

function formatWhen(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function renderReportMarkdown(
  snapshot: TeamSnapshot,
  lang: Language,
  nowMs: number,
): string {
  const l = reportLabels(lang);
  const d = digest(snapshot);
  const out: string[] = [`## ${l.title(teamLabel(snapshot))}`, ""];
  out.push(`_${l.summary(d.roleCount, d.running, d.errors.length, d.openTasks)}_`);
  if (snapshot.paused) out.push("", `> ${l.paused}`);
  if (!snapshot.configSource) out.push("", `> ${l.noConfig}`);
  if (snapshot.configError) out.push("", `> ${l.configError(snapshot.configError)}`);
  if (d.errors.length > 0) out.push("", `- ${l.blocked(d.errors.join(", "))}`);
  if (d.idleWithoutTask.length > 0) out.push(`- ${l.idleRoles(d.idleWithoutTask.join(", "))}`);
  out.push("", `| ${l.role} | ${l.thread} | ${l.status} | ${l.provider} | ${l.activity} | ${l.task} |`);
  out.push("|---|---|---|---|---|---|");
  for (const role of snapshot.roles) {
    const label = `${role.title}${role.lead ? ` (${l.lead})` : ""}${role.inConfig ? "" : ` (${l.notInConfig})`}${role.helpers?.length ? ` ${l.helpers(role.helpers.length)}` : ""}`;
    const task = currentTask(role.tasks);
    const taskText = task ? `#${task.id} ${task.title} — ${l.taskStatus[task.status]}` : "—";
    if (role.threads.length === 0) {
      out.push(`| ${label} | — | ${l.missing} | ${role.provider ?? "—"} | — | ${taskText} |`);
      continue;
    }
    for (const thread of role.threads) {
      out.push(
        `| ${label} | @thread:${thread.threadId} | ${thread.status} | ${thread.provider} | ${l.ago(relativeAgo(thread.updatedAtMs, nowMs))} | ${taskText} |`,
      );
    }
  }
  const tasks = snapshot.roles.flatMap((role) => role.tasks);
  out.push("", `### ${l.tasks}`, "");
  if (tasks.length === 0) {
    out.push(l.noTasks);
  } else {
    for (const task of tasks.sort((a, b) => a.id - b.id)) {
      out.push(`- #${task.id} **${task.role}** — ${task.title} · ${l.taskStatus[task.status]}`);
    }
  }
  out.push("", `_${l.generated(formatWhen(snapshot.generatedAtMs))}_`);
  return out.join("\n");
}

function renderGraphSvg(snapshot: TeamSnapshot, lang: Language): string {
  const l = reportLabels(lang);
  const layout = layoutHierarchy(snapshot);
  if (layout.nodes.length === 0) return "";
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  const parts: string[] = [];
  for (const edge of layout.edges) {
    const from = byKey.get(edge.from)!;
    const to = byKey.get(edge.to)!;
    const x1 = from.x + layout.nodeWidth / 2;
    const y1 = from.y + layout.nodeHeight;
    const x2 = to.x + layout.nodeWidth / 2;
    const y2 = to.y;
    const midY = (y1 + y2) / 2;
    parts.push(
      `<path d="M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}" fill="none" stroke="var(--border)" stroke-width="1.5"${edge.linked ? "" : ' stroke-dasharray="4 3"'}/>`,
    );
  }
  for (const node of layout.nodes) {
    const color = TONE_COLOR[node.tone];
    const status = node.status ?? l.missing;
    const sub = (node.task ?? `${node.role} · ${status}`) + (node.helpers > 0 ? ` ${l.helpers(node.helpers)}` : "");
    parts.push(
      `<g><title>${escapeHtml(`${node.title} — ${node.role} — ${status}${node.task ? ` — ${node.task}` : ""}`)}</title>` +
        `<rect x="${node.x}" y="${node.y}" width="${layout.nodeWidth}" height="${layout.nodeHeight}" rx="8" fill="var(--card)" stroke="${node.lead ? "var(--brand, var(--primary))" : "var(--border)"}"${node.tone === "missing" ? ' stroke-dasharray="4 3"' : ""}/>` +
        `<circle cx="${node.x + 14}" cy="${node.y + 18}" r="5" fill="${color}"/>` +
        `<text x="${node.x + 26}" y="${node.y + 22}" font-size="12" font-weight="600" fill="var(--foreground)">${escapeHtml(truncate(node.title, 20))}</text>` +
        `<text x="${node.x + 12}" y="${node.y + 40}" font-size="11" fill="var(--muted-foreground)">${escapeHtml(truncate(sub, 26))}</text></g>`,
    );
  }
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="100%" style="max-width:${layout.width}px;height:auto;display:block" role="img" aria-label="${escapeHtml(l.hierarchy)}">${parts.join("")}</svg>`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function renderReportHtml(
  snapshot: TeamSnapshot,
  lang: Language,
  nowMs: number,
): string {
  const l = reportLabels(lang);
  const d = digest(snapshot);
  const notes: string[] = [];
  if (snapshot.paused) notes.push(`<div class="note warn">${escapeHtml(l.paused)}</div>`);
  if (!snapshot.configSource) notes.push(`<div class="note">${escapeHtml(l.noConfig)}</div>`);
  if (snapshot.configError) {
    notes.push(`<div class="note err">${escapeHtml(l.configError(snapshot.configError))}</div>`);
  }
  if (d.errors.length > 0) {
    notes.push(`<div class="note err">${escapeHtml(l.blocked(d.errors.join(", ")))}</div>`);
  }
  if (d.idleWithoutTask.length > 0) {
    notes.push(`<div class="note">${escapeHtml(l.idleRoles(d.idleWithoutTask.join(", ")))}</div>`);
  }

  const cards = snapshot.roles
    .map((role) => {
      const task = currentTask(role.tasks);
      const threads =
        role.threads.length === 0
          ? `<div class="row"><span class="dot" style="background:${TONE_COLOR.missing}"></span><span class="muted">${escapeHtml(l.missing)}</span></div>`
          : role.threads
              .map(
                (thread) =>
                  `<div class="row"><span class="dot" style="background:${TONE_COLOR[statusTone(thread.status)]}"></span><span>${escapeHtml(thread.status)}</span><span class="muted">· ${escapeHtml(l.ago(relativeAgo(thread.updatedAtMs, nowMs)))}</span><code>${escapeHtml(thread.threadId)}</code></div>`,
              )
              .join("");
      const tags = [
        role.lead ? `<span class="tag lead">${escapeHtml(l.lead)}</span>` : "",
        role.inConfig ? "" : `<span class="tag">${escapeHtml(l.notInConfig)}</span>`,
        role.helpers?.length ? `<span class="tag">${escapeHtml(l.helpers(role.helpers.length))}</span>` : "",
      ].join("");
      return (
        `<div class="card"><div class="head"><strong>${escapeHtml(role.title)}</strong>${tags}</div>` +
        `<div class="muted small">${escapeHtml(role.name)} · ${escapeHtml(role.threads[0]?.provider ?? role.provider ?? "—")}${role.model ? ` · ${escapeHtml(role.model)}` : ""}</div>` +
        threads +
        `<div class="task">${task ? `<span class="tag">${escapeHtml(l.taskStatus[task.status] ?? task.status)}</span> #${task.id} ${escapeHtml(task.title)}` : `<span class="muted">—</span>`}</div></div>`
      );
    })
    .join("");

  const tasks = snapshot.roles.flatMap((role) => role.tasks).sort((a, b) => a.id - b.id);
  const taskRows =
    tasks.length === 0
      ? `<div class="muted">${escapeHtml(l.noTasks)}</div>`
      : `<table><tbody>${tasks
          .map(
            (task) =>
              `<tr><td>#${task.id}</td><td>${escapeHtml(task.role)}</td><td>${escapeHtml(task.title)}</td><td><span class="tag">${escapeHtml(l.taskStatus[task.status] ?? task.status)}</span></td></tr>`,
          )
          .join("")}</tbody></table>`;

  const graph = renderGraphSvg(snapshot, lang);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:var(--font-sans);color:var(--foreground);margin:0}
.wrap{display:flex;flex-direction:column;gap:14px}
h2{font-size:16px;margin:0}
h3{font-size:13px;margin:0 0 6px;color:var(--muted-foreground);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted-foreground)}.small{font-size:12px}
.note{padding:8px 12px;border-radius:var(--radius);background:var(--muted);font-size:13px}
.note.warn{color:var(--warning-text,var(--foreground))}.note.err{color:var(--destructive-text,var(--destructive))}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.card{border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;background:var(--card);display:flex;flex-direction:column;gap:6px}
.head{display:flex;align-items:center;gap:6px}
.row{display:flex;align-items:center;gap:6px;font-size:12px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
code{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)}
.tag{font-size:10px;padding:1px 6px;border-radius:999px;background:var(--secondary);color:var(--secondary-foreground);text-transform:uppercase;letter-spacing:.03em}
.tag.lead{background:var(--brand,var(--primary));color:var(--primary-foreground)}
.task{font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px}td{padding:4px 6px;border-bottom:1px solid var(--border)}
</style></head><body><div class="wrap">
<div><h2>${escapeHtml(l.title(teamLabel(snapshot)))}</h2><div class="muted small">${escapeHtml(l.summary(d.roleCount, d.running, d.errors.length, d.openTasks))} · ${escapeHtml(l.generated(formatWhen(snapshot.generatedAtMs)))}</div></div>
${notes.join("\n")}
${graph ? `<div><h3>${escapeHtml(l.hierarchy)}</h3>${graph}</div>` : `<div class="muted">${escapeHtml(l.noThreads)}</div>`}
<div><h3>${escapeHtml(l.roles)}</h3><div class="grid">${cards}</div></div>
<div><h3>${escapeHtml(l.tasks)}</h3>${taskRows}</div>
</div></body></html>`;
}
