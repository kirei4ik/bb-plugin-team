// @vitest-environment jsdom
// UI: панель Team (вкладки команд, мастер создания, исполнители, пакеты) и редактор шаблонов.
import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { TeamSnapshot } from "./snapshot";
import { builtinTemplates } from "./templates";

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
  options: { snapshots?: TeamSnapshot[]; providers?: { enabled: string[]; disabled: string[] } } = {},
) {
  const app = await loadPluginApp(() => import("./app"));
  const calls: Array<{ method: string; input: unknown }> = [];
  const log = (method: string) => (input: unknown) => {
    calls.push({ method, input });
  };
  let snapshots = options.snapshots ?? [SNAPSHOT];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "proj_1" },
    {
      rpc: {
        projects: () => ({ projects: [{ id: "proj_1", name: "demo" }] }),
        tree: (input: unknown) => {
          log("tree")(input);
          return { projectName: "demo", snapshots, language: "en" };
        },
        providers: () => options.providers ?? { enabled: ["codex", "pi"], disabled: ["claude-code"] },
        templates: () => ({ templates: builtinTemplates("en"), kinds: KINDS, language: "en" }),
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
    },
  );
  return { app, slot, calls };
}

describe("панель Team: дерево команд", () => {
  it("регистрирует navPanel и раздел настроек", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["team"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["templates"]);
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
    fireEvent.change(slot.getByLabelText("Provider"), { target: { value: "pi" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "qwen3" } });
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText('Role "junior" added.');
    expect(calls.find((c) => c.method === "roleAdd")?.input).toEqual({
      projectId: "proj_1",
      team: "main",
      role: { name: "junior", kind: "junior", title: "Junior developer", provider: "pi", model: "qwen3" },
    });
    fireEvent.click(slot.getByText("+ Add executor"));
    fireEvent.click(await slot.findByText("Existing thread"));
    fireEvent.change(await slot.findByLabelText("Thread"), { target: { value: "thr_free" } });
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText('Role "junior" added.');
    expect((calls.filter((c) => c.method === "roleAdd")[1]!.input as { threadId: string }).threadId).toBe("thr_free");
    slot.lifecycle.unmount();
  });

  it("несколько команд в одном дереве; сворачивание; создать недостающих", async () => {
    const { slot, calls } = await mount({ snapshots: [SNAPSHOT, QA] });
    await slot.findByText("QA lead");
    expect(slot.getByText("Not created yet: tester")).toBeTruthy();
    fireEvent.click(slot.getByText("Create missing"));
    await slot.findByText("Threads created: 1.");
    expect(calls.find((c) => c.method === "teamSpawn")?.input).toEqual({ projectId: "proj_1", team: "qa" });
    const toggles = slot.getAllByRole("button", { expanded: true });
    fireEvent.click(toggles[0]!);
    expect(slot.queryByText("Developer")).toBeNull();
    expect(slot.getByText("QA lead")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("проект без команд: мастер; выключенный провайдер блокирует создание", async () => {
    const { slot, calls } = await mount({ snapshots: [], providers: { enabled: ["codex"], disabled: ["pi"] } });
    await slot.findByText("No team in this project yet — create one from a template.");
    await slot.findByDisplayValue("lead");
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(true);
    await slot.findByText(/Disabled or unknown providers: pi/);
    fireEvent.change(slot.getByLabelText("Provider 3"), { target: { value: "" } });
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

describe("настройки: редактор шаблонов", () => {
  it("встроенный — дублировать; новый из видов ролей", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const calls: Array<{ method: string; input: unknown }> = [];
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          templates: () => ({ templates: builtinTemplates("en"), kinds: KINDS, language: "en" }),
          providers: () => ({ enabled: ["codex", "pi"], disabled: [] }),
          templateSave: (input: unknown) => {
            calls.push({ method: "templateSave", input });
            return { ok: true };
          },
          templateNew: (input: unknown) => {
            calls.push({ method: "templateNew", input });
            return { template: { id: "x", title: "x", roles: [] } };
          },
        },
      },
    );
    fireEvent.click(await slot.findByText("Development team · built-in"));
    fireEvent.click(await slot.findByText("Duplicate"));
    await slot.findByText('Template "dev-copy" saved.');
    expect((calls[0]!.input as { template: { id: string } }).template.id).toBe("dev-copy");
    fireEvent.change(slot.getAllByPlaceholderText("Template id").at(-1)!, { target: { value: "pm" } });
    fireEvent.click(slot.getByText("Create with prepared prompts"));
    await slot.findByText('Template "pm" saved.');
    expect(calls[1]).toEqual({
      method: "templateNew",
      input: { id: "pm", title: "pm", kinds: ["lead", "developer", "junior", "tester"] },
    });
    slot.lifecycle.unmount();
  });
});
