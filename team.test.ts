// Тесты v0.2+: tell, живой status, пакеты работ, report, doctor, vars,
// notifyOn, пауза, replace, stop, шаблоны init, @-меню, RPC панели.
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, {
  applyVars,
  excerpt,
  pauseDecision,
  stripThreadIds,
  unknownVars,
} from "./server";
import { escapeHtml, renderReportHtml, renderReportMarkdown } from "./report";
import { layoutHierarchy, type TeamSnapshot } from "./snapshot";
import {
  addTask,
  busyTasks,
  emptyTaskStore,
  listTasks,
  normalizeTaskStore,
  parseTaskStatus,
  updateTask,
} from "./tasks";
import {
  appendRoleToYaml,
  builtinPrompt,
  builtinTemplates,
  formatThreadTitle,
  isVersioned,
  newTemplateFromKinds,
  roleKindOf,
  setVersionedContent,
  teamFilesFromTemplate,
} from "./templates";

/* ──────────────────────── Фейковый хост с состоянием ──────────────────────── */

interface FakeThread {
  id: string;
  role: string | null;
  team?: string;
  helperOf?: string;
  status: string;
  parentThreadId: string | null;
  providerId: string;
  title: string;
  archivedAt: number | null;
  notifyOn: string[];
}

const CONFIG = `
version: 1
vars:
  board: docs/plan.md
  testEnv: env:env_1
defaults:
  environment: checkout
  parentNotifications: stuck
roles:
  - name: lead
    title: Lead
    provider: pi
    prompt: You lead. Board {{vars.board}}.
  - name: developer
    title: Developer
    provider: pi
    prompt: Report to {{leadThreadRef}}.
    notifyOn: [idle]
  - name: tester
    title: Tester
    provider: pi
    environment: "{{vars.testEnv}}"
    prompt: Test on {{vars.board}}.
`;

function makeHost(
  opts: {
    config?: string | null;
    threads?: Array<Partial<FakeThread> & { id: string }>;
    files?: Record<string, string>;
    settings?: Record<string, unknown>;
  } = {},
) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  if (opts.config !== null) files.set("/ws/demo/.bb/team.yaml", opts.config ?? CONFIG);
  const threads = new Map<string, FakeThread>();
  for (const thread of opts.threads ?? []) {
    threads.set(thread.id, {
      role: null,
      status: "idle",
      parentThreadId: null,
      providerId: "pi",
      title: thread.id,
      archivedAt: null,
      notifyOn: [],
      ...thread,
    });
  }
  let spawnNo = 0;
  const toResponse = (thread: FakeThread) =>
    makeThreadResponse({
      id: thread.id,
      projectId: "proj_1",
      status: thread.status as "idle",
      parentThreadId: thread.parentThreadId,
      providerId: thread.providerId,
      title: thread.title,
      archivedAt: thread.archivedAt,
      environmentId: "env_1",
      updatedAt: Date.now() - 60_000,
    });
  const metadataOf = (thread: FakeThread): Record<string, unknown> =>
    thread.role
      ? { teamRole: thread.role, teamNotifyOn: thread.notifyOn, ...(thread.team ? { teamName: thread.team } : {}) }
      : thread.helperOf
        ? { teamHelperOf: thread.helperOf, ...(thread.team ? { teamName: thread.team } : {}) }
        : {};
  const project = (id: string, name: string, path: string) => ({
    id,
    name,
    kind: "standard",
    createdAt: 0,
    updatedAt: 0,
    gitRemoteUrl: null,
    sources: [
      {
        id: `s_${id}`,
        hostId: "host_1",
        path,
        isDefault: true,
        projectId: id,
        type: "local_path",
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  });

  const { bb, harness } = createFakePluginHost({
    pluginId: "team",
    settings: opts.settings ?? {},
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      projects: {
        list: async () => [
          project("proj_1", "demo", "/ws/demo"),
          project("proj_2", "other", "/ws/other"),
        ],
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return { content, sha256: "x" };
        },
        write: async ({ path, content }: { path: string; content: string }) => {
          files.set(path, content);
          return { outcome: "written", sha256: "y", sizeBytes: content.length };
        },
        list: async ({ path }: { path: string }) => ({
          files: [...files.keys()]
            .filter((key) => key.startsWith(`${path}/`))
            .map((key) => ({ path: key.slice(path.length + 1), name: key.split("/").pop()! })),
          truncated: false,
        }),
      },
      environments: {
        list: async () => [
          {
            id: "env_1",
            projectId: "proj_1",
            hostId: "host_1",
            status: "ready",
            environmentProviderId: "project-checkout",
          },
        ],
        get: async () => ({ id: "env_1", hostId: "host_1" }),
      },
      providers: {
        list: async () => [{ id: "pi", available: true }],
        catalog: async () => [{ id: "pi", available: true, enabled: true, displayName: "Pi" }],
      },
      threadSections: {
        list: async () => [{ id: "sec_team", name: "Team", createdAt: 0, updatedAt: 0 }],
        create: async ({ name }: { name: string }) => ({ id: "sec_new", name }),
      },
      threads: {
        list: async ({ offset, projectId }: { offset?: number; projectId?: string } = {}) =>
          (offset ?? 0) > 0 || (projectId && projectId !== "proj_1") ? [] : [...threads.values()].map(toResponse),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds
            .map((id) => threads.get(id))
            .filter((thread): thread is FakeThread => !!thread)
            .map((thread) => ({ threadId: thread.id, metadata: metadataOf(thread) })),
        }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          return thread ? metadataOf(thread) : {};
        },
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("404");
          return toResponse(thread);
        },
        spawn: async (args: Record<string, unknown>) => {
          spawnNo += 1;
          const meta = (args.pluginMetadata ?? {}) as {
            teamRole?: string;
            teamName?: string;
            teamNotifyOn?: string[];
          };
          const thread: FakeThread = {
            id: `thr_new${spawnNo}`,
            role: meta.teamRole ?? null,
            status: "active",
            parentThreadId: (args.parentThreadId as string | undefined) ?? null,
            providerId: "pi",
            title: String(args.title ?? ""),
            archivedAt: null,
            notifyOn: meta.teamNotifyOn ?? [],
            ...(meta.teamName ? { team: meta.teamName } : {}),
          };
          threads.set(thread.id, thread);
          return toResponse(thread);
        },
        send: async () => ({ ok: true, delivery: "sent" }),
        update: async ({
          threadId,
          parentThreadId,
          title,
        }: {
          threadId: string;
          parentThreadId?: string;
          title?: string;
        }) => {
          const thread = threads.get(threadId)!;
          if (parentThreadId !== undefined) thread.parentThreadId = parentThreadId;
          if (title !== undefined) thread.title = title;
          return toResponse(thread);
        },
        updatePluginMetadata: async ({
          threadId,
          set,
          remove,
        }: {
          threadId: string;
          set?: { teamRole?: string; teamName?: string; teamNotifyOn?: string[]; teamHelperOf?: string };
          remove?: string[];
        }) => {
          const thread = threads.get(threadId)!;
          if (set?.teamRole) thread.role = set.teamRole;
          if (set?.teamName) thread.team = set.teamName;
          if (set?.teamHelperOf) thread.helperOf = set.teamHelperOf;
          if (set?.teamNotifyOn) thread.notifyOn = set.teamNotifyOn;
          if (remove?.includes("teamRole")) thread.role = null;
          return metadataOf(thread);
        },
        archive: async ({ threadId }: { threadId: string }) => {
          threads.get(threadId)!.archivedAt = 1;
          return { archivedThreadIds: [threadId] };
        },
        stop: async ({ threadId }: { threadId: string }) => {
          threads.get(threadId)!.status = "idle";
          return toResponse(threads.get(threadId)!);
        },
        output: async () => ({ output: "Finished package #1: login form." }),
        storageLocation: async ({ threadId }: { threadId: string }) => ({
          hostId: "host_1",
          storageRootPath: `/data/thread-storage/${threadId}`,
        }),
      },
    },
  });
  return { bb, harness, files, threads };
}

