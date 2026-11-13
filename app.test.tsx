// @vitest-environment jsdom
// UI: панель Team (вкладки команд, мастер создания, исполнители, пакеты) и редактор шаблонов.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { TeamSnapshot } from "./snapshot";
import type { ResourceSummary } from "./resource-control";
import type { SessionView } from "./session-view";
import { builtinTemplates, type TeamTemplate } from "./templates";

afterEach(cleanup);

const labels = {
  addFallback: "+ Fallback model",
  noAdditionalCost: "I confirm these models are allowed without additional payment",
  duplicateFallback: "Duplicate fallback model",
  nameInvalid: "Name: lowercase letters, digits, hyphens",
  roles: "Roles",
};

const SNAPSHOT: TeamSnapshot = {
  projectId: "proj_1",
  projectName: "demo",
  team: "main",
  teamTitle: "Development team",
  teams: ["main"],
  versioned: false,
  versioningBlocked: false,
  configSource: ".bb/teams/main.yaml",
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
      helpers: [],
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
        { threadId: "thr_d", status: "active", provider: "pi", title: "Developer", updatedAtMs: 0, parentThreadId: "thr_l" },
      ],
      helpers: [
        { threadId: "thr_h", status: "idle", provider: "pi", title: "Subtask", updatedAtMs: 0, parentThreadId: "thr_d" },
      ],
      tasks: [
        { id: 7, role: "developer", title: "Login form", status: "in-progress", note: null, createdAtMs: 0, updatedAtMs: 0 },
      ],
    },
  ],
};

const KINDS = [
  { kind: "lead", title: "Lead" },
  { kind: "developer", title: "Developer" },
  { kind: "junior", title: "Junior developer" },
  { kind: "tester", title: "Tester" },
];

type ProviderModelsResult = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>;

function fakeProviderModels(providerId = "codex"): ProviderModelsResult {
  return {
    modelLoadError: null,
    permissionCeiling: "auto",
    providers: [
      {
        id: "codex",
        available: true,
        displayName: "Codex",
        pluginId: "codex",
        capabilities: {
          modelCatalogScope: "host",
          permissionModes: ["auto"],
          supportsFork: false,
          supportsNativeUserQuestion: false,
          supportsServiceTier: false,
          supportsSessionRewind: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
        },
        completedTurnDisplay: "flat",
        composerActions: [],
        logoUrl: null,
        maintenance: { health: true, installation: true, usage: true },
      },
      {
        id: "pi",
        available: true,
        displayName: "Pi",
        pluginId: "pi",
        capabilities: {
          modelCatalogScope: "host",
          permissionModes: ["auto"],
          supportsFork: false,
          supportsNativeUserQuestion: false,
          supportsServiceTier: true,
          supportsSessionRewind: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
        },
        completedTurnDisplay: "flat",
        composerActions: [],
        logoUrl: null,
        maintenance: { health: true, installation: true, usage: true },
        serviceTiers: [{ id: "fast", label: "Fast" }],
      },
    ],
    models: [
      {
        id: "codex-4",
        model: "gpt-4",
        displayName: "GPT-4",
        description: "",
        isDefault: true,
        defaultReasoningEffort: "none",
        reasoningDiscovery: "known",
        supportedReasoningEfforts: [{ reasoningEffort: "none", description: "" }],
        routeProviderId: "codex",
      },
      {id:"codex-5", model:"gpt-5", displayName:"GPT-5", description:"", isDefault:false, defaultReasoningEffort:"none", reasoningDiscovery:"known", supportedReasoningEfforts:[{reasoningEffort:"none",description:""}], routeProviderId:"codex"},
      {
        id: "pi-glm", model: "ollama-cloud/glm-5.3", displayName: "GLM-5.3", description: "", isDefault: false,
        defaultReasoningEffort: "high", reasoningDiscovery: "known",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], routeProviderId: "ollama-cloud",
      },
      {
        id: "pi-qwen",
        model: "qwen3",
        displayName: "Qwen3",
        description: "",
        isDefault: true,
        defaultReasoningEffort: "low",
        reasoningDiscovery: "known",
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort:"high",description:"" }],
        supportedServiceTiers: [{ id: "fast" }],
        routeProviderId: "ollama-cloud",
      },
    ].filter(model => providerId === "pi" ? model.routeProviderId === "ollama-cloud" : model.routeProviderId === "codex"),
  } as never;
}

function fakeProject(id: string, name: string, path: string) {
  return {
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
  } as never;
}

const QA: TeamSnapshot = {
  ...SNAPSHOT,
  team: "qa",
  teamTitle: "Quality assurance",
  teams: ["main", "qa"],
  roles: [
    { ...SNAPSHOT.roles[0]!, title: "QA lead", threads: [{ ...SNAPSHOT.roles[0]!.threads[0]!, threadId: "thr_ql" }] },
    {
      name: "tester",
      title: "Tester",
      lead: false,
      inConfig: true,
      enabled: true,
      provider: "codex",
      model: null,
      threads: [],
      helpers: [],
      tasks: [],
    },
  ],
};

