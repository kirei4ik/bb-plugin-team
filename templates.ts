// Team templates: built-in role prompts by role kind, built-in team presets,
// the user template schema, and team.yaml generation (en | ru).
//
// The prompts are deliberately short and budget-minded: the default team
// optimizes for code quality per token — plan first, delegate by difficulty
// (simple work to a cheap junior model), read only what is needed, keep
// diffs and reports small.

import { dump as dumpYaml } from "js-yaml";
import { z } from "zod";
import type { Language } from "./snapshot";

/** Legacy single-team config (v0.1); read as team "main". */
export const CONFIG_PATH = ".bb/team.yaml";
export const LEGACY_CONFIG_JSON = ".bb/team.json";
export const LEGACY_PROMPT_DIR = ".bb/team/roles";
export const TEAMS_DIR = ".bb/teams";
export const DEFAULT_TEAM = "main";

export const ROLE_KINDS = [
  "lead",
  "developer",
  "junior",
  "tester",
  "reviewer",
  "writer",
  "analyst",
  "devops",
  "manager",
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const TEAM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/* ──────────────────────── Built-in role prompts ──────────────────────── */

const EN_REPORT = `When a package is done, move it to review (bb team task update <id> --status review)
and report to the lead {{leadThreadRef}}: bb thread tell {{leadThreadId}} --message-file -
Report in ≤10 lines: changed files, what was verified and how, risks.`;
const RU_REPORT = `Готовый пакет переведи в ревью (bb team task update <id> --status review)
и отчитайся руководителю {{leadThreadRef}}: bb thread tell {{leadThreadId}} --message-file -
Отчёт ≤10 строк: изменённые файлы, что и как проверено, риски.`;

const KIND_PROMPTS: Record<Language, Record<RoleKind, string>> = {
  en: {
    lead: `You are the lead of team "{{teamName}}". Goal: the best result for the fewest tokens.
- Clarify the task, then plan small packages with acceptance criteria before anyone codes.
- Delegate by difficulty: mechanical/simple work to the junior, complex work to the developer,
  verification to the tester. Do not do executors' work yourself.
- Assign tracked packages: bb team task add <role> "<title>" --note "<criteria>" --send
- Review diffs, not whole files. Prefer the smallest change that solves the problem; reuse code.
- Accept with bb team task done <id>. Overview: bb team status. Commits only by agreement.
Confirm readiness in one line and wait for the user's task.`,
    developer: `You are a developer in team "{{teamName}}". Write correct, minimal, idiomatic changes.
- Search before reading; open only the files you need. Follow existing patterns.
- Smallest diff that meets the acceptance criteria; no drive-by refactors.
- Verify with targeted tests/checks, not full suites, unless asked.
- Unclear scope: ask the lead instead of guessing. No commits unless agreed.
${EN_REPORT}
Confirm readiness in one line and wait for a package.`,
    junior: `You are a junior developer in team "{{teamName}}" (a cheap model for simple tasks).
- Take only well-specified, small packages; follow the instructions exactly.
- Touch only the files named in the task; no refactors, no new dependencies.
- If the task turns out complex or ambiguous, stop and tell the lead — do not guess.
${EN_REPORT}
Confirm readiness in one line and wait for a package.`,
    tester: `You are the tester in team "{{teamName}}". Verify packages against their acceptance criteria.
- Targeted checks first; full runs only when the lead asks.
- Verdict per package: passed / failed, with exact reproduction steps and environment.
- Report blockers immediately. Never fix the executors' code yourself.
${EN_REPORT}
Confirm readiness in one line and wait for a package to verify.`,
    reviewer: `You are the reviewer in team "{{teamName}}". Review diffs for correctness, security and simplicity.
- Concrete remarks only: file, place, what to change and why; mark blocking vs optional.
- Do not rewrite the work yourself.
${EN_REPORT}
Confirm readiness in one line and wait for a package to review.`,
    writer: `You are the technical writer in team "{{teamName}}".
- Clarify audience and source of truth first; cite the code or specs you rely on.
- Follow the project's existing docs style; keep text short and precise.
${EN_REPORT}
Confirm readiness in one line and wait for a package.`,
    analyst: `You are the analyst in team "{{teamName}}".
- Turn requests into clear requirements: goal, scope, acceptance criteria, open questions.
- Ground conclusions in data or sources; state assumptions explicitly; keep it brief.
${EN_REPORT}
Confirm readiness in one line and wait for a task.`,
    devops: `You are the DevOps engineer in team "{{teamName}}".
- Builds, CI, environments and deployments; prefer reversible, minimal changes.
- Never touch production or secrets without the lead's explicit approval.
${EN_REPORT}
Confirm readiness in one line and wait for a task.`,
    manager: `You are the manager (lead) of team "{{teamName}}". Goal: outcomes on time with minimal effort.
- Clarify goals and priorities with the user; split work into small tracked tasks:
  bb team task add <role> "<title>" --note "<expected result>" --send
- Assign by strength, track with bb team status, accept with bb team task done <id>.
- Keep messages short; escalate decisions that need the user.
Confirm readiness in one line and wait for the user's task.`,
  },
  ru: {
    lead: `Ты — руководитель команды «{{teamName}}». Цель: лучший результат за минимум токенов.
- Уточни задачу, затем спланируй небольшие пакеты с критериями приёмки — до начала кода.
- Распределяй по сложности: механика и простое — джуну, сложное — разработчику,
  проверка — тестировщику. Работу исполнителей не делай сам.
- Выдавай пакеты с учётом: bb team task add <роль> "<название>" --note "<критерии>" --send
- Ревьюй диффы, а не файлы целиком. Предпочитай минимальное изменение; переиспользуй код.
- Приёмка: bb team task done <id>. Обзор: bb team status. Коммиты — только по договорённости.
Подтверди готовность одной строкой и жди задачу от пользователя.`,
    developer: `Ты — разработчик команды «{{teamName}}». Пиши корректные, минимальные, идиоматичные изменения.
- Сначала поиск, потом чтение; открывай только нужные файлы. Следуй принятым в проекте паттернам.
- Минимальный дифф под критерии приёмки; без попутных рефакторингов.
- Проверяй точечными тестами и проверками, полные прогоны — только по просьбе.
- Неясны границы — спроси руководителя, не угадывай. Без коммитов, пока не согласовано.
${RU_REPORT}
Подтверди готовность одной строкой и жди пакет.`,
    junior: `Ты — младший разработчик команды «{{teamName}}» (дешёвая модель для простых задач).
- Берёшь только чётко описанные небольшие пакеты; выполняешь инструкции буквально.
- Меняешь только файлы из задачи; без рефакторингов и новых зависимостей.
- Если задача оказалась сложной или неоднозначной — остановись и сообщи руководителю.
${RU_REPORT}
Подтверди готовность одной строкой и жди пакет.`,
    tester: `Ты — тестировщик команды «{{teamName}}». Проверяешь пакеты по их критериям приёмки.
- Сначала точечные проверки; полные прогоны — только по просьбе руководителя.
- Вердикт по пакету: прошёл / не прошёл, с точными шагами воспроизведения и окружением.
- О блокерах сообщай сразу. Код исполнителей сам не правь.
${RU_REPORT}
Подтверди готовность одной строкой и жди пакет на проверку.`,
    reviewer: `Ты — ревьюер команды «{{teamName}}». Ревьюишь диффы: корректность, безопасность, простота.
- Только конкретные замечания: файл, место, что изменить и почему; блокирующее или нет.
- Не переписывай работу сам.
${RU_REPORT}
Подтверди готовность одной строкой и жди пакет на ревью.`,
    writer: `Ты — технический писатель команды «{{teamName}}».
- Сначала уточни аудиторию и источник истины; ссылайся на код и спецификации.
- Следуй принятому стилю документации; пиши коротко и точно.
${RU_REPORT}
Подтверди готовность одной строкой и жди пакет.`,
    analyst: `Ты — аналитик команды «{{teamName}}».
- Превращай запросы в ясные требования: цель, границы, критерии приёмки, открытые вопросы.
- Опирайся на данные и источники; допущения называй явно; пиши кратко.
${RU_REPORT}
Подтверди готовность одной строкой и жди задачу.`,
    devops: `Ты — DevOps-инженер команды «{{teamName}}».
- Сборки, CI, окружения и деплой; предпочитай обратимые минимальные изменения.
- Продакшн и секреты не трогай без явного согласия руководителя.
${RU_REPORT}
Подтверди готовность одной строкой и жди задачу.`,
    manager: `Ты — менеджер (руководитель) команды «{{teamName}}». Цель: результат в срок с минимумом усилий.
- Уточни цели и приоритеты у пользователя; дели работу на небольшие задачи с учётом:
  bb team task add <роль> "<название>" --note "<ожидаемый результат>" --send
- Назначай по сильным сторонам, следи через bb team status, принимай: bb team task done <id>.
- Пиши коротко; решения, требующие пользователя, эскалируй ему.
Подтверди готовность одной строкой и жди задачу от пользователя.`,
  },
};

const KIND_TITLES: Record<Language, Record<RoleKind, string>> = {
  en: {
    lead: "Lead",
    developer: "Developer",
    junior: "Junior developer",
    tester: "Tester",
    reviewer: "Reviewer",
    writer: "Technical writer",
    analyst: "Analyst",
    devops: "DevOps",
    manager: "Manager",
  },
  ru: {
    lead: "Руководитель",
    developer: "Разработчик",
    junior: "Младший разработчик",
    tester: "Тестировщик",
    reviewer: "Ревьюер",
    writer: "Технический писатель",
    analyst: "Аналитик",
    devops: "DevOps",
    manager: "Менеджер",
  },
};

export function isRoleKind(value: string): value is RoleKind {
  return (ROLE_KINDS as readonly string[]).includes(value);
}

/** The role kind: explicit, else the role name, else the name without a "-2" suffix. */
export function roleKindOf(name: string, kind?: string): RoleKind | null {
  for (const candidate of [kind, name, name.replace(/-\d+$/, "")]) {
    if (candidate && isRoleKind(candidate)) return candidate;
  }
  return null;
}

export function kindTitle(lang: Language, kind: RoleKind): string {
  return KIND_TITLES[lang][kind];
}

/** A short role prompt for any role: by kind, else a generic one from the title. */
export function builtinPrompt(
  lang: Language,
  role: { name: string; kind?: string; title?: string; lead?: boolean },
): string {
  const kind = roleKindOf(role.name, role.kind) ?? (role.lead ? "lead" : null);
  if (kind) return KIND_PROMPTS[lang][kind];
  const title = role.title ?? role.name;
  return lang === "ru"
    ? `Ты — ${title} в команде «{{teamName}}». Работай экономно: читай только нужное, меняй минимально.\n${RU_REPORT}\nПодтверди готовность одной строкой и жди задачу.`
    : `You are the ${title} in team "{{teamName}}". Work economically: read only what you need, change minimally.\n${EN_REPORT}\nConfirm readiness in one line and wait for a task.`;
}

/* ──────────────────────── Templates ──────────────────────── */

export const templateRoleSchema = z.object({
  name: z.string().regex(ROLE_NAME_RE, "role name: lowercase letters, digits, hyphens"),
  kind: z.string().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningLevel: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
  lead: z.boolean().optional(),
  enabled: z.boolean().optional(),
  notifyOn: z.array(z.enum(["idle", "error"])).optional(),
  prompt: z.string().max(20000).optional(),
});
export type TemplateRole = z.infer<typeof templateRoleSchema>;

export const templateSchema = z.object({
  id: z.string().regex(TEAM_NAME_RE, "template id: lowercase letters, digits, hyphens (≤32)"),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  roles: z.array(templateRoleSchema).min(1).max(30),
});
export type TeamTemplate = z.infer<typeof templateSchema> & { builtin?: boolean };

const role = (
  lang: Language,
  name: string,
  kind: RoleKind,
  extra: Partial<TemplateRole> = {},
): TemplateRole => ({ name, kind, title: KIND_TITLES[lang][kind], ...extra });

/** Built-in presets. "dev" is the default team. */
export function builtinTemplates(lang: Language): TeamTemplate[] {
  const ru = lang === "ru";
  return [
    {
      id: "dev",
      builtin: true,
      title: ru ? "Команда разработки" : "Development team",
      description: ru
        ? "Руководитель на сильной модели, разработчик, дешёвый джун для простых задач, тестировщик. Качество кода на минимальный бюджет токенов."
        : "A lead on a strong model, a developer, a cheap junior for simple tasks, a tester. Code quality on a minimal token budget.",
      roles: [
        role(lang, "lead", "lead", { lead: true, provider: "codex" }),
        role(lang, "developer", "developer", { provider: "codex" }),
        role(lang, "junior", "junior", { provider: "pi" }),
        role(lang, "tester", "tester", { provider: "codex" }),
      ],
    },
    {
      id: "qa",
      builtin: true,
      title: ru ? "Проверка качества" : "Quality assurance",
      description: ru ? "Руководитель и тестировщик." : "A lead and a tester.",
      roles: [
        role(lang, "lead", "lead", { lead: true, provider: "codex" }),
        role(lang, "tester", "tester", { provider: "codex" }),
      ],
    },
    {
      id: "docs",
      builtin: true,
      title: ru ? "Документация" : "Documentation",
      description: ru ? "Руководитель, технический писатель, ревьюер." : "A lead, a technical writer, a reviewer.",
      roles: [
        role(lang, "lead", "lead", { lead: true, provider: "codex" }),
        role(lang, "writer", "writer", { provider: "codex" }),
        role(lang, "reviewer", "reviewer", { provider: "codex" }),
      ],
    },
    {
      id: "product",
      builtin: true,
      title: ru ? "Менеджерская команда" : "Management team",
      description: ru
        ? "Менеджер, аналитик и писатель: требования, планы, документы."
        : "A manager, an analyst and a writer: requirements, plans, documents.",
      roles: [
        role(lang, "manager", "manager", { lead: true, provider: "codex" }),
        role(lang, "analyst", "analyst", { provider: "codex" }),
        role(lang, "writer", "writer", { provider: "codex" }),
      ],
    },
  ];
}

/** Older template names kept working. */
const TEMPLATE_ALIASES: Record<string, string> = { code: "dev" };

export function findTemplate(
  id: string,
  lang: Language,
  userTemplates: readonly TeamTemplate[],
): TeamTemplate | null {
  const wanted = TEMPLATE_ALIASES[id] ?? id;
  return (
    userTemplates.find((tpl) => tpl.id === wanted) ??
    builtinTemplates(lang).find((tpl) => tpl.id === wanted) ??
    null
  );
}

/** A new template with prepared prompts from role kinds ("lead,developer,junior"). */
export function newTemplateFromKinds(
  lang: Language,
  id: string,
  title: string,
  kinds: readonly string[],
): TeamTemplate {
  const used = new Map<string, number>();
  const roles = kinds.map((raw, index) => {
    const kind = isRoleKind(raw) ? raw : null;
    const base = (kind ?? raw).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "role";
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const name = count > 1 ? `${base}-${count}` : base;
    const entry: TemplateRole = {
      name,
      ...(kind ? { kind } : {}),
      title: kind ? KIND_TITLES[lang][kind] : raw,
      ...(index === 0 ? { lead: true } : {}),
    };
    entry.prompt = builtinPrompt(lang, entry);
    return entry;
  });
  return { id, title, roles };
}

/* ──────────────────────── team.yaml generation ──────────────────────── */

export interface TeamFileLayout {
  config: string;
  promptDir: string;
  /** .gitignore that keeps the team unversioned, and its entries. */
  ignoreFile: string;
  ignoreEntries: string[];
}

export function teamLayout(team: string, legacy = false): TeamFileLayout {
  if (legacy) {
    return {
      config: CONFIG_PATH,
      promptDir: LEGACY_PROMPT_DIR,
      ignoreFile: ".bb/.gitignore",
      ignoreEntries: ["/team.yaml", "/team.json", "/team/"],
    };
  }
  return {
    config: `${TEAMS_DIR}/${team}.yaml`,
    promptDir: `${TEAMS_DIR}/${team}`,
    ignoreFile: `${TEAMS_DIR}/.gitignore`,
    ignoreEntries: [`/${team}.yaml`, `/${team}.json`, `/${team}/`],
  };
}

const YAML_HEAD: Record<Language, (team: string) => string> = {
  en: (team) => `# Agent team "${team}". Spawn: bb team create --team ${team}
# Overview: bb team status · checks: bb team doctor · dashboard: the Team panel
# Prompt placeholders: {{teamName}}, {{leadThreadId}}, {{leadThreadRef}},
# {{role.<name>.threadId}}, {{role.<name>.ref}}, {{projectId}}, {{workspacePath}}, {{vars.<name>}}
# A role without prompt/promptFile gets the built-in prompt of its kind.
# environment: checkout | default | worktree | env:<id>; notifyOn: [idle, error]
`,
  ru: (team) => `# Команда агентов «${team}». Запуск: bb team create --team ${team}
# Состав: bb team status · проверка: bb team doctor · дашборд: панель Team
# Подстановки в промптах: {{teamName}}, {{leadThreadId}}, {{leadThreadRef}},
# {{role.<имя>.threadId}}, {{role.<имя>.ref}}, {{projectId}}, {{workspacePath}}, {{vars.<имя>}}
# Роль без prompt/promptFile получает встроенный промпт своего вида (kind).
# environment: checkout | default | worktree | env:<id>; notifyOn: [idle, error]
`,
};

export interface TeamFile {
  rel: string;
  content: string;
}

/**
 * Files for a team created from a template: the config plus a prompt file per
 * role (the template's prompt, else the built-in one), so prompts are editable.
 */
export function teamFilesFromTemplate(
  lang: Language,
  template: Pick<TeamTemplate, "title" | "roles">,
  team: string,
  options: {
    legacy?: boolean;
    environment?: string;
    adopt?: Record<string, string>;
    vars?: Record<string, string | number | boolean>;
    defaults?: Record<string, unknown>;
  } = {},
): TeamFile[] {
  const layout = teamLayout(team, options.legacy);
  const files: TeamFile[] = [];
  const roles = template.roles.map((item) => {
    const out: Record<string, unknown> = { name: item.name };
    if (item.kind && item.kind !== item.name) out.kind = item.kind;
    if (item.title) out.title = item.title;
    if (item.lead) out.lead = true;
    if (item.enabled === false) out.enabled = false;
    if (item.provider) out.provider = item.provider;
    if (item.model) out.model = item.model;
    if (item.reasoningLevel) out.reasoningLevel = item.reasoningLevel;
    if (item.environment) out.environment = item.environment;
    if (item.notifyOn && item.notifyOn.length > 0) out.notifyOn = item.notifyOn;
    const adopted = options.adopt?.[item.name];
    if (adopted) {
      out.threadId = adopted;
    } else {
      const rel = `${layout.promptDir}/${item.name}.md`;
      out.promptFile = rel;
      files.push({ rel, content: `${(item.prompt ?? builtinPrompt(lang, item)).trim()}\n` });
    }
    return out;
  });
  const config: Record<string, unknown> = {
    version: 1,
    title: template.title,
    ...(options.vars && Object.keys(options.vars).length > 0 ? { vars: options.vars } : {}),
    defaults: options.defaults ?? {
      environment: options.environment ?? "checkout",
      parentNotifications: "stuck",
    },
    roles,
  };
  const yaml = dumpYaml(config, { lineWidth: 120, noRefs: true });
  files.unshift({ rel: layout.config, content: `${YAML_HEAD[lang](team)}${yaml}` });
  return files;
}

/** One role as a YAML list item, for appending to an existing team.yaml. */
export function roleYamlBlock(roleEntry: Record<string, unknown>, indent: string): string {
  const yaml = dumpYaml([roleEntry], { lineWidth: 120, noRefs: true }).trimEnd();
  return yaml
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * Append a role to a team.yaml text when `roles:` is its last top-level key
 * (keeps comments). Returns null when the layout does not allow a safe append.
 */
export function appendRoleToYaml(text: string, roleEntry: Record<string, unknown>): string | null {
  const lines = text.replace(/\s+$/, "").split("\n");
  const rolesAt = lines.findIndex((line) => /^roles\s*:\s*$/.test(line));
  if (rolesAt < 0) return null;
  let indent: string | null = null;
  for (let index = rolesAt + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\S/.test(line) && !line.startsWith("#")) return null; // another top-level key follows
    const match = /^(\s*)-\s/.exec(line);
    // The first list item sets the indent; nested lists (notifyOn: - idle) do not.
    if (match && indent === null) indent = match[1]!;
  }
  indent ??= "  ";
  return `${lines.join("\n")}\n${roleYamlBlock(roleEntry, indent)}\n`;
}

/* ──────────────────────── Versioning (.gitignore) ──────────────────────── */

export function isVersioned(ignoreContent: string | null, entries: readonly string[]): boolean {
  if (!ignoreContent) return true;
  const lines = new Set(ignoreContent.split("\n").map((line) => line.trim()));
  return !entries.some((entry) => lines.has(entry));
}

export function setVersionedContent(
  ignoreContent: string | null,
  entries: readonly string[],
  versioned: boolean,
): string {
  const lines = (ignoreContent ?? "").split("\n").filter((line) => line.trim() !== "");
  const kept = lines.filter((line) => !entries.includes(line.trim()));
  const next = versioned ? kept : [...kept, ...entries];
  return next.length > 0 ? `${next.join("\n")}\n` : "";
}

/* ──────────────────────── Thread titles ──────────────────────── */

export const DEFAULT_TITLE_FORMAT = "👥 {team} · {role}";

/** "👥 {team} · {role}" → "👥 core · Developer"; without the team when showTeam is false. */
export function formatThreadTitle(
  format: string,
  values: { team: string; role: string; showTeam: boolean },
): string {
  let text = format || DEFAULT_TITLE_FORMAT;
  if (!values.showTeam) {
    text = text.replace(/\{team\}\s*[·:|/\-—]?\s*/g, "").replace(/\s*[·:|/\-—]?\s*\{team\}/g, "");
  }
  return text
    .replaceAll("{team}", values.team)
    .replaceAll("{role}", values.role)
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200);
}