const TEAM_THREADS = [
  { id: "thr_lead", role: "lead", title: "Lead" },
  { id: "thr_dev", role: "developer", title: "Developer", parentThreadId: "thr_lead", notifyOn: ["idle"] },
  { id: "thr_test", role: "tester", title: "Tester", parentThreadId: "thr_lead", status: "active" },
];

const sendsOf = (harness: ReturnType<typeof makeHost>["harness"]) =>
  harness.inspection.sdk.callsTo("threads.send").map((args) => {
    const a = args[0] as { threadId: string; input: Array<{ text: string }> };
    return { threadId: a.threadId, text: a.input[0]!.text };
  });

/* ──────────────────────── Чистая логика ──────────────────────── */

describe("пакеты работ (чистая логика)", () => {
  it("add / update / list / busy", () => {
    let store = emptyTaskStore();
    ({ store } = addTask(store, { role: "developer", title: "  Login   form " }, 1));
    ({ store } = addTask(store, { role: "tester", title: "Smoke", status: "in-progress" }, 2));
    expect(listTasks(store).map((t) => t.title)).toEqual(["Login form", "Smoke"]);
    const updated = updateTask(store, 1, { status: "in-progress" }, 3);
    expect(updated.previous.status).toBe("todo");
    expect(busyTasks(updated.store, "developer", 99)).toHaveLength(1);
    const done = updateTask(updated.store, 1, { status: "done" }, 4);
    expect(listTasks(done.store)).toHaveLength(1);
    expect(listTasks(done.store, { includeClosed: true })).toHaveLength(2);
  });

  it("статусы: алиасы и мусор", () => {
    expect(parseTaskStatus("WIP")).toBe("in-progress");
    expect(parseTaskStatus("accepted")).toBe("done");
    expect(parseTaskStatus("in progress")).toBe("in-progress");
    expect(() => parseTaskStatus("whatever")).toThrow(/unknown task status/);
  });

  it("normalizeTaskStore терпит мусор и чинит nextId", () => {
    expect(normalizeTaskStore(undefined)).toEqual({ nextId: 1, tasks: [] });
    const store = normalizeTaskStore({
      nextId: 1,
      tasks: [{ id: 5, role: "a", title: "x", status: "todo" }, { junk: true }],
    });
    expect(store.tasks).toHaveLength(1);
    expect(store.nextId).toBe(6);
  });
});

describe("vars и прочие помощники", () => {
  it("applyVars / unknownVars", () => {
    expect(applyVars("a {{vars.x}} b {{vars.y}}", { x: 1 })).toBe("a 1 b <vars.y?>");
    expect(unknownVars("{{vars.x}} {{vars.y}} {{vars.y}}", { x: "1" })).toEqual(["y"]);
  });

  it("stripThreadIds убирает привязки", () => {
    const { text, stripped } = stripThreadIds("roles:\n  - name: a\n    threadId: thr_1\n  - name: b\n");
    expect(stripped).toBe(1);
    expect(text).not.toContain("thr_1");
  });

  it("excerpt ограничивает длину", () => {
    expect(excerpt(null)).toBeNull();
    expect(excerpt("  ")).toBeNull();
    expect(excerpt("x".repeat(10), 5)).toBe("xxxx…");
  });

  it("pauseDecision: держит агентов и ретрансляцию плагина, пропускает человека", () => {
    const paused = new Set(["thr_dev"]);
    const d = (threadId: string, initiator: string, originPluginId: string | null = null) =>
      pauseDecision(threadId, { initiator, originPluginId }, "team", paused, "r");
    expect(d("thr_dev", "agent")).toEqual({ action: "wait", reason: "r" });
    expect(d("thr_dev", "system").action).toBe("wait");
    expect(d("thr_dev", "user").action).toBe("proceed");
    expect(d("thr_dev", "user", "team").action).toBe("wait");
    expect(d("thr_lead", "agent").action).toBe("proceed");
  });
});

const SNAPSHOT: TeamSnapshot = {
  projectId: "proj_1",
  projectName: "demo <&>",
  configSource: ".bb/team.yaml",
  configError: null,
  leadRole: "lead",
  paused: false,
  generatedAtMs: 0,
  roles: [
    {
      name: "lead",
      title: "Lead",
      lead: true,
      inConfig: true,
      enabled: true,
      provider: "codex",
      model: null,
      threads: [
        { threadId: "thr_l", status: "idle", provider: "codex", title: "Lead", updatedAtMs: 0, parentThreadId: null },
      ],
      tasks: [],
    },
    {
      name: "developer",
      title: "Developer",
      lead: false,
      inConfig: true,
      enabled: true,
      provider: "pi",
      model: null,
      threads: [
        { threadId: "thr_d", status: "active", provider: "pi", title: "Dev", updatedAtMs: 0, parentThreadId: "thr_l" },
      ],
      tasks: [
        { id: 3, role: "developer", title: "<script>", status: "in-progress", note: null, createdAtMs: 0, updatedAtMs: 0 },
      ],
    },
    {
      name: "tester",
      title: "Tester",
      lead: false,
      inConfig: true,
      enabled: true,
      provider: "pi",
      model: null,
      threads: [],
      tasks: [],
    },
  ],
};