async function mount(
  options: { snapshots?: TeamSnapshot[]; providers?: { enabled: string[]; disabled: string[] }; templates?: TeamTemplate[]; defaultTemplate?: string; session?: Partial<SessionView>; language?: "en" | "ru"; rotate?: () => Promise<SessionView> } = {},
) {
  const app = await loadPluginApp(() => import("./app"));
  const calls: Array<{ method: string; input: unknown }> = [];
  const log = (method: string) => (input: unknown) => {
    calls.push({ method, input });
  };
  let snapshots = options.snapshots ?? [SNAPSHOT];
  let requested = false;
  const session = (role: string): SessionView => ({threadId: role === "developer" ? "thr_d" : "thr_l", taskId: role === "developer" ? 7 : null, context: {kind: "unavailable", usedTokens: null, limitTokens: null}, checkpoint: "missing", phase: requested ? "awaiting-checkpoint" : "idle", reason: requested ? "context" : null, blockedReason: role === "developer" ? null : "no_task", errorCode: null, ...options.session});
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "proj_1" },
    {
      rpc: {
        projects: () => ({ projects: [{ id: "proj_1", name: "demo" }] }),
        tree: (input: unknown) => {
          log("tree")(input);
          return { projectName: "demo", snapshots, language: options.language ?? "en" };
        },
        sessionView: (input: {role: string}) => { log("sessionView")(input); return session(input.role); },
        sessionRotate: async (input: {role: string}) => { log("sessionRotate")(input); if (options.rotate) return options.rotate(); requested = true; return session(input.role); },
        providers: () => options.providers ?? { enabled: ["codex", "pi"], disabled: ["claude-code"] },
        trackerConfig: () => ({ kind: "beads", override: null }),
        trackerPrepare: (input: unknown) => {
          log("trackerPrepare")(input);
          snapshots = snapshots.map((snapshot) => ({ ...snapshot, trackerError: null }));
          return { status: "created" };
        },
        templates: () => ({ templates: options.templates ?? builtinTemplates("en"), kinds: KINDS, language: "en", defaultTemplate: options.defaultTemplate ?? "dev" }),
        freeThreads: () => ({ threads: [{ id: "thr_free", title: "Old chat", status: "idle", provider: "pi" }] }),
        teamCreate: (input: unknown) => {
          log("teamCreate")(input);
          snapshots = [SNAPSHOT];
          return { team: "main", spawned: 4, leadThreadId: "thr_l" };
        },
        teamSpawn: (input: unknown) => {
          log("teamSpawn")(input);
          return { spawned: 1 };
        },
        roleAdd: (input: unknown) => {
          log("roleAdd")(input);
          return { role: "junior", threadId: "thr_j" };
        },
        tell: (input: unknown) => {
          log("tell")(input);
          return { sent: 1, failed: 0, paused: false };
        },
        stop: (input: unknown) => {
          log("stop")(input);
          return { stopped: 1 };
        },
        resources: (input:{policy?:ResourceSummary["policy"]})=>{
          log("resources")(input);const current=snapshots[0]!.resources!;const result={...current,...(input.policy?{policy:input.policy}:{}),blocked:null};
          snapshots=snapshots.map(snapshot=>({...snapshot,resources:result}));return result;
        },
        rolePolicy: (input: {policy?: unknown}) => {
          log("rolePolicy")(input);
          return {role:{name:"developer",provider:"pi",model:"qwen3",...(input.policy ? {executionPolicy:input.policy}:{})},source:".bb/team.yaml",revision:"rev-1"};
        },
        taskUpdate: (input: {id: number | string; status: TeamSnapshot["roles"][number]["tasks"][number]["status"]}) => {
          log("taskUpdate")(input);
          const old = snapshots.flatMap(snapshot => snapshot.roles.flatMap(role => role.tasks)).find(task => task.id === input.id)!;
          const task = {...old, status: input.status};
          snapshots = snapshots.map(snapshot => ({...snapshot, roles:snapshot.roles.map(role => ({...role,tasks:role.tasks.map(row => row.id === task.id ? task : row)}))}));
          return {task};
        },
        taskAdd: (input: unknown) => {
          log("taskAdd")(input);
          return {
            task: { id: 8, role: "developer", title: "x", status: "todo", note: null, createdAtMs: 0, updatedAtMs: 0 },
            sentTo: null,
          };
        },
        pause: (input: unknown) => {
          log("pause")(input);
          return { paused: true, count: 1 };
        },
        setVersioned: (input: unknown) => {
          log("setVersioned")(input);
          return { versioned: true, blocked: false };
        },
      },
      context: { projectId: "proj_1", threadId: null },
      sdk: {
        environments: { list: async () => [{ id: "env_1", projectId: "proj_1" }] },
        projects: { get: async () => fakeProject("proj_1", "demo", "/ws/demo") },
        providers: { models: async (args) => fakeProviderModels(args?.providerId) },
      },
    },
  );
  return { app, slot, calls };
}

