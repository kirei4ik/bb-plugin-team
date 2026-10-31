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
import { teamYaml, templateFiles } from "./templates";

/* ──────────────────────── Фейковый хост с состоянием ──────────────────────── */

interface FakeThread {
  id: string;
  role: string | null;
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
  const metadataOf = (thread: FakeThread) =>
    thread.role ? { teamRole: thread.role, teamNotifyOn: thread.notifyOn } : {};
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
        list: async ({ offset }: { offset?: number } = {}) =>
          (offset ?? 0) > 0 ? [] : [...threads.values()].map(toResponse),
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
          const meta = (args.pluginMetadata ?? {}) as { teamRole?: string; teamNotifyOn?: string[] };
          const thread: FakeThread = {
            id: `thr_new${spawnNo}`,
            role: meta.teamRole ?? null,
            status: "active",
            parentThreadId: (args.parentThreadId as string | undefined) ?? null,
            providerId: "pi",
            title: String(args.title ?? ""),
            archivedAt: null,
            notifyOn: meta.teamNotifyOn ?? [],
          };
          threads.set(thread.id, thread);
          return toResponse(thread);
        },
        send: async () => ({ ok: true, delivery: "sent" }),
        update: async ({ threadId, parentThreadId }: { threadId: string; parentThreadId?: string }) => {
          const thread = threads.get(threadId)!;
          if (parentThreadId !== undefined) thread.parentThreadId = parentThreadId;
          return toResponse(thread);
        },
        updatePluginMetadata: async ({
          threadId,
          set,
          remove,
        }: {
          threadId: string;
          set?: { teamRole?: string; teamNotifyOn?: string[] };
          remove?: string[];
        }) => {
          const thread = threads.get(threadId)!;
          if (set?.teamRole) thread.role = set.teamRole;
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

describe("шаблоны init", () => {
  it("пресеты code / qa / docs", () => {
    expect(templateFiles("en", "code").map((f) => f.rel)).toEqual([
      ".bb/team.yaml",
      ".bb/team/roles/lead.md",
      ".bb/team/roles/developer.md",
      ".bb/team/roles/tester.md",
    ]);
    expect(templateFiles("en", "qa")).toHaveLength(3);
    expect(templateFiles("ru", "docs").map((f) => f.rel)).toContain(".bb/team/roles/writer.md");
    expect(teamYaml("ru", "docs")).toContain("Технический писатель");
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
    expect(details).toContain(".bb is gitignored");
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
    const developer = spawns.find((s) => s.title === "Developer")!;
    expect(developer.pluginMetadata).toEqual({ teamRole: "developer", teamNotifyOn: ["idle"] });
    const tester = spawns.find((s) => s.title === "Tester")!;
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
    expect(files.has("/ws/demo/.bb/team/roles/tester.md")).toBe(true);
    expect(files.has("/ws/demo/.bb/team/roles/developer.md")).toBe(false);
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
    expect(files.get("/ws/demo/.bb/team.yaml")).not.toContain("thr_old");
    expect(files.get("/ws/demo/.bb/team/roles/dev.md")).toBe("Dev prompt");
  });
});

describe("@-меню «Team roles»", () => {
  it("search находит роли проекта, resolve даёт контекст с тредом", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const provider = harness.inspection.registrations.mentionProviders.find((p) => p.id === "team-roles")!;
    const items = await provider.search({ query: "dev", projectId: "proj_1" } as never);
    expect(items.map((i) => i.id)).toEqual(["developer:thr_dev"]);
    const resolved = await provider.resolve("developer:thr_dev");
    expect(resolved.context).toContain("@thread:thr_dev");
  });
});

describe("RPC панели", () => {
  it("snapshot / taskAdd / taskUpdate / pause", async () => {
    const { bb, harness } = makeHost({ threads: TEAM_THREADS });
    await plugin(bb);
    const added = (await harness.behavior.callRpc("taskAdd", {
      projectId: "proj_1",
      role: "developer",
      title: "Panel task",
      send: true,
    })) as { task: { id: number; status: string }; sentTo: string };
    expect(added.task.status).toBe("in-progress");
    expect(added.sentTo).toBe("thr_dev");
    await harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", id: 1, status: "review" });
    await harness.behavior.callRpc("pause", { projectId: "proj_1", paused: true });
    const { snapshot } = (await harness.behavior.callRpc("snapshot", { projectId: "proj_1" })) as {
      snapshot: TeamSnapshot;
    };
    expect(snapshot.paused).toBe(true);
    expect(snapshot.leadRole).toBe("lead");
    expect(snapshot.roles.find((r) => r.name === "developer")!.tasks[0]!.status).toBe("review");
    await expect(
      harness.behavior.callRpc("taskUpdate", { projectId: "proj_1", id: 1, status: "bogus" }),
    ).rejects.toThrow();
  });
});