describe("иерархия и отчёт", () => {
  it("layoutHierarchy: руководитель сверху, исполнители снизу, связи", () => {
    const layout = layoutHierarchy(SNAPSHOT);
    const lead = layout.nodes.find((n) => n.role === "lead")!;
    const dev = layout.nodes.find((n) => n.role === "developer")!;
    const tester = layout.nodes.find((n) => n.role === "tester")!;
    expect(lead.y).toBeLessThan(dev.y);
    expect(tester.tone).toBe("missing");
    expect(dev.task).toBe("#3 <script>");
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.every((e) => e.linked)).toBe(true);
  });

  it("layoutHierarchy: исполнитель не под руководителем — пунктир", () => {
    const broken = structuredClone(SNAPSHOT);
    broken.roles[1]!.threads[0]!.parentThreadId = null;
    const edge = layoutHierarchy(broken).edges.find((e) => e.to.startsWith("developer"))!;
    expect(edge.linked).toBe(false);
  });

  it("HTML экранирует пользовательский текст и содержит граф", () => {
    const html = renderReportHtml(SNAPSHOT, "en", 0);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml("demo <&>"));
  });

  it("Markdown: сводка, роли и пакеты; ru", () => {
    const md = renderReportMarkdown(SNAPSHOT, "en", 0);
    expect(md).toContain("@thread:thr_d");
    expect(md).toContain("#3");
    expect(renderReportMarkdown(SNAPSHOT, "ru", 0)).toContain("Открытые пакеты работ");
  });
});

describe("шаблоны, промпты, названия, версионирование (чистая логика)", () => {
  it("встроенные шаблоны: dev по умолчанию с джуном; файлы с промптами", () => {
    const dev = builtinTemplates("ru").find((tpl) => tpl.id === "dev")!;
    expect(dev.roles.map((r) => r.name)).toEqual(["lead", "developer", "junior", "tester"]);
    expect(builtinTemplates("en").map((tpl) => tpl.id)).toEqual(["dev", "qa", "docs", "product"]);
    const files = teamFilesFromTemplate("ru", dev, "core");
    expect(files.map((f) => f.rel)).toEqual([
      ".bb/teams/core.yaml",
      ".bb/teams/core/lead.md",
      ".bb/teams/core/developer.md",
      ".bb/teams/core/junior.md",
      ".bb/teams/core/tester.md",
    ]);
    expect(files[0]!.content).toContain("promptFile: .bb/teams/core/junior.md");
    expect(files[3]!.content).toContain("младший разработчик");
  });

  it("встроенный промпт: по виду, по имени с суффиксом, общий из title", () => {
    expect(roleKindOf("developer-2")).toBe("developer");
    expect(roleKindOf("helper", "junior")).toBe("junior");
    expect(roleKindOf("designer")).toBeNull();
    expect(builtinPrompt("en", { name: "designer", title: "UI designer" })).toContain("UI designer");
    expect(builtinPrompt("en", { name: "lead" })).toContain("fewest tokens");
  });

  it("новый шаблон из видов ролей: уникальные имена, первый — руководитель, промпты готовы", () => {
    const tpl = newTemplateFromKinds("en", "x", "X", ["lead", "developer", "developer", "designer"]);
    expect(tpl.roles.map((r) => r.name)).toEqual(["lead", "developer", "developer-2", "designer"]);
    expect(tpl.roles[0]!.lead).toBe(true);
    expect(tpl.roles.every((r) => (r.prompt ?? "").length > 20)).toBe(true);
  });

  it("formatThreadTitle: команда видна только при нескольких командах", () => {
    expect(formatThreadTitle("👥 {team} · {role}", { team: "core", role: "Dev", showTeam: true })).toBe("👥 core · Dev");
    expect(formatThreadTitle("👥 {team} · {role}", { team: "core", role: "Dev", showTeam: false })).toBe("👥 Dev");
    expect(formatThreadTitle("[TM] {role} ({team})", { team: "qa", role: "Tester", showTeam: false })).toBe("[TM] Tester");
    expect(formatThreadTitle("[{team}] {role}", { team: "qa", role: "Tester", showTeam: true })).toBe("[qa] Tester");
  });

  it("appendRoleToYaml сохраняет комментарии; без безопасного места — null", () => {
    const yaml = "# head\nversion: 1\nroles:\n  - name: lead\n    title: Lead # c\n";
    const next = appendRoleToYaml(yaml, { name: "junior", provider: "pi" })!;
    expect(next).toContain("# head");
    expect(next).toContain("  - name: junior\n    provider: pi");
    expect(appendRoleToYaml("roles:\n  - name: a\nvars:\n  x: 1\n", { name: "b" })).toBeNull();
    // Вложенный список (notifyOn) не сбивает отступ элементов roles.
    const nested = "roles:\n  - name: dev\n    notifyOn:\n      - idle\n    promptFile: a.md\n";
    expect(appendRoleToYaml(nested, { name: "junior" })).toBe(`${nested}  - name: junior\n`);
  });

  it("версионирование через .gitignore команды", () => {
    const entries = ["/core.yaml", "/core.json", "/core/"];
    const off = setVersionedContent("/other.yaml\n", entries, false);
    expect(isVersioned(off, entries)).toBe(false);
    expect(off).toContain("/other.yaml");
    const on = setVersionedContent(off, entries, true);
    expect(isVersioned(on, entries)).toBe(true);
    expect(on).toBe("/other.yaml\n");
  });
});

/* ──────────────────────── Поведение CLI ──────────────────────── */