describe("панель Team: дерево команд", () => {
  it("показывает назначение роли и отсутствие назначения без второго поля", async () => {
    const task = SNAPSHOT.roles[1]!.tasks[0]!;
    const { slot } = await mount({ snapshots: [{ ...SNAPSHOT, roles: [
      SNAPSHOT.roles[0]!,
      { ...SNAPSHOT.roles[1]!, tasks: [task, { ...task, id: "bbt-free", role: "", title: "Unassigned work", status: "todo" }] },
    ] }] });
    fireEvent.click(await slot.findByText("▸ Open work packages (2)"));
    expect(slot.getByRole("columnheader", { name: "Assigned role" })).toBeTruthy();
    expect(slot.getByText("developer", { selector: "td" }).title).toBe("main · developer");
    expect(slot.getByText("Unassigned", { selector: "td" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("выбирает сохранённый шаблон моделей, явный выбор меняет его", async () => {
    const saved: TeamTemplate = { id: "ollama-cloud", title: "Pi cloud", roles: [
      { name: "lead", lead: true, provider: "pi", model: "ollama-cloud/glm-5.3", reasoningLevel: "high" },
    ] };
    const { slot } = await mount({ snapshots: [], templates: [...builtinTemplates("en"), saved], defaultTemplate: "ollama-cloud" });
    await slot.findByDisplayValue("ollama-cloud/glm-5.3");
    expect((slot.getByLabelText("Template") as HTMLSelectElement).value).toBe("ollama-cloud");
    fireEvent.change(slot.getByLabelText("Template"), { target: { value: "dev" } });
    await slot.findByDisplayValue("junior");
    expect((slot.getByLabelText("Template") as HTMLSelectElement).value).toBe("dev");
    slot.lifecycle.unmount();
  });

  it("отсутствующий закреплённый шаблон требует явного выбора", async () => {
    const { slot, calls } = await mount({ snapshots: [], defaultTemplate: "missing" });
    await slot.findByText('Template "missing" is missing. Select an existing template.');
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some(c => c.method === "teamCreate")).toBe(false);
    fireEvent.change(slot.getByLabelText("Template"), { target: { value: "dev" } });
    await slot.findByDisplayValue("junior");
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(false);
    slot.lifecycle.unmount();
  });

  it("различает ожидание приёмки и остановленную передачу с безопасным действием", async () => {
    const { slot } = await mount({ snapshots: [{ ...SNAPSHOT, roles: [
      { ...SNAPSHOT.roles[0]!, executionState: { kind: "awaiting-acceptance", taskId: 9, errorCode: null, safeAction: null, atMs: 0 } },
      { ...SNAPSHOT.roles[1]!, executionState: { kind: "error", taskId: 7, errorCode: "spawn_uncertain", errorMessage: "The host disconnected during creation.", safeAction: "Inspect the prepared candidate before retrying.", atMs: 0 } },
    ] }] });
    expect(await slot.findByText("Awaiting acceptance or decision")).toBeTruthy();
    expect(slot.getByText("Needs attention")).toBeTruthy();
    expect(slot.getByRole("alert").textContent).toContain("Inspect the prepared candidate before retrying.");
    expect(slot.getByRole("alert").textContent).toContain("The host disconnected during creation.");
    slot.lifecycle.unmount();
  });

  it("регистрирует navPanel и раздел настроек", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["team"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["templates"]);
  });

  it("без базы Beads: баннер и кнопка создают базу через trackerPrepare", async () => {
    const { slot, calls } = await mount({ snapshots: [{ ...SNAPSHOT, trackerError: { code: "beads_absent", message: "bd list failed (exit 1) in /ws/demo: Error: no beads database found" } }] });
    await slot.findByText("The Beads database does not exist yet — packages cannot be stored.");
    expect(slot.getByText(/no beads database found/)).toBeTruthy();
    expect(slot.getByText(/Login form/)).toBeTruthy(); // the team still renders
    fireEvent.click(slot.getByText("Create database"));
    await slot.findByText("Beads database created.");
    expect(calls.find((c) => c.method === "trackerPrepare")?.input).toEqual({ projectId: "proj_1", team: "main" });
    expect(slot.queryByText(/The Beads database does not exist yet/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("дерево: команда, руководитель, исполнитель с пакетом, помощник", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Developer");
    expect(calls[0]).toEqual({ method: "tree", input: { projectId: "proj_1" } });
    expect(slot.getByRole("tree")).toBeTruthy();
    expect(slot.getByText("— Development team")).toBeTruthy();
    expect(slot.getByText(/#7 Login form · in progress/)).toBeTruthy();
    expect(slot.getByText("Subtask")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("выбор роли открывает детали: пакет, сообщение, остановка", async () => {
    const { slot, calls } = await mount();
    fireEvent.click(await slot.findByText("Developer"));
    const details = await slot.findByRole("complementary", { name: "Role details" });
    expect(details).toBeTruthy();
    fireEvent.click(slot.getByText("Package"));
    fireEvent.change(slot.getByPlaceholderText("Title"), { target: { value: "Profile page" } });
    fireEvent.click(slot.getByText("Add package"));
    await slot.findByText("Package #8 added.");
    expect(calls.find((c) => c.method === "taskAdd")?.input).toEqual({
      projectId: "proj_1",
      team: "main",
      role: "developer",
      title: "Profile page",
      send: true,
    });
    fireEvent.click(slot.getByText("Message"));
    fireEvent.change(slot.getByPlaceholderText("Message to the role…"), { target: { value: "hi" } });
    fireEvent.click(slot.getByText("Send"));
    await slot.findByText("Sent to 1 thread(s).");
    fireEvent.click(slot.getByText("Stop"));
    await slot.findByText("Stopped: 1.");
    expect(calls.find((c) => c.method === "stop")?.input).toEqual({ projectId: "proj_1", team: "main", role: "developer" });
    slot.lifecycle.unmount();
  });

  it("действия команды: пауза и git", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Developer");
    fireEvent.click(slot.getByText("Pause executors"));
    await slot.findByText(/Team paused/);
    fireEvent.click(slot.getByLabelText("Track in git main"));
    await slot.findByText("Config is tracked in git");
    expect(calls.find((c) => c.method === "setVersioned")?.input).toEqual({ projectId: "proj_1", team: "main", versioned: true });
    slot.lifecycle.unmount();
  });

  it("добавить исполнителя: новая роль джуна и существующий тред", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Developer");
    fireEvent.click(slot.getByText("+ Add executor"));
    await slot.findByText("New role");
    // The role starts unset, so open the picker first.
    fireEvent.click(slot.getAllByText("Select model")[0]!);
    await slot.findByLabelText("Provider ID");
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "pi" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "qwen3" } });
    fireEvent.click(slot.getByText("Apply execution selection"));
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText('Role "junior" added.');
    expect(calls.find((c) => c.method === "roleAdd")?.input).toEqual({
      projectId: "proj_1",
      team: "main",
      role: { name: "junior", kind: "junior", title: "Junior developer", provider: "pi", model: "qwen3", reasoningLevel: "none" },
    });
    fireEvent.click(slot.getByText("+ Add executor"));
    fireEvent.click(await slot.findByText("Existing thread"));
    fireEvent.change(await slot.findByLabelText("Thread"), { target: { value: "thr_free" } });
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText('Role "junior" added.');
    expect((calls.filter((c) => c.method === "roleAdd")[1]!.input as { threadId: string }).threadId).toBe("thr_free");
    slot.lifecycle.unmount();
  });

  it("несколько команд в одном дереве; создать недостающих", async () => {
    const { slot, calls } = await mount({ snapshots: [SNAPSHOT, QA] });
    await slot.findByText("QA lead");
    expect(slot.getByText("Not created yet: tester")).toBeTruthy();
    fireEvent.click(slot.getByText("Create missing"));
    await slot.findByText("Threads created: 1.");
    expect(calls.find((c) => c.method === "teamSpawn")?.input).toEqual({ projectId: "proj_1", team: "qa" });
    slot.lifecycle.unmount();
  });

  it("проект без команд: мастер; выключенный провайдер блокирует создание", async () => {
    const { slot, calls } = await mount({ snapshots: [], providers: { enabled: ["codex"], disabled: ["pi"] } });
    await slot.findByText("No team in this project yet — create one from a template.");
    await slot.findByDisplayValue("lead");
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(true);
    expect((await slot.findAllByText(/Disabled or unknown providers: pi/))[0]).toBeTruthy();
    fireEvent.click(slot.getAllByText("Use default")[2]!);
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByText("Create team"));
    await slot.findByText('Team "main" created.');
    const input = calls.find((c) => c.method === "teamCreate")?.input as {
      team: string;
      roles: Array<{ name: string; provider?: string }>;
      versioned: boolean;
    };
    expect(input.team).toBe("main");
    expect(input.versioned).toBe(false);
    expect(input.roles.map((r) => r.name)).toEqual(["lead", "developer", "junior", "tester"]);
    expect(input.roles[2]!.provider).toBeUndefined();
    slot.lifecycle.unmount();
  });
});

describe("панель Team: список проектов", () => {
  it("группы, сортировка по имени, причина блокировки, поиск, переход", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            language: "en",
            projects: [
              { id: "p3", name: "zeta", path: "/w/zeta", teams: [], threads: 0, running: 0, errors: 0, state: "ready", reason: null },
              { id: "p1", name: "beta", path: "/w/beta", teams: ["main", "qa"], threads: 4, running: 1, errors: 0, state: "teams", reason: null },
              { id: "p4", name: "alpha", path: "/w/alpha", teams: [], threads: 0, running: 0, errors: 0, state: "ready", reason: null },
              { id: "p5", name: "omega", path: null, teams: [], threads: 0, running: 0, errors: 0, state: "blocked", reason: "No folder on a connected machine" },
            ],
          }),
        },
        context: { projectId: "p4", threadId: null },
      },
    );
    const ready = await slot.findByRole("region", { name: "A team can be created" });
    expect(ready.textContent!.indexOf("alpha")).toBeLessThan(ready.textContent!.indexOf("zeta"));
    expect(slot.getByRole("region", { name: "Projects with teams" }).textContent).toContain("qa");
    const blocked = slot.getByRole("region", { name: "A team cannot be created now" });
    expect(blocked.textContent).toContain("No folder on a connected machine");
    expect((blocked.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(ready.textContent).toContain("current");
    fireEvent.change(slot.getByPlaceholderText("Search projects and teams…"), { target: { value: "qa" } });
    expect(slot.queryByText("alpha")).toBeNull();
    expect(slot.getByText("beta")).toBeTruthy();
    fireEvent.click(slot.getByText("beta"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel" });
    slot.lifecycle.unmount();
  });
});

async function renderSettings(options: {
    templates?: TeamTemplate[];
    defaultTemplate?: string;
    defaultTemplateExists?: boolean;
    generatorSelection?: { providerId: string; model: string; reasoningLevel?: string; serviceTier?: string } | null;
  } = {}) {
    const app = await loadPluginApp(() => import("./app"));
    const calls: Array<{ method: string; input: unknown }> = [];
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          templates: () => ({
            templates: options.templates ?? builtinTemplates("en"),
            kinds: KINDS,
            language: "en",
            defaultTemplate: options.defaultTemplate ?? "dev",
          }),
          providers: () => ({ enabled: ["codex", "pi"], disabled: [] }),
          editorSettings: () => ({
            language: "en",
            defaultTemplate: options.defaultTemplate ?? "dev",
            defaultTemplateExists: options.defaultTemplateExists ?? true,
            generatorSelection: options.generatorSelection ?? null,
            reloadHint: "",
          }),
          editorSettingsSet: (input: unknown) => {
            calls.push({ method: "editorSettingsSet", input });
            return {
              language: "en",
              defaultTemplate: (input as { defaultTemplate?: string }).defaultTemplate ?? "dev",
              defaultTemplateExists: true,
              generatorSelection: (input as { generatorSelection?: unknown }).generatorSelection ?? null,
              reloadHint: "",
            };
          },
          templateSave: (input: unknown) => {
            calls.push({ method: "templateSave", input });
            return { ok: true };
          },
          templateNew: (input: unknown) => {
            calls.push({ method: "templateNew", input });
            return { template: { id: "x", title: "x", roles: [] } };
          },
          templateDelete: (input: unknown) => {
            calls.push({ method: "templateDelete", input });
            return { ok: true };
          },
        },
        sdk: {
          providers: { models: async (args) => fakeProviderModels(args?.providerId) },
        },
      },
    );
    await slot.findByRole("heading", { name: "Team templates" }, { timeout: 5000 });
    return { app, slot, calls };
  }

