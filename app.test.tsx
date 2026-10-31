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

async function mount(options: { teams?: string[]; providers?: { enabled: string[]; disabled: string[] } } = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const calls: Array<{ method: string; input: unknown }> = [];
  const log = (method: string) => (input: unknown) => {
    calls.push({ method, input });
  };
  let teams = options.teams ?? ["main"];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        projects: () => ({ projects: [{ id: "proj_1", name: "demo" }] }),
        teams: () => ({ teams, language: "en" }),
        snapshot: (input: unknown) => {
          log("snapshot")(input);
          return { snapshot: SNAPSHOT, language: "en" };
        },
        providers: () => options.providers ?? { enabled: ["codex", "pi"], disabled: ["claude-code"] },
        templates: () => ({ templates: builtinTemplates("en"), kinds: KINDS, language: "en" }),
        freeThreads: () => ({ threads: [{ id: "thr_free", title: "Old chat", status: "idle", provider: "pi" }] }),
        teamCreate: (input: unknown) => {
          log("teamCreate")(input);
          teams = ["main"];
          return { team: "main", spawned: 4, leadThreadId: "thr_l" };
        },
        roleAdd: (input: unknown) => {
          log("roleAdd")(input);
          return { role: "junior", threadId: "thr_j" };
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

describe("панель Team", () => {
  it("регистрирует navPanel и раздел настроек", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["team"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["templates"]);
  });

  it("вкладка команды: роли, помощники, граф, пакеты", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
    expect(calls[0]).toEqual({ method: "snapshot", input: { projectId: "proj_1", team: "main" } });
    expect(slot.getByRole("tab", { name: "👥 main" })).toBeTruthy();
    expect(slot.container.querySelector("svg[aria-label='Hierarchy']")).not.toBeNull();
    expect(slot.getByText("Subtask")).toBeTruthy();
    expect(slot.getByLabelText("#7")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("пакет, пауза и версионирование уходят в RPC с командой", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
    fireEvent.click(slot.getAllByText("Package")[1]!);
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
    fireEvent.click(slot.getByText("Pause executors"));
    await slot.findByText(/Team paused/);
    fireEvent.click(slot.getByLabelText("Track in git"));
    await slot.findByText("Config is tracked in git");
    expect(calls.find((c) => c.method === "setVersioned")?.input).toEqual({
      projectId: "proj_1",
      team: "main",
      versioned: true,
    });
    slot.lifecycle.unmount();
  });

  it("добавить исполнителя: новая роль джуна с провайдером", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
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
    slot.lifecycle.unmount();
  });

  it("добавить исполнителя: существующий тред", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
    fireEvent.click(slot.getByText("+ Add executor"));
    fireEvent.click(await slot.findByText("Existing thread"));
    fireEvent.change(await slot.findByLabelText("Thread"), { target: { value: "thr_free" } });
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText('Role "junior" added.');
    expect((calls.find((c) => c.method === "roleAdd")?.input as { threadId: string }).threadId).toBe("thr_free");
    slot.lifecycle.unmount();
  });

  it("проект без команд: мастер создания; выключенный провайдер блокирует кнопку", async () => {
    const { slot, calls } = await mount({ teams: [], providers: { enabled: ["codex"], disabled: ["pi"] } });
    await slot.findByText("No team in this project yet — create one from a template.");
    await slot.findByDisplayValue("lead");
    expect((slot.getByText("Create team") as HTMLButtonElement).disabled).toBe(true);
    await slot.findByText(/Disabled or unknown providers: pi/);
    // Убрать pi у джуна — провайдер проекта по умолчанию.
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