describe("bb team tell", () => {
  it("по имени роли — в её тред", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = await harness.behavior.runCli(["tell", "developer", "--message", "hi", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(sendsOf(harness)).toEqual([{ threadId: "thr_dev", text: "hi" }]);
  });

  it("all — всем, кроме отправителя", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = await harness.behavior.runCli(["tell", "all", "--message", "sync"], {
      projectId: "proj_1",
      threadId: "thr_lead",
    });
    expect(result.exitCode).toBe(0);
    expect(sendsOf(harness).map((s) => s.threadId).sort()).toEqual(["thr_dev", "thr_test"]);
  });

  it("неизвестная роль — ошибка с подсказкой", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = await harness.behavior.runCli(["tell", "nobody", "--message", "x", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("bb team status");
  });
});

describe("bb team status (живой)", () => {
  it("статусы тредов и текущий пакет", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "developer", "Login", "form", "--project", "demo"]);
    await harness.behavior.runCli(["task", "update", "1", "--status", "wip", "--project", "demo"]);
    const result = await harness.behavior.runCli(["status", "--project", "demo"]);
    expect(result.stdout).toContain("thr_test [active]");
    expect(result.stdout).toContain("#1 Login form [in-progress]");
    const json = JSON.parse(
      (await harness.behavior.runCli(["status", "--project", "demo", "--json"])).stdout,
    ) as { tasks: Record<string, unknown[]>; threads: Record<string, unknown[]> };
    expect(json.tasks.developer).toHaveLength(1);
    expect(Object.keys(json.threads).sort()).toEqual(["developer", "lead", "tester"]);
  });
});

describe("bb team task", () => {
  it("add --send: в работу, тело с руководителем; второй пакет — предупреждение", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const first = await harness.behavior.runCli([
      "task", "add", "developer", "Login form", "--note", "Use the design", "--send", "--project", "demo",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("in-progress");
    const [send] = sendsOf(harness);
    expect(send!.threadId).toBe("thr_dev");
    expect(send!.text).toContain("Work package #1: Login form");
    expect(send!.text).toContain("Use the design");
    expect(send!.text).toContain("@thread:thr_lead");
    const second = await harness.behavior.runCli([
      "task", "add", "developer", "Profile", "--send", "--project", "demo",
    ]);
    expect(second.stdout).toContain("one active package");
  });

  it("list / done / remove и ошибки", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "tester", "Smoke", "--project", "demo"]);
    const list = await harness.behavior.runCli(["task", "list", "--project", "demo"]);
    expect(list.stdout).toContain("#1 [todo] tester — Smoke");
    const done = await harness.behavior.runCli(["task", "done", "#1", "--project", "demo"]);
    expect(done.stdout).toContain("todo → done");
    expect((await harness.behavior.runCli(["task", "list", "--project", "demo"])).stdout).toContain(
      "No open work packages",
    );
    expect(
      (await harness.behavior.runCli(["task", "list", "--all", "--project", "demo"])).stdout,
    ).toContain("[done]");
    const removed = await harness.behavior.runCli(["task", "remove", "1", "--project", "demo"]);
    expect(removed.exitCode).toBe(0);
    const missing = await harness.behavior.runCli(["task", "done", "1", "--project", "demo"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("not found");
    const badRole = await harness.behavior.runCli(["task", "add", "ghost", "X", "--project", "demo"]);
    expect(badRole.exitCode).not.toBe(0);
    const badStatus = await harness.behavior.runCli([
      "task", "update", "1", "--status", "nope", "--project", "demo",
    ]);
    expect(badStatus.exitCode).not.toBe(0);
  });

  it("send без треда роли — понятная ошибка", async () => {
    const { bb, harness } = makeHost({ threads: [] });
    await plugin(bb);
    const result = await harness.behavior.runCli(["task", "add", "developer", "X", "--send", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("bb team create");
  });

  it("изменения публикуют сигнал для панели", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "tester", "Smoke", "--project", "demo"]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "team-changed",
      payload: { projectId: "proj_1" },
    });
  });
});

describe("bb team report", () => {
  it("md на stdout, html без --out — ошибка", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const md = await harness.behavior.runCli(["report", "--project", "demo"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout).toContain("## Team · demo");
    const html = await harness.behavior.runCli(["report", "--format", "html", "--project", "demo"]);
    expect(html.exitCode).not.toBe(0);
    expect(html.stderr).toContain("--out");
  });

  it("--out в хранилище треда — файл и директива inline-vis", async () => {
    const { bb, harness, files } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = await harness.behavior.runCli(
      ["report", "--out", "/data/thread-storage/thr_me/team/report.html"],
      { projectId: "proj_1", threadId: "thr_me" },
    );
    expect(result.exitCode).toBe(0);
    expect(files.get("/data/thread-storage/thr_me/team/report.html")).toContain("<svg");
    expect(result.stdout).toContain('::inline-vis{source="thread-storage" file="team/report.html"}');
  });
});