describe("настройки: uniform picker/starter", () => {
  it("встроенный шаблон показывает полную форму только для чтения и дублируется", async () => {
    const { slot, calls } = await renderSettings();
    fireEvent.click(await slot.findByText("Development team · built-in"));
    // Builtin is read-only: title input disabled, no Remove buttons, Duplicate present.
    expect((slot.getAllByLabelText("Title")[0] as HTMLInputElement).disabled).toBe(true);
    expect(slot.queryByText("Remove")).toBeNull();
    // Full roles table is shown (not a shortened summary).
    expect(slot.getByText("Provider · Model")).toBeTruthy();
    expect(slot.getAllByText(/default/i).length).toBeGreaterThan(0);
    fireEvent.click(slot.getByText("Duplicate"));
    await slot.findByText('Template "dev-copy" saved.');
    expect((calls[0]!.input as { template: { id: string; builtin?: boolean } }).template.id).toBe("dev-copy");
    expect((calls[0]!.input as { template: { id: string; builtin?: boolean } }).template.builtin).toBeUndefined();
    slot.lifecycle.unmount();
  });

  it("сохраняет executionPolicy с одобренным fallback", async () => {
    const user: TeamTemplate = {
      id: "fallback",
      title: "Fallback team",
      roles: [{ name: "lead", lead: true }],
    };
    const { slot, calls } = await renderSettings({ templates: [...builtinTemplates("en"), user] });
    fireEvent.click(slot.getByRole("button", { name: "Fallback team" }));
    await slot.findByText("Save");
    const policySection = within(slot.getByText(/Fallback models: lead/).parentElement!.parentElement as HTMLElement);
    fireEvent.click(policySection.getByText(labels.addFallback));
    fireEvent.click(policySection.getByText("Select model"));
    await policySection.findByLabelText("Provider ID");
    await act(async () => {});
    fireEvent.change(policySection.getByLabelText("Provider ID"), { target: { value: "pi" } });
    fireEvent.change(policySection.getByLabelText("Model"), { target: { value: "qwen3" } });
    fireEvent.click(policySection.getByText("Apply execution selection"));
    // Approval checkbox is not checked automatically.
    expect((policySection.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(policySection.getByLabelText(labels.noAdditionalCost));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await act(async () => {});
    await slot.findByText('Template "fallback" saved.');
    const saved = (calls.find((c) => c.method === "templateSave")!.input as { template: { roles: Array<Record<string, unknown>> } }).template
      .roles[0]!;
    expect(saved.executionPolicy).toEqual({
      noAdditionalCost: true,
      fallbacks: [{ provider: "pi", model: "qwen3", reasoningLevel: "none" }],
    });
    slot.lifecycle.unmount();
  });

  it("блокирует сохранение шаблона при дублирующемся fallback", async () => {
    const user: TeamTemplate = {
      id: "fallback",
      title: "Fallback team",
      roles: [{ name: "lead", lead: true, executionPolicy: { noAdditionalCost: true, fallbacks: [{ provider: "pi", model: "qwen3" }, { provider: "pi", model: "qwen3" }] } }],
    };
    const { slot } = await renderSettings({ templates: [...builtinTemplates("en"), user] });
    fireEvent.click(slot.getByRole("button", { name: "Fallback team" }));
    await slot.findByText("Save");
    await slot.findByText(/Duplicate fallback model/);
    expect((slot.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("мастер создания команды сохраняет executionPolicy", async () => {
    const saved: TeamTemplate = {
      id: "fallback",
      title: "Fallback team",
      roles: [{ name: "lead", lead: true, executionPolicy: { noAdditionalCost: true, fallbacks: [{ provider: "pi", model: "qwen3" }] } }],
    };
    const { slot, calls } = await mount({ snapshots: [], templates: [...builtinTemplates("en"), saved], defaultTemplate: "fallback" });
    await slot.findByText("Fallback team");
    await slot.findByLabelText("Role 1");
    const existingPolicy = within(slot.getByText(/Fallback models: lead/).parentElement!.parentElement as HTMLElement);
    expect((existingPolicy.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(slot.getByText("Create team"));
    await slot.findByText('Team "main" created.', undefined, { timeout: 5000 });
    const input = calls.find((c) => c.method === "teamCreate")?.input as {
      roles: Array<Record<string, unknown>>;
    };
    expect(input.roles[0]!.executionPolicy).toEqual({
      noAdditionalCost: true,
      fallbacks: [{ provider: "pi", model: "qwen3" }],
    });
    slot.lifecycle.unmount();
  });

  it("добавить исполнителя: форма fallback policy заполняется и требует подтверждения", async () => {
    const { slot } = await mount();
    await slot.findByText("Developer");
    fireEvent.click(slot.getByText("+ Add executor"));
    await slot.findByText("New role");
    const policySection = within(slot.getByText(/Fallback models: junior/).parentElement!.parentElement as HTMLElement);
    fireEvent.click(policySection.getByText(labels.addFallback));
    fireEvent.click(policySection.getByText("Select model"));
    await policySection.findByLabelText("Provider ID");
    await act(async () => {});
    fireEvent.change(policySection.getByLabelText("Provider ID"), { target: { value: "codex" } });
    fireEvent.change(policySection.getByLabelText("Model"), { target: { value: "gpt-5" } });
    fireEvent.click(policySection.getByText("Apply execution selection"));
    await policySection.findByText("codex · gpt-5");
    // Approval is not auto-checked.
    expect((policySection.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(policySection.getByLabelText(labels.noAdditionalCost));
    expect((policySection.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(true);
    slot.lifecycle.unmount();
  });

  it("не теряет сохранённую executionPolicy при переключении primary model", async () => {
    const saved: TeamTemplate = {
      id: "fallback",
      title: "Fallback team",
      roles: [{ name: "lead", lead: true, provider: "codex", model: "gpt-4", executionPolicy: { noAdditionalCost: true, fallbacks: [{ provider: "pi", model: "qwen3" }] } }],
    };
    const { slot, calls } = await renderSettings({ templates: [...builtinTemplates("en"), saved] });
    fireEvent.click(slot.getByRole("button", { name: "Fallback team" }));
    await slot.findByText("Save");
    // The primary picker is the first "Select model" inside the roles table.
    const table = slot.getByRole("table");
    fireEvent.click(within(table).getByText("Use default"));
    fireEvent.click(within(table).getByText("Select model"));
    await within(table).findByLabelText("Provider ID");
    await act(async () => {});
    fireEvent.change(within(table).getByLabelText("Provider ID"), { target: { value: "pi" } });
    fireEvent.change(within(table).getByLabelText("Model"), { target: { value: "qwen3" } });
    fireEvent.click(within(table).getByText("Apply execution selection"));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText('Template "fallback" saved.');
    const role = (calls.find((c) => c.method === "templateSave")!.input as { template: { roles: Array<Record<string, unknown>> } }).template
      .roles[0]!;
    expect(role.provider).toBe("pi");
    expect(role.executionPolicy).toEqual({
      noAdditionalCost: true,
      fallbacks: [{ provider: "pi", model: "qwen3" }],
    });
    slot.lifecycle.unmount();
  });

  it("сохраняет пользовательский шаблон с моделью, reasoning и serviceTier", async () => {
    const user: TeamTemplate = {
      id: "cloud",
      title: "Cloud team",
      roles: [{ name: "lead", lead: true }],
    };
    const { slot, calls } = await renderSettings({ templates: [...builtinTemplates("en"), user] });
    fireEvent.click(slot.getByRole("button", { name: "Cloud team" }));
    await slot.findByText("Save");
    await slot.findByText("Save");
    // Role starts unset → click the first Select model (role picker; generator is below).
    fireEvent.click(slot.getAllByText("Select model")[0]!);
    await slot.findByLabelText("Provider ID");
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "pi" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "qwen3" } });
    fireEvent.change(slot.getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.change(slot.getByLabelText("Service tier"), { target: { value: "fast" } });
    fireEvent.click(slot.getByText("Apply execution selection"));
    fireEvent.click(slot.getByText("Save"));
    await slot.findByText('Template "cloud" saved.');
    const saved = (calls.find((c) => c.method === "templateSave")!.input as { template: { roles: Array<Record<string, unknown>> } }).template.roles[0]!;
    expect(saved.provider).toBe("pi");
    expect(saved.model).toBe("qwen3");
    expect(saved.reasoningLevel).toBe("high");
    expect(saved.serviceTier).toBe("fast");
    slot.lifecycle.unmount();
  });

  it("не теряет недоступную модель при пустом каталоге и показывает default", async () => {
    const user: TeamTemplate = {
      id: "legacy",
      title: "Legacy",
      roles: [{ name: "lead", lead: true, provider: "old-provider", model: "old-model" }],
    };
    const { slot, calls } = await renderSettings({ templates: [user], providers: { enabled: ["codex"], disabled: [] } });
    fireEvent.click(slot.getByRole("button", { name: "Legacy" }));
    // Picker still shows the stored unavailable values once the editor loads.
    await slot.findByText("old-provider · old-model");
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText('Template "legacy" saved.');
    expect(calls.find(call => call.method === "templateSave")?.input).toMatchObject({ template: { roles: [ { provider: "old-provider", model: "old-model" } ] } });
    // Default button is available for another role if added.
    expect(slot.getByText("Use default")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("показывает стартовый промпт и вставляет его без вызовов LLM", async () => {
    const user: TeamTemplate = {
      id: "starter",
      title: "Starter test",
      roles: [{ name: "lead", lead: true, kind: "lead" }],
    };
    const { slot, calls } = await renderSettings({ templates: [user] });
    fireEvent.click(slot.getByRole("button", { name: "Starter test" }));
    await slot.findByText("Insert starter");
    const starter = await slot.findByText(/You are the lead of team/);
    expect(starter).toBeTruthy();
    fireEvent.click(slot.getByText("Insert starter"));
    const textarea = slot.getByLabelText("Prompt lead") as HTMLTextAreaElement;
    expect(textarea.value).toContain("You are the lead of team");
    // No generation RPCs were called.
    expect(calls.some((c) => c.method.includes("generate") || c.method.includes("ai"))).toBe(false);
    slot.lifecycle.unmount();
  });

  it("выбирает шаблон по умолчанию из актуального списка", async () => {
    const { slot, calls } = await renderSettings();
    const select = slot.getByRole("combobox", { name: "Default team template" }) as HTMLSelectElement;
    expect(select.value).toBe("dev");
    fireEvent.change(select, { target: { value: "qa" } });
    await slot.findByText("Default template saved.");
    expect(calls.find((c) => c.method === "editorSettingsSet")?.input).toEqual({ defaultTemplate: "qa" });
    slot.lifecycle.unmount();
  });

  it("предупреждает об отсутствующем defaultTemplate и обрабатывает ошибку удаления", async () => {
    const { slot } = await renderSettings({ defaultTemplate: "missing", defaultTemplateExists: false });
    await slot.findByText('Default template "missing" does not exist.');
    slot.lifecycle.unmount();
  });

  it("сохраняет generatorSelection как точку подключения без LLM", async () => {
    const { slot, calls } = await renderSettings();
    await slot.findByText("Prompt draft model", undefined, { timeout: 3000 });
    // Generator section is the last Select model on the settings page.
    fireEvent.click(slot.getAllByText("Select model").at(-1)!);
    await slot.findByLabelText("Provider ID");
    await act(async () => {});
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "codex" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "gpt-5" } });
    fireEvent.click(slot.getByText("Apply execution selection"));
    await slot.findByText("Prompt draft model saved.");
    expect((calls.find((c) => c.method === "editorSettingsSet")!.input as { generatorSelection: { providerId: string; model: string } }).generatorSelection).toEqual({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "none",
    });
    slot.lifecycle.unmount();
  });
});


describe("карточка рабочей сессии", () => {
  it("показывает оценку контекста и один явный запрос, просмотр не запускает агента", async () => {
    const {slot, calls} = await mount({session: {context: {kind: "estimated", usedTokens: 82000, limitTokens: 100000}}});
    fireEvent.click(await slot.findByText("Developer"));
    await slot.findByText(/≈82%/);
    expect(slot.getByText(/Estimates do not trigger/)).toBeTruthy();
    expect(calls.some(call => call.method === "sessionRotate" || call.method === "tell")).toBe(false);
    fireEvent.click(slot.getByText("Save state and replace session"));
    await slot.findByText(/waiting for the agent to save state/);
    expect((slot.getByText("Handoff requested") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter(call => call.method === "sessionRotate")).toEqual([{method: "sessionRotate", input: {projectId: "proj_1", team: "main", role: "developer", expectedThreadId: "thr_d"}}]);
    slot.lifecycle.unmount();
  });
  it("старый тред без задачи получает объяснение на русском, а не рабочую кнопку", async () => {
    const {slot, calls} = await mount({language: "ru", session: {taskId: null, blockedReason: "no_task"}});
    fireEvent.click(await slot.findByText("Developer"));
    await slot.findByText(/С этой сессией не связана задача/);
    expect(slot.getByText(/Неизвестный объём не означает пустой контекст/)).toBeTruthy();
    expect((slot.getByText("Сохранить состояние и сменить сессию") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some(call => call.method === "sessionRotate")).toBe(false);
    slot.lifecycle.unmount();
  });
  it("точные данные отличаются от оценки, операция не повторяется после ошибки", async () => {
    const {slot, calls} = await mount({session: {context: {kind: "exact", usedTokens: 81000, limitTokens: 100000}}, rotate: async () => {throw new Error("The session changed");}});
    fireEvent.click(await slot.findByText("Developer"));
    await slot.findByText(/81%.*exact counters/);
    fireEvent.click(slot.getByText("Save state and replace session"));
    await slot.findByText(/The session changed/);
    expect(calls.filter(call => call.method === "sessionRotate")).toHaveLength(1);
    await waitFor(() => expect(calls.filter(call => call.method === "sessionView").length).toBeGreaterThanOrEqual(2));
    slot.lifecycle.unmount();
  });
});


describe("parent policy draft regressions", () => {
  it("cached template changes keep the correct list and approval", async () => {
    const policy = (provider:string, model:string) => ({noAdditionalCost:true as const, fallbacks:[{provider,model}]});
    const templates: TeamTemplate[] = [
      {id:"policy-a",title:"Policy A",roles:[{name:"lead",lead:true,executionPolicy:policy("pi","qwen3")}]},
      {id:"policy-b",title:"Policy B",roles:[{name:"lead",lead:true,executionPolicy:policy("codex","gpt-4")}]},
    ];
    const {slot,calls} = await renderSettings({templates});
    for (const [title,model] of [["Policy A","qwen3"],["Policy B","gpt-4"],["Policy A","qwen3"]]) {
      fireEvent.click(slot.getByRole("button",{name:title}));
      await slot.findByDisplayValue(model);
      const section=within(slot.getByText(/Fallback models: lead/).parentElement!.parentElement as HTMLElement);
      expect((section.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(true);
    }
    expect(calls.filter(call=>call.method==="templateSave")).toHaveLength(0);
    slot.lifecycle.unmount();
  });
  it("an unfinished or unapproved list blocks Save instead of silently dropping selections", async () => {
    const {slot,calls}=await renderSettings({templates:[{id:"draft-policy",title:"Draft policy",roles:[{name:"lead",lead:true}]}]});
    fireEvent.click(slot.getByRole("button",{name:"Draft policy"}));
    await slot.findByRole("button",{name:"Save"});
    const section=within(slot.getByText(/Fallback models: lead/).parentElement!.parentElement as HTMLElement);
    fireEvent.click(section.getByText(labels.addFallback));
    expect((slot.getByRole("button",{name:"Save"}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(section.getByText("Select model"));
    await section.findByLabelText("Model");
    await act(async()=>{});
    fireEvent.click(section.getByText("Apply execution selection"));
    expect((section.getByLabelText(labels.noAdditionalCost) as HTMLInputElement).checked).toBe(false);
    expect((slot.getByRole("button",{name:"Save"}) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter(call=>call.method==="templateSave")).toHaveLength(0);
    fireEvent.click(section.getByLabelText(labels.noAdditionalCost));
    expect((slot.getByRole("button",{name:"Save"}) as HTMLButtonElement).disabled).toBe(false);
    slot.lifecycle.unmount();
  });
});

it("acceptance in the panel requires grounds and sends the viewed report id", async () => {
  const task={...SNAPSHOT.roles[1]!.tasks[0]!,status:"review" as const,review:{version:1 as const,submission:{id:"report-a",version:1 as const,result:"Profile implemented",checks:[{what:"Read diff",result:"matches"}],submittedBy:"developer",atMs:1},decisions:[]}};
  const {slot,calls}=await mount({snapshots:[{...SNAPSHOT,roles:[SNAPSHOT.roles[0]!,{...SNAPSHOT.roles[1]!,tasks:[task]}]}]});
  fireEvent.click(await slot.findByText("Developer"));
  fireEvent.change(slot.getByLabelText("#7"),{target:{value:"done"}});
  const form=within(await slot.findByRole("region",{name:"Review & acceptance"}));
  expect(form.getByText(/Profile implemented/)).toBeTruthy();
  fireEvent.click(form.getByText("Accept task"));
  await form.findByRole("alert");
  expect(calls.filter(call=>call.method==="taskUpdate")).toHaveLength(0);
  fireEvent.change(form.getByLabelText("Acceptance grounds: what you checked and why it is enough"),{target:{value:"Compared the diff with criteria"}});
  fireEvent.click(form.getByText("Accept task"));
  await slot.findByText("Task #7 updated.");
  expect(calls.find(call=>call.method==="taskUpdate")?.input).toEqual({projectId:"proj_1",team:"main",id:7,status:"done",acceptReason:"Compared the diff with criteria",expectedSubmissionId:"report-a"});
  slot.lifecycle.unmount();
});

it("edits the existing employee profile with explicit approval and revision",async()=>{
 const {slot,calls}=await mount();fireEvent.click(await slot.findByText("Developer"));
 fireEvent.click(slot.getByRole("button",{name:"Fallback models",exact:true}));
 const section=within(await slot.findByRole("region",{name:"Employee model profile"}));
 expect(section.getByText(/later template edits are not inherited/)).toBeTruthy();
 fireEvent.click(section.getByText(labels.addFallback));
 expect((section.getByRole("button",{name:"Save",exact:true}) as HTMLButtonElement).disabled).toBe(true);
 const fallback=within(section.getByText(/Fallback models: developer/).parentElement!.parentElement!);
 fireEvent.click(fallback.getByText("Select model"));await fallback.findByLabelText("Model");await act(async()=>{});
 fireEvent.change(fallback.getByLabelText("Provider ID"),{target:{value:"pi"}});
 fireEvent.change(fallback.getByLabelText("Model"),{target:{value:"qwen3"}});
 fireEvent.click(fallback.getByText("Apply execution selection"));fireEvent.click(section.getByLabelText(labels.noAdditionalCost));
 fireEvent.click(section.getByRole("button",{name:"Save",exact:true}));
 await slot.findByText("Profile saved for new sessions.");
 expect(calls.filter(call=>call.method==="rolePolicy").at(-1)?.input).toMatchObject({role:"developer",expectedRevision:"rev-1",policy:{noAdditionalCost:true,fallbacks:[{provider:"pi",model:"qwen3"}]}});
 slot.lifecycle.unmount();
});

it("resource status is read-only and a retry/limit decision needs explicit grounds",async()=>{
 const resources:ResourceSummary={sinceMs:1000,policy:{taskAttempts:2,teamStarts:10,tokens:null,minutes:null},starts:2,remainingStarts:8,reportedTokens:null,usageCoverage:"unavailable",blocked:"Task start limit reached",holds:{"task:7":"Repeated failure needs another approach"},attempts:[],taskCounts:[{taskId:7,role:"developer",starts:2,returns:0}],quotaBlocks:[],fallbacks:[],results:{accepted:1,review:0,reports:1,recent:[{id:6,title:"Accepted profile",result:"Profile delivered",checks:[{what:"diff inspected",result:"matches",notApplicable:null}],acceptanceReason:"Compared with criteria"}]}};
 const {slot,calls}=await mount({snapshots:[{...SNAPSHOT,resources}]});
 const panel=within(await slot.findByRole("region",{name:"Team resource control"}));
 expect(panel.getByText(/Reported cumulative tokens.*unavailable/)).toBeTruthy();
 expect(panel.getByText(/Profile delivered/)).toBeTruthy();expect(panel.getByText(/Compared with criteria/)).toBeTruthy();
 expect(calls.filter(c=>c.method==="resources")).toHaveLength(0);
 fireEvent.click(panel.getByText("Save limits with grounds"));await panel.findByText("State the concrete decision or changed approach");
 expect(calls.filter(c=>c.method==="resources")).toHaveLength(0);
 fireEvent.change(panel.getByLabelText("Manual decision / concrete changed approach"),{target:{value:"Reduce the input and inspect the actual error"}});
 fireEvent.click(panel.getByText("Allow next start with this decision"));
 await slot.findByText("Resource decision saved.");
 expect(calls.filter(c=>c.method==="resources").at(-1)?.input).toMatchObject({taskId:7,role:"developer",reason:"Reduce the input and inspect the actual error"});
 expect(calls.some(c=>c.method==="sessionRotate")).toBe(false);slot.lifecycle.unmount();
});
