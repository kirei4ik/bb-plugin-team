// Тесты bb-plugin-team: чистая логика конфига + поведение CLI на фейковом хосте.
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  applyPlaceholders,
  findSourceByPath,
  gitIgnoresBB,
  strings,
  joinPath,
  parseEnvironmentSpec,
  requireInsideWorkspace,
  semanticChecks,
  teamConfigSchema,
} from "./server";
import { load as loadYaml } from "js-yaml";

/* ──────────────────────── Фикстуры ──────────────────────── */

const CONFIG_YAML = `
version: 1
defaults:
  environment: checkout
  parentNotifications: stuck
roles:
  - name: lead
    title: Lead
    provider: codex
    promptFile: .bb/team/roles/lead.md
  - name: developer
    title: Developer
    provider: pi
    prompt: Build things.
  - name: tester
    title: Tester
    provider: codex
    prompt: Test things.
`;

function parseConfig(yaml: string) {
  const parsed = teamConfigSchema.safeParse(loadYaml(yaml));
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

const WORKSPACE = {
  projectId: "proj_1",
  projectName: "demo",
  path: "/ws/demo",
  hostId: "host_1",
};

/* ──────────────────────── Чистая логика ──────────────────────── */

describe("конфиг team.yaml", () => {
  it("разбирает валидный конфиг", () => {
    const config = parseConfig(CONFIG_YAML);
    expect(config.roles).toHaveLength(3);
    expect(config.defaults?.environment).toBe("checkout");
  });

  it("требует хотя бы одну роль", () => {
    expect(() => parseConfig("version: 1\nroles: []")).toThrow();
  });

  it("первая роль — руководитель, если lead не указан", () => {
    const { lead } = semanticChecks(parseConfig(CONFIG_YAML));
    expect(lead.name).toBe("lead");
  });

  it("lead: true выбирает руководителя явно", () => {
    const { lead } = semanticChecks(
      parseConfig(`
roles:
  - name: developer
    prompt: Dev.
  - name: tester
    prompt: Test.
    lead: true
`),
    );
    expect(lead.name).toBe("tester");
  });

  it("reject: роль без промпта (если нет threadId)", () => {
    expect(() =>
      semanticChecks(parseConfig("roles:\n  - name: lead\n    prompt: x\n  - name: dev\n")),
    ).toThrow(/dev/);
  });

  it("привязываемому треду (threadId) промпт не нужен", () => {
    const { roles } = semanticChecks(
      parseConfig("roles:\n  - name: lead\n    prompt: x\n  - name: dev\n    threadId: thr_abc"),
    );
    expect(roles.map((r) => r.name)).toEqual(["lead", "dev"]);
  });

  it("reject: имя роли объявлено дважды", () => {
    expect(() =>
      semanticChecks(
        parseConfig("roles:\n  - name: lead\n    prompt: a\n  - name: lead\n    prompt: b"),
      ),
    ).toThrow(/twice/);
  });

  it("ru: сообщения локализуются настройкой языка", () => {
    const cfg = parseConfig("roles:\n  - name: a\n    prompt: x\n  - name: a\n    prompt: y");
    expect(() => semanticChecks(cfg, strings("ru"))).toThrow(/дважды/);
  });

  it("reject: два lead: true", () => {
    expect(() =>
      semanticChecks(
        parseConfig(
          "roles:\n  - name: a\n    prompt: x\n    lead: true\n  - name: b\n    prompt: y\n    lead: true",
        ),
      ),
    ).toThrow(/lead/);
  });

  it("reject: один тред привязан к двум ролям", () => {
    expect(() =>
      semanticChecks(
        parseConfig(
          "roles:\n  - name: a\n    prompt: x\n  - name: b\n    threadId: thr_1\n  - name: c\n    threadId: thr_1",
        ),
      ),
    ).toThrow(/thr_1/);
  });

  it("enabled: false убирает роль из плана", () => {
    const { roles } = semanticChecks(
      parseConfig(
        "roles:\n  - name: a\n    prompt: x\n  - name: b\n    prompt: y\n    enabled: false",
      ),
    );
    expect(roles.map((r) => r.name)).toEqual(["a"]);
  });
});

describe("parseEnvironmentSpec", () => {
  it("известные слова", () => {
    expect(parseEnvironmentSpec("default")).toEqual({ kind: "default" });
    expect(parseEnvironmentSpec("checkout")).toEqual({ kind: "checkout" });
    expect(parseEnvironmentSpec("worktree")).toEqual({ kind: "worktree" });
  });

  it("env:<id> и reuse:<id>", () => {
    expect(parseEnvironmentSpec("env:env_abc")).toEqual({
      kind: "env",
      id: "env_abc",
    });
    expect(parseEnvironmentSpec("reuse:env_abc")).toEqual({
      kind: "env",
      id: "env_abc",
    });
  });

  it("reject: мусор", () => {
    expect(() => parseEnvironmentSpec("env:")).toThrow();
    expect(() => parseEnvironmentSpec("nonsense")).toThrow();
  });
});

describe("плейсхолдеры промптов", () => {
  it("подставляет руководителя и роли", () => {
    const roleThreads = new Map([
      ["lead", "thr_lead1"],
      ["developer", "thr_dev1"],
    ]);
    const out = applyPlaceholders(
      "lead={{leadThreadId}} ref={{leadThreadRef}} dev={{role.developer.threadId}} devref={{role.developer.ref}}",
      {
        workspace: WORKSPACE,
        leadThreadId: "thr_lead1",
        roleThreads,
      },
    );
    expect(out).toContain("lead=thr_lead1");
    expect(out).toContain("ref=@thread:thr_lead1");
    expect(out).toContain("dev=thr_dev1");
    expect(out).toContain("devref=@thread:thr_dev1");
  });

  it("проект и путь воркспейса", () => {
    const out = applyPlaceholders("{{projectId}} {{workspacePath}}", {
      workspace: WORKSPACE,
      leadThreadId: null,
      roleThreads: new Map(),
    });
    expect(out).toBe("proj_1 /ws/demo");
  });

  it("неизвестные роли — явная заглушка, не пусто", () => {
    const out = applyPlaceholders("{{role.ghost.threadId}}", {
      workspace: WORKSPACE,
      leadThreadId: null,
      roleThreads: new Map(),
    });
    expect(out).toContain("ghost");
  });

  it("lead без треда — заглушка", () => {
    const out = applyPlaceholders("{{leadThreadId}}", {
      workspace: WORKSPACE,
      leadThreadId: null,
      roleThreads: new Map(),
    });
    expect(out).toContain("lead");
    expect(out).not.toContain("null");
  });
});

describe("границы путей", () => {
  it("joinPath", () => {
    expect(joinPath("/ws/demo", ".bb/team.yaml")).toBe("/ws/demo/.bb/team.yaml");
    expect(joinPath("/ws/demo", "/abs/path")).toBe("/abs/path");
  });

  it("requireInsideWorkspace: escape наружу запрещён", () => {
    expect(() =>
      requireInsideWorkspace("/ws/demo", "/ws/other/.bb/team.yaml"),
    ).toThrow();
    expect(() => requireInsideWorkspace("/ws/demo", "/ws/demo/.bb/x")).not.toThrow();
  });
});

describe("публичные импорты SDK", () => {
  it("без нарушений и приватных зависимостей", async () => {
    const scan = await experimental_scanPublicSdkOnly(
      new URL(".", import.meta.url).pathname,
      { allow: [/^js-yaml$/, /^vitest$/] },
    );
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});

describe("резолюция проекта по cwd", () => {
  const candidates = [
    { projectId: "proj_ws", projectName: "workspace", path: "/ws", hostId: "host_1" },
    { projectId: "proj_1", projectName: "demo", path: "/ws/demo", hostId: "host_1" },
    { projectId: "proj_2", projectName: "other", path: "/other", hostId: "host_2" },
  ];

  it("вложенные проекты: побеждает самый длинный путь", () => {
    const match = findSourceByPath("/ws/demo/apps/budget", candidates, "host_1");
    expect(match?.projectId).toBe("proj_1");
  });

  it("корень проекта и подкаталоги", () => {
    expect(findSourceByPath("/ws/demo", candidates, "host_1")?.projectId).toBe("proj_1");
    expect(findSourceByPath("/ws/demo/.bb", candidates, "host_1")?.projectId).toBe("proj_1");
    expect(findSourceByPath("/ws", candidates, "host_1")?.projectId).toBe("proj_ws");
  });

  it("чужой путь — нет совпадения", () => {
    expect(findSourceByPath("/elsewhere", candidates, "host_1")).toBeNull();
  });

  it("источник на другом хосте не совпадает", () => {
    expect(findSourceByPath("/other", candidates, "host_1")).toBeNull();
    expect(findSourceByPath("/other", candidates, "host_2")?.projectId).toBe("proj_2");
    // хост неизвестен — совпадения по любому хосту
    expect(findSourceByPath("/other", candidates, null)?.projectId).toBe("proj_2");
  });
});

describe("gitIgnoresBB", () => {
  it("распознаёт типичные паттерны .bb", () => {
    expect(gitIgnoresBB("node_modules\n.bb\n")).toBe(true);
    expect(gitIgnoresBB(".bb/\n")).toBe(true);
    expect(gitIgnoresBB(".bb/team.yaml\n")).toBe(true);
    expect(gitIgnoresBB("# .bb comment\ndist/\n")).toBe(false);
    expect(gitIgnoresBB("")).toBe(false);
  });
});

/* ──────────────────────── Поведение CLI (фейковый хост) ──────────────────────── */

const FAKE_CONFIG_YAML = `
version: 1
defaults:
  environment: checkout
  parentNotifications: stuck
roles:
  - name: lead
    title: Lead
    provider: pi
    prompt: You are the lead.
  - name: tester
    title: Tester
    provider: pi
    prompt: Report to {{leadThreadRef}}.
`;

function makeHost(
  opts: {
    configYaml?: string | null;
    settings?: Record<string, unknown>;
    spawnFailures?: number;
  } = {},
) {
  let configYaml: string | null =
    opts.configYaml === undefined ? FAKE_CONFIG_YAML : opts.configYaml;
  let threadNo = 0;
  const written: Array<{ path: string; content: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "team",
    settings: opts.settings ?? {},
    sdk: {
      projects: {
        list: async () => [
          {
            id: "proj_ws",
            name: "workspace",
            kind: "personal",
            createdAt: 0,
            updatedAt: 0,
            gitRemoteUrl: null,
            sources: [
              {
                id: "s_ws",
                hostId: "host_1",
                path: "/ws",
                isDefault: true,
                projectId: "proj_ws",
                type: "local_path",
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
          {
            id: "proj_1",
            name: "demo",
            kind: "standard",
            createdAt: 0,
            updatedAt: 0,
            gitRemoteUrl: null,
            sources: [
              {
                id: "s1",
                hostId: "host_1",
                path: "/ws/demo",
                isDefault: true,
                projectId: "proj_1",
                type: "local_path",
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        ],
      },
      files: {
        read: async ({ path }: { path: string }) => {
          if (path.endsWith("/.gitignore")) {
            return { content: ".bb\nnode_modules/\n", sha256: "g" };
          }
          if (path.endsWith("team.yaml")) {
            if (configYaml === null) throw new Error("ENOENT: " + path);
            return { content: configYaml, sha256: "x" };
          }
          throw new Error("ENOENT: " + path);
        },
        write: async ({ path, content }: { path: string; content: string }) => {
          written.push({ path, content });
          return { outcome: "written", sha256: "y", sizeBytes: content.length };
        },
      },
      environments: {
        list: async () => [
          {
            id: "env_1",
            projectId: "proj_1",
            hostId: "host_1",
            path: "/ws/demo",
            isGitRepo: true,
            isWorktree: false,
            branchName: "main",
            baseBranch: null,
            defaultBranch: "main",
            mergeBaseBranch: null,
            status: "ready",
            environmentProviderId: "project-checkout",
            lifecycle: { phase: "active", retireAt: null, teardown: null },
            hostLifecycle: "active",
            environmentProviderSelection: {
              machine: { type: "existing", hostId: "host_1" },
              inputs: {},
            },
            environmentProviderInstanceKey: "x",
            managed: false,
            workspaceProvisionType: "unmanaged",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
      providers: {
        list: async () => [{ id: "pi", available: true }],
        catalog: async () => [
          { id: "pi", available: true, enabled: true, displayName: "Pi" },
          {
            id: "pi-disabled",
            available: true,
            enabled: false,
            displayName: "Pi (disabled)",
          },
        ],
      },
      threadSections: {
        list: async () => [],
        create: async ({ name }: { name: string }) => ({
          id: "sec_team",
          name,
          createdAt: 0,
          updatedAt: 0,
        }),
      },
      threads: {
        list: async () => [],
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.map((threadId) => ({ threadId, metadata: {} })),
        }),
        spawn: async () => {
          threadNo += 1;
          if (threadNo <= (opts.spawnFailures ?? 0)) {
            throw new Error("HTTP 500: Internal server error");
          }
          return makeThreadResponse({ id: `thr_gen${threadNo}`, providerId: "pi" });
        },
        send: async () => ({ ok: true, delivery: "sent" }),
      },
    },
  });
  return {
    bb,
    harness,
    written,
    setConfigYaml(value: string | null) {
      configYaml = value;
    },
  };
}

describe("bb team CLI (поведение)", () => {
  it("create: спавнит руководителя первым, исполнителя — дочерним с плейсхолдерами", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);

    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);

    const spawns = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(2);

    const [leadSpawn, testerSpawn] = spawns.map(
      (args) => args[0] as Record<string, unknown>,
    );
    expect(leadSpawn.parentThreadId).toBeUndefined();
    expect(testerSpawn.parentThreadId).toBe("thr_gen1");
    expect((leadSpawn.pluginMetadata as Record<string, unknown>).teamRole).toBe("lead");
    expect((testerSpawn.pluginMetadata as Record<string, unknown>).teamRole).toBe("tester");
    // Плейсхолдер руководителя подставлен в промпт исполнителя.
    expect(String(testerSpawn.prompt)).toContain("thr_gen1");
    // Роль-исполнитель получает parentNotifications из defaults (stuck).
    expect(testerSpawn.parentNotifications).toBe("stuck");
    // Окружение checkout переиспользовано.
    expect(testerSpawn.environment).toEqual({
      type: "reuse",
      environmentId: "env_1",
    });
    // Секция Team создана и назначена (настройка teamSection по умолчанию вкл).
    const sectionCreates = harness.inspection.sdk.callsTo("threadSections.create");
    expect(sectionCreates).toHaveLength(1);
    expect((sectionCreates[0]![0] as { name: string }).name).toBe("Team");
    expect(testerSpawn.sectionId).toBe("sec_team");
  });

  it("create: ростер уходит руководителю", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    const sends = harness.inspection.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    const text = (sends[0]![0] as { input: Array<{ text: string }> }).input[0]!.text;
    expect(text).toContain("thr_gen2"); // ссылка на исполнителя
  });

  it("create --dry-run: ничего не спавнит", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli([
      "create",
      "--project",
      "demo",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(result.stdout).toContain("Tester");
  });

  it("create: неизвестный провайдер — ошибка до спавна", async () => {
    const { bb, harness, setConfigYaml } = makeHost();
    await plugin(bb);
    setConfigYaml(
      FAKE_CONFIG_YAML.replace("provider: pi", "provider: no-such-provider"),
    );
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no-such-provider");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("create: отключённый провайдер — понятная ошибка с командой включения", async () => {
    const { bb, harness, setConfigYaml } = makeHost();
    await plugin(bb);
    setConfigYaml(FAKE_CONFIG_YAML.replace("provider: pi", "provider: pi-disabled"));
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("provider enable pi-disabled");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("init: пишет шаблонные файлы и не перезаписывает без --force", async () => {
    const { bb, harness, written, setConfigYaml } = makeHost({ configYaml: null });
    await plugin(bb);

    // Первый вызов: файлов нет (files.read бросает) — пишет.
    const first = await harness.behavior.runCli(["init", "--project", "demo"]);
    if (first.exitCode !== 0) console.log("INIT STDERR:", first.stderr);
    expect(first.exitCode).toBe(0);
    expect(written.map((w) => w.path)).toContain("/ws/demo/.bb/team.yaml");

    // Второй вызов: файл появился — защита от перезаписи без --force.
    setConfigYaml(FAKE_CONFIG_YAML);
    const second = await harness.behavior.runCli(["init", "--project", "demo"]);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("--force");
  });

  it("настройка roster: off — ростер не отправляется", async () => {
    const { bb, harness } = makeHost({ settings: { roster: false } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("настройка teamSection: off — секция не создаётся", async () => {
    const { bb, harness } = makeHost({ settings: { teamSection: false } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threadSections.create")).toHaveLength(0);
    const spawns = harness.inspection.sdk.callsTo("threads.spawn");
    const [, testerSpawn] = spawns.map((args) => args[0] as Record<string, unknown>);
    expect(testerSpawn.sectionId ?? null).toBeNull();
  });

  it("настройка language: ru — вывод на русском и секция «Команда»", async () => {
    const { bb, harness } = makeHost({ settings: { language: "ru" } });
    await plugin(bb);
    const result = await harness.behavior.runCli(["status", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Проект");
    const created = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("[создан]");
    const sectionCreates = harness.inspection.sdk.callsTo("threadSections.create");
    expect((sectionCreates[0]![0] as { name: string }).name).toBe("Команда");
  });

  it("без --project: проект определяется по cwd (вложенный — самый длинный)", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["status"], {
      cwd: "/ws/demo/apps/budget",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Project \"demo\"");
  });

  it("без --project и вне проекта: ошибка с подсказкой", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["status"], {
      cwd: "/elsewhere",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--project");
  });

  it("init: заметка, если .bb игнорируется git", async () => {
    const { bb, harness } = makeHost({ configYaml: null });
    await plugin(bb);
    const result = await harness.behavior.runCli(["init"], { cwd: "/ws/demo" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gitignored");
    const json = await harness.behavior.runCli(["init", "--force", "--json"], {
      cwd: "/ws/demo",
    });
    expect((JSON.parse(json.stdout) as { gitignored: boolean }).gitignored).toBe(true);
  });

  it("spawn: одиночный сбой спавна автоматически повторяется", async () => {
    const { bb, harness } = makeHost({ spawnFailures: 1 });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).toBe(0);
    // первый вызов lead упал, повтор создал, tester — сразу: 3 вызова
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
    expect(result.stdout).toContain("[created] lead");
    expect(result.stdout).toContain("[created] tester");
  });

  it("spawn: два сбоя подряд — понятная ошибка", async () => {
    const { bb, harness } = makeHost({ spawnFailures: 2 });
    await plugin(bb);
    const result = await harness.behavior.runCli(["create", "--project", "demo"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Re-run bb team create");
  });

  it("status --json: машина-читаемый ответ", async () => {
    const { bb, harness } = makeHost();
    await plugin(bb);
    const result = await harness.behavior.runCli(["status", "--project", "demo", "--json"]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as { ok: boolean; config: { lead: string } };
    expect(data.ok).toBe(true);
    expect(data.config.lead).toBe("lead");
  });
});