describe("bb team doctor", () => {
  it("предупреждения: нет треда, чужой родитель, сирота, .gitignore", async () => {
    const { bb, harness } = makeHost({
      threads: [
        { id: "thr_lead", role: "lead" },
        { id: "thr_dev", role: "developer", parentThreadId: null },
        { id: "thr_ghost", role: "analyst", parentThreadId: "thr_lead" },
      ],
      files: { "/ws/demo/.gitignore": ".bb/\n" },
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["doctor", "--project", "demo", "--json"]);
    const data = JSON.parse(result.stdout) as { fail: number; checks: Array<{ level: string; detail: string }> };
    expect(result.exitCode).toBe(0);
    expect(data.fail).toBe(0);
    const details = data.checks.map((c) => c.detail).join("\n");
    expect(details).toContain("tester: no thread yet");
    expect(details).toContain("developer: thread thr_dev is not a child of the lead");
    expect(details).toContain("analyst: thread thr_ghost carries a role missing");
    expect(details).toContain("ignores .bb/ entirely");
  });

  it("нет конфига и неизвестная vars — провал / предупреждение", async () => {
    const empty = makeHost({ config: null });
    await plugin(empty.bb);
    const missing = await empty.harness.behavior.runCli(["doctor", "--project", "demo"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("bb team init");

    const typo = makeHost({ config: CONFIG.replace("Board {{vars.board}}", "Board {{vars.bord}}") });
    await plugin(typo.bb);
    const warned = await typo.harness.behavior.runCli(["doctor", "--project", "demo"]);
    expect(warned.stdout).toContain("{{vars.bord}}");
  });
});

describe("bb team create: vars и notifyOn", () => {
  it("vars подставлены в промпты и окружение; notifyOn в метаданных", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    const spawns = harness.inspection.sdk
      .callsTo("threads.spawn")
      .map((args) => args[0] as Record<string, unknown>);
    expect(String(spawns[0]!.prompt)).toContain("Board docs/plan.md");
    const byRole = (role: string) =>
      spawns.find((s) => (s.pluginMetadata as { teamRole: string }).teamRole === role)!;
    const developer = byRole("developer");
    expect(developer.pluginMetadata).toEqual({
      teamRole: "developer",
      teamName: "main",
      teamNotifyOn: ["idle"],
    });
    // Одна команда в проекте — имя команды в названии не пишется.
    expect(developer.title).toBe("👥 Developer");
    const tester = byRole("tester");
    expect(tester.environment).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("неизвестная vars в окружении — ошибка до спавна", async () => {
    const { bb, harness } = makeHost({ config: CONFIG.replace("testEnv: env:env_1", "other: x") });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("testEnv");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

describe("notifyOn: уведомления руководителю", () => {
  it("idle исполнителя с notifyOn — руководителю уходит выдержка", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_dev", projectId: "proj_1", parentThreadId: "thr_lead" }),
      lastAssistantText: "Done: login form ready.",
    });
    const sends = sendsOf(harness);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.threadId).toBe("thr_lead");
    expect(sends[0]!.text).toContain("Done: login form ready.");
    expect(harness.inspection.realtimeSignals.some((s) => s.channel === "team-changed")).toBe(true);
  });

  it("без notifyOn и для чужих тредов — тишина", async () => {
    const { bb, harness } = makeHost({ threads: [...TEAM_THREADS, { id: "thr_x" }] });
    await plugin(bb);
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_test", projectId: "proj_1", parentThreadId: "thr_lead" }),
      lastAssistantText: "x",
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_x", projectId: "proj_1", parentThreadId: "thr_lead" }),
      lastAssistantText: "x",
    });
    expect(sendsOf(harness)).toHaveLength(0);
  });
});

describe("пауза", () => {
  it("pause держит исполнителей (не руководителя), resume отпускает", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const paused = await harness.behavior.runCli(["pause", "--project", "demo", "--json"]);
    expect(JSON.parse(paused.stdout)).toMatchObject({ paused: true, count: 2 });
    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const decide = (threadId: string, initiator: string) =>
      hook({ thread: { id: threadId }, initiator, originPluginId: null } as never);
    expect(await decide("thr_dev", "agent")).toMatchObject({ action: "wait" });
    expect(await decide("thr_lead", "agent")).toEqual({ action: "proceed" });
    expect(await decide("thr_dev", "user")).toEqual({ action: "proceed" });

    const tell = await harness.behavior.runCli(["tell", "developer", "--message", "x", "--project", "demo"]);
    expect(tell.stdout).toContain("paused");
    const again = await harness.behavior.runCli(["pause", "--project", "demo"]);
    expect(again.stdout).toContain("already paused");

    const before = harness.inspection.recheckCount;
    const resumed = await harness.behavior.runCli(["resume", "--project", "demo"]);
    expect(resumed.stdout).toContain("resumed");
    expect(harness.inspection.recheckCount).toBe(before + 1);
    expect(await decide("thr_dev", "agent")).toEqual({ action: "proceed" });
    const notPaused = await harness.behavior.runCli(["resume", "--project", "demo"]);
    expect(notPaused.stdout).toContain("not paused");
  });

  it("пауза переживает перезагрузку плагина", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["pause", "--project", "demo"]);
    const reloaded = await harness.lifecycle.reload(plugin);
    const hook = reloaded.harness.inspection.registrations.hooks["message.dispatch"]!;
    expect(await hook({ thread: { id: "thr_test" }, initiator: "agent", originPluginId: null } as never)).toMatchObject({
      action: "wait",
    });
  });
});

describe("bb team stop", () => {
  it("по умолчанию — только работающие исполнители", async () => {
    const { bb, harness } = makeHost({
      threads: [
        { id: "thr_lead", role: "lead", status: "active" },
        { id: "thr_dev", role: "developer", parentThreadId: "thr_lead", status: "idle" },
        { id: "thr_test", role: "tester", parentThreadId: "thr_lead", status: "active" },
      ],
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["stop", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    const stops = harness.inspection.sdk.callsTo("threads.stop").map((a) => (a[0] as { threadId: string }).threadId);
    expect(stops).toEqual(["thr_test"]);
  });
});

describe("bb team replace", () => {
  it("исполнитель: новый тред с передачей дел, старый отвязан и архивирован", async () => {
    const { bb, harness, threads } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "developer", "Profile page", "--project", "demo"]);
    const result = await harness.behavior.runCli(["replace", "developer", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    const spawn = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(spawn.parentThreadId).toBe("thr_lead");
    expect(String(spawn.prompt)).toContain("@thread:thr_dev");
    expect(String(spawn.prompt)).toContain("Finished package #1: login form.");
    expect(String(spawn.prompt)).toContain("#1 Profile page");
    expect(threads.get("thr_dev")!.role).toBeNull();
    expect(threads.get("thr_dev")!.archivedAt).not.toBeNull();
    const notice = sendsOf(harness).find((s) => s.threadId === "thr_lead");
    expect(notice?.text).toContain("thr_new1");
  });

  it("руководитель: исполнители переезжают под новый тред; --keep не архивирует", async () => {
    const { bb, harness, threads } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = await harness.behavior.runCli(["replace", "lead", "--keep", "--project", "demo", "--json"]);
    const data = JSON.parse(result.stdout) as { newThreadId: string; reparented: number; archived: boolean };
    expect(data.reparented).toBe(2);
    expect(data.archived).toBe(false);
    expect(threads.get("thr_dev")!.parentThreadId).toBe(data.newThreadId);
    expect(threads.get("thr_lead")!.archivedAt).toBeNull();
  });

  it("dry-run ничего не меняет; роль без треда — ошибка", async () => {
    const { bb, harness } = makeHost({ threads: [{ id: "thr_lead", role: "lead" }] });
    await plugin(bb);
    const dry = await harness.behavior.runCli(["replace", "lead", "--dry-run", "--project", "demo"]);
    expect(dry.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const none = await harness.behavior.runCli(["replace", "tester", "--project", "demo"]);
    expect(none.exitCode).not.toBe(0);
  });
});

describe("bb team init: шаблоны и --from", () => {
  it("--template qa пишет руководителя и тестировщика", async () => {
    const { bb, harness, files } = makeHost({ config: null });
    await plugin(bb);
    const result = await harness.behavior.runCli(["init", "--template", "qa", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(files.has("/ws/demo/.bb/teams/main/tester.md")).toBe(true);
    expect(files.has("/ws/demo/.bb/teams/main/developer.md")).toBe(false);
  });

  it("--from копирует конфиг и промпты, убирая threadId", async () => {
    const { bb, harness, files } = makeHost({
      config: null,
      files: {
        "/ws/other/.bb/team.yaml":
          "version: 1\nroles:\n  - name: lead\n    threadId: thr_old\n  - name: dev\n    promptFile: .bb/team/roles/dev.md\n",
        "/ws/other/.bb/team/roles/dev.md": "Dev prompt",
      },
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["init", "--from", "other", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("removed 1 threadId");
    expect(files.get("/ws/demo/.bb/teams/main.yaml")).not.toContain("thr_old");
    expect(files.get("/ws/demo/.bb/teams/main/dev.md")).toBe("Dev prompt\n");
  });
});

describe("@-меню «Team roles»", () => {
  it("search находит роли проекта, resolve даёт контекст с тредом", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const provider = harness.inspection.registrations.mentionProviders.find((p) => p.id === "team-roles")!;
    const items = await provider.search({ query: "dev", projectId: "proj_1" } as never);
    expect(items.map((i) => i.id)).toEqual(["main:developer:thr_dev"]);
    const resolved = await provider.resolve("main:developer:thr_dev");
    expect(resolved.context).toContain("@thread:thr_dev");
  });
});

describe("RPC панели", () => {
  it("snapshot / taskAdd / taskUpdate / pause", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const added = (await harness.behavior.callRpc("taskAdd", {
      projectId: "proj_1",
      team: "main",
      role: "developer",
      title: "Panel task",
      send: true,
    })) as { task: { id: number; status: string }; sentTo: string };
    expect(added.task.status).toBe("in-progress");
    expect(added.sentTo).toBe("thr_dev");
    await harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", team: "main", id: 1, status: "review" });
    await harness.behavior.callRpc("pause", { projectId: "proj_1", team: "main", paused: true });
    const { snapshot } = (await harness.behavior.callRpc("snapshot", { projectId: "proj_1" })) as {
      snapshot: TeamSnapshot;
    };
    expect(snapshot.paused).toBe(true);
    expect(snapshot.leadRole).toBe("lead");
    expect(snapshot.roles.find((r) => r.name === "developer")!.tasks[0]!.status).toBe("review");
    await expect(
      harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", team: "main", id: 1, status: "bogus" }),
    ).rejects.toThrow();
  });

  it("сохраняет оба пакета при одновременном добавлении (issue #1)", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const results = await Promise.all([
      harness.behavior.callRpc("taskAdd", {
        projectId: "proj_1", team: "main", role: "developer",
        title: "Review A", send: false,
      }),
      harness.behavior.callRpc("taskAdd", {
        projectId: "proj_1", team: "main", role: "tester",
        title: "Review B", send: false,
      }),
    ]);
    const ids = results.map((r) => (r as { task: { id: number } }).task.id);
    expect(new Set(ids).size).toBe(2);
    const listing = await harness.behavior.runCli(["task", "list", "--all", "--project", "demo"]);
    expect(listing.stdout).toContain("Review A");
    expect(listing.stdout).toContain("Review B");
  });

  it("сохраняет оба обновления при параллельном taskUpdate (issue #1)", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.callRpc("taskAdd", {
      projectId: "proj_1", team: "main", role: "developer", title: "A", send: false,
    });
    await harness.behavior.callRpc("taskAdd", {
      projectId: "proj_1", team: "main", role: "tester", title: "B", send: false,
    });
    await Promise.all([
      harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", team: "main", id: 1, status: "review" }),
      harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", team: "main", id: 2, status: "review" }),
    ]);
    const stored = await bb.storage.kv.get<{ tasks: Array<{ status: string }> }>("tasks:proj_1:main");
    expect(stored!.tasks.map((task) => task.status)).toEqual(["review", "review"]);
  });
});

/* ──────────────────────── v0.3: несколько команд, роли, шаблоны ──────────────────────── */

const CORE_YAML = `version: 1
title: Core
defaults:
  environment: checkout
roles:
  - name: lead
    title: Lead
    provider: pi
  - name: developer
    title: Developer
    provider: pi
`;

const QA_YAML = `version: 1
roles:
  - name: lead
    title: QA lead
    provider: pi
  - name: tester
    title: Tester
    provider: pi
`;

function twoTeams(threads: Array<Partial<FakeThread> & { id: string }> = []) {
  return makeHost({
    config: null,
    files: { "/ws/demo/.bb/teams/core.yaml": CORE_YAML, "/ws/demo/.bb/teams/qa.yaml": QA_YAML },
    threads,
  });
}

describe("несколько команд в проекте", () => {
  it("без --team и вне треда команды — ошибка со списком команд", async () => {
    const { bb, harness } = twoTeams();
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("core, qa");
  });

  it("create --team: свои метаданные, имя команды в названиях, своя секция", async () => {
    const { bb, harness } = twoTeams();
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--team", "qa", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    const spawns = harness.inspection.sdk.callsTo("threads.spawn").map((a) => a[0] as Record<string, unknown>);
    expect(spawns.map((s) => s.title)).toEqual(["👥 qa · QA lead", "👥 qa · Tester"]);
    expect((spawns[1]!.pluginMetadata as { teamName: string }).teamName).toBe("qa");
    const sections = harness.inspection.sdk.callsTo("threadSections.create").map((a) => (a[0] as { name: string }).name);
    expect(sections).toEqual(["Team · qa"]);
  });

  it("команда определяется по треду, из которого вызвана команда", async () => {
    const { bb, harness } = twoTeams([
      { id: "thr_ql", role: "lead", team: "qa" },
      { id: "thr_qt", role: "tester", team: "qa", parentThreadId: "thr_ql" },
      { id: "thr_cl", role: "lead", team: "core" },
    ]);
    await plugin(bb);
    const result = await harness.behavior.runCli(["tell", "tester", "--message", "go"], {
      projectId: "proj_1",
      threadId: "thr_ql",
    });
    expect(result.exitCode).toBe(0);
    expect(sendsOf(harness).map((s) => s.threadId)).toEqual(["thr_qt"]);
  });

  it("status без --team показывает все команды; list — сводка", async () => {
    const { bb, harness } = twoTeams([{ id: "thr_cl", role: "lead", team: "core" }]);
    await plugin(bb);
    const status = await harness.behavior.runCli(["status", "--project", "demo"]);
    expect(status.stdout).toContain('Team "core" — Core [versioned]');
    expect(status.stdout).toContain('Team "qa"');
    const list = JSON.parse((await harness.behavior.runCli(["list", "--project", "demo", "--json"])).stdout) as {
      teams: Array<{ team: string; threads: number }>;
    };
    expect(list.teams).toEqual([
      expect.objectContaining({ team: "core", threads: 1 }),
      expect.objectContaining({ team: "qa", threads: 0 }),
    ]);
  });

  it("пакеты и пауза раздельны по командам", async () => {
    const { bb, harness } = twoTeams([
      { id: "thr_cl", role: "lead", team: "core" },
      { id: "thr_cd", role: "developer", team: "core", parentThreadId: "thr_cl" },
      { id: "thr_ql", role: "lead", team: "qa" },
      { id: "thr_qt", role: "tester", team: "qa", parentThreadId: "thr_ql" },
    ]);
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "developer", "A", "--team", "core", "--project", "demo"]);
    const qaTasks = await harness.behavior.runCli(["task", "list", "--team", "qa", "--project", "demo"]);
    expect(qaTasks.stdout).toContain("No open work packages");
    await harness.behavior.runCli(["pause", "--team", "qa", "--project", "demo"]);
    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const decide = (id: string) => hook({ thread: { id }, initiator: "agent", originPluginId: null } as never);
    expect(await decide("thr_qt")).toMatchObject({ action: "wait" });
    expect(await decide("thr_cd")).toEqual({ action: "proceed" });
  });
});

describe("добавление исполнителя", () => {
  it("add-role: роль дописывается в конфиг (комментарии целы) и создаётся тред", async () => {
    const { bb, harness, files } = twoTeams([{ id: "thr_cl", role: "lead", team: "core" }]);
    files.set("/ws/demo/.bb/teams/core.yaml", `# keep me\n${CORE_YAML}`);
    await plugin(bb);
    const result = await harness.behavior.runCli([
      "add-role", "junior", "--provider", "pi", "--model", "qwen", "--team", "core", "--project", "demo",
    ]);
    expect(result.exitCode).toBe(0);
    const config = files.get("/ws/demo/.bb/teams/core.yaml")!;
    expect(config).toContain("# keep me");
    expect(config).toContain("name: junior");
    expect(config).toContain("model: qwen");
    const spawns = harness.inspection.sdk.callsTo("threads.spawn").map((a) => a[0] as Record<string, unknown>);
    // Только новая роль: руководитель уже есть, developer не трогается.
    expect(spawns.map((s) => (s.pluginMetadata as { teamRole: string }).teamRole)).toEqual(["junior"]);
    expect(spawns[0]!.parentThreadId).toBe("thr_cl");
    expect(String(spawns[0]!.prompt)).toContain("junior developer");
  });

  it("существующий свободный тред становится исполнителем и переименовывается", async () => {
    const { bb, harness, files, threads } = twoTeams([
      { id: "thr_cl", role: "lead", team: "core" },
      { id: "thr_free", title: "Old chat" },
    ]);
    await plugin(bb);
    const free = (await harness.behavior.callRpc("freeThreads", { projectId: "proj_1" })) as {
      threads: Array<{ id: string }>;
    };
    expect(free.threads.map((t) => t.id)).toEqual(["thr_free"]);
    await harness.behavior.callRpc("roleAdd", {
      projectId: "proj_1",
      team: "core",
      role: { name: "reviewer", kind: "reviewer", title: "Reviewer" },
      threadId: "thr_free",
    });
    expect(files.get("/ws/demo/.bb/teams/core.yaml")).toContain("threadId: thr_free");
    expect(threads.get("thr_free")!.role).toBe("reviewer");
    expect(threads.get("thr_free")!.team).toBe("core");
    expect(threads.get("thr_free")!.parentThreadId).toBe("thr_cl");
    expect(threads.get("thr_free")!.title).toBe("👥 core · Reviewer");
  });

  it("тред другой команды не берётся; имя роли не дублируется", async () => {
    const { bb, harness } = twoTeams([
      { id: "thr_cl", role: "lead", team: "core" },
      { id: "thr_ql", role: "lead", team: "qa" },
    ]);
    await plugin(bb);
    const taken = await harness.behavior.runCli([
      "add-role", "helper", "--thread", "thr_ql", "--team", "core", "--project", "demo",
    ]);
    expect(taken.exitCode).not.toBe(0);
    expect(taken.stderr).toContain('team "qa"');
    const dup = await harness.behavior.runCli(["add-role", "developer", "--team", "core", "--project", "demo"]);
    expect(dup.exitCode).not.toBe(0);
    expect(dup.stderr).toContain("developer-2");
  });
});

describe("помощники (вложенные треды)", () => {
  it("тред под тредом роли — помощник этой роли в status и снимке", async () => {
    const { bb, harness } = makeHost({
      threads: [...TEAM_THREADS, { id: "thr_sub", parentThreadId: "thr_dev", title: "Subtask" }],
    });
    await plugin(bb);
    const { snapshot } = (await harness.behavior.callRpc("snapshot", { projectId: "proj_1" })) as {
      snapshot: TeamSnapshot;
    };
    expect(snapshot.roles.find((r) => r.name === "developer")!.helpers.map((h) => h.threadId)).toEqual(["thr_sub"]);
    const status = await harness.behavior.runCli(["status", "--project", "demo"]);
    expect(status.stdout).toContain("1 helper thread(s)");
    const free = (await harness.behavior.callRpc("freeThreads", { projectId: "proj_1" })) as { threads: unknown[] };
    expect(free.threads).toHaveLength(0);
  });

  it("thread.created под тредом роли ставит метку помощника", async () => {
    const { bb, harness, threads } = makeHost({
      threads: [...TEAM_THREADS, { id: "thr_sub", parentThreadId: "thr_dev" }],
    });
    await plugin(bb);
    await harness.behavior.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({ id: "thr_sub", projectId: "proj_1", parentThreadId: "thr_dev" }),
    });
    expect(threads.get("thr_sub")!.helperOf).toBe("developer");
  });
});

describe("версионирование конфига", () => {
  it("по умолчанию вне git; version on/off меняет .bb/teams/.gitignore", async () => {
    const { bb, harness, files } = makeHost({ config: null });
    await plugin(bb);
    await harness.behavior.runCli(["init", "--team", "core", "--project", "demo"]);
    expect(files.get("/ws/demo/.bb/teams/.gitignore")).toContain("/core.yaml");
    const on = await harness.behavior.runCli(["version", "on", "--team", "core", "--project", "demo"]);
    expect(on.exitCode).toBe(0);
    expect(files.get("/ws/demo/.bb/teams/.gitignore") ?? "").not.toContain("/core.yaml");
    await harness.behavior.runCli(["version", "off", "--team", "core", "--project", "demo"]);
    expect(files.get("/ws/demo/.bb/teams/.gitignore")).toContain("/core/");
  });

  it("корневой .gitignore закрывает .bb — включить нельзя", async () => {
    const { bb, harness } = makeHost({ config: null, files: { "/ws/demo/.gitignore": ".bb\n" } });
    await plugin(bb);
    await harness.behavior.runCli(["init", "--team", "core", "--project", "demo"]);
    const on = await harness.behavior.runCli(["version", "on", "--team", "core", "--project", "demo"]);
    expect(on.exitCode).toBe(1);
    expect(on.stdout).toContain(".bb/*");
  });
});

describe("шаблоны команд", () => {
  it("CLI: save из видов, list, show, delete; встроенные защищены", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const saved = await harness.behavior.runCli(["template", "save", "pm", "--kinds", "manager,analyst", "--title", "PM"]);
    expect(saved.exitCode).toBe(0);
    const list = await harness.behavior.runCli(["template", "list"]);
    expect(list.stdout).toContain("dev (built-in)");
    expect(list.stdout).toContain("pm — PM: manager, analyst");
    const show = await harness.behavior.runCli(["template", "show", "dev"]);
    expect(show.stdout).toContain("prompt:");
    const builtin = await harness.behavior.runCli(["template", "delete", "dev"]);
    expect(builtin.exitCode).not.toBe(0);
    expect((await harness.behavior.runCli(["template", "delete", "pm"])).exitCode).toBe(0);
  });

  it("сохранить текущую команду как шаблон и создать по нему новую", async () => {
    const { bb, harness, files } = makeHost();
    await plugin(bb);
    const saved = await harness.behavior.runCli(["template", "save", "mine", "--from-team", "main", "--project", "demo"]);
    expect(saved.exitCode).toBe(0);
    const init = await harness.behavior.runCli(["init", "--team", "copy", "--template", "mine", "--project", "demo"]);
    expect(init.exitCode).toBe(0);
    const copied = files.get("/ws/demo/.bb/teams/copy.yaml")!;
    expect(copied).toContain("name: developer");
    expect(copied).toContain("notifyOn:");
    expect(files.get("/ws/demo/.bb/teams/copy/developer.md")).toContain("Report to {{leadThreadRef}}.");
  });

  it("RPC teamCreate: выключенный провайдер блокирует, валидный — создаёт команду", async () => {
    const { bb, harness, files } = makeHost({ config: null });
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("teamCreate", {
        projectId: "proj_1",
        team: "main",
        title: "Main",
        roles: [{ name: "lead", provider: "nope", lead: true }],
        versioned: false,
      }),
    ).rejects.toThrow(/nope/);
    expect(files.has("/ws/demo/.bb/teams/main.yaml")).toBe(false);
    const created = (await harness.behavior.callRpc("teamCreate", {
      projectId: "proj_1",
      team: "main",
      title: "Main",
      roles: [
        { name: "lead", kind: "lead", provider: "pi", lead: true },
        { name: "junior", kind: "junior", provider: "pi" },
      ],
      versioned: true,
    })) as { spawned: number };
    expect(created.spawned).toBe(2);
    expect(files.get("/ws/demo/.bb/teams/.gitignore") ?? "").not.toContain("/main.yaml");
  });
});

describe("retitle", () => {
  it("переименовывает треды по текущему формату", async () => {
    const { bb, harness, threads } = makeHost({ threads: TEAM_THREADS, settings: { titleFormat: "[TM] {role}" } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["retitle", "--project", "demo"]);
    expect(result.stdout).toContain("3");
    expect(threads.get("thr_dev")!.title).toBe("[TM] Developer");
  });
});

describe("RPC overview: проекты по группам", () => {
  it("с командами / можно создать; без папки — заблокирован с причиной", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const result = (await harness.behavior.callRpc("overview", null)) as {
      projects: Array<{ name: string; state: string; teams: string[]; threads: number; reason: string | null }>;
    };
    const byName = Object.fromEntries(result.projects.map((p) => [p.name, p]));
    expect(byName.demo).toMatchObject({ state: "teams", teams: ["main"], threads: 3 });
    expect(byName.other).toMatchObject({ state: "ready", teams: [] });

    harness.sdk.stub("hosts.list", async () => [{ id: "host_1", name: "laptop", status: "disconnected" }] as never);
    const offline = (await harness.behavior.callRpc("overview", null)) as {
      projects: Array<{ state: string; reason: string | null }>;
    };
    expect(offline.projects.every((p) => p.state === "blocked")).toBe(true);
    expect(offline.projects[0]!.reason).toContain("laptop");
  });
});

describe("приёмка пакетов", () => {
  it("исполнитель не может принять пакет сам; руководитель — может", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    await harness.behavior.runCli(["task", "add", "tester", "Smoke", "--send", "--project", "demo"]);
    const self = await harness.behavior.runCli(["task", "done", "1"], { projectId: "proj_1", threadId: "thr_test" });
    expect(self.exitCode).not.toBe(0);
    expect(self.stderr).toContain("only the lead accepts");
    const review = await harness.behavior.runCli(["task", "update", "1", "--status", "review"], {
      projectId: "proj_1",
      threadId: "thr_test",
    });
    expect(review.exitCode).toBe(0);
    const accepted = await harness.behavior.runCli(["task", "done", "1"], { projectId: "proj_1", threadId: "thr_lead" });
    expect(accepted.exitCode).toBe(0);
  });
});

describe("create восстанавливает связи", () => {
  it("исполнитель без родителя снова становится дочерним тредом руководителя", async () => {
    const { bb, harness, threads } = makeHost({
      threads: [
        { id: "thr_lead", role: "lead" },
        { id: "thr_dev", role: "developer", parentThreadId: null },
        { id: "thr_test", role: "tester", parentThreadId: "thr_lead" },
      ],
    });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("re-linked under the lead: 1");
    expect(threads.get("thr_dev")!.parentThreadId).toBe("thr_lead");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

describe("examples/teams", () => {
  it("пример dev.yaml проходит схему и семантику", async () => {
    const { readFileSync } = await import("node:fs");
    const { load } = await import("js-yaml");
    const { teamConfigSchema, semanticChecks: checks } = await import("./server");
    const parsed = teamConfigSchema.parse(load(readFileSync(new URL("./examples/teams/dev.yaml", import.meta.url), "utf8")));
    const { lead, roles } = checks(parsed);
    expect(lead.name).toBe("lead");
    expect(roles.map((r) => r.name)).toEqual(["lead", "developer", "junior", "tester"]);
  });
});
