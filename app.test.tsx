// @vitest-environment jsdom
// Панель Team: рендер снимка, граф, действия через RPC.
import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { TeamSnapshot } from "./snapshot";

const SNAPSHOT: TeamSnapshot = {
  projectId: "proj_1",
  projectName: "demo",
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
        { threadId: "thr_d", status: "active", provider: "pi", title: "Developer", updatedAtMs: 0, parentThreadId: "thr_l" },
      ],
      tasks: [
        { id: 7, role: "developer", title: "Login form", status: "in-progress", note: null, createdAtMs: 0, updatedAtMs: 0 },
      ],
    },
  ],
};

async function mount() {
  const app = await loadPluginApp(() => import("./app"));
  const calls: Array<{ method: string; input: unknown }> = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        projects: () => ({ projects: [{ id: "proj_1", name: "demo" }] }),
        snapshot: (input: unknown) => {
          calls.push({ method: "snapshot", input });
          return { snapshot: SNAPSHOT, language: "en" };
        },
        taskAdd: (input: unknown) => {
          calls.push({ method: "taskAdd", input });
          return {
            task: { id: 8, role: "developer", title: "x", status: "todo", note: null, createdAtMs: 0, updatedAtMs: 0 },
            sentTo: null,
          };
        },
        pause: (input: unknown) => {
          calls.push({ method: "pause", input });
          return { paused: true, count: 1 };
        },
      },
      context: { projectId: "proj_1", threadId: null },
    },
  );
  return { app, slot, calls };
}

describe("панель Team", () => {
  it("регистрирует navPanel team", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["team"]);
  });

  it("рисует роли, граф и открытые пакеты текущего проекта", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
    expect(calls[0]).toEqual({ method: "snapshot", input: { projectId: "proj_1" } });
    expect(slot.container.querySelector("svg[aria-label='Hierarchy']")).not.toBeNull();
    expect(slot.getAllByText("Login form").length).toBeGreaterThan(0);
    expect(slot.getByLabelText("#7")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("форма пакета вызывает taskAdd; пауза вызывает pause", async () => {
    const { slot, calls } = await mount();
    await slot.findByText("Team · demo");
    fireEvent.click(slot.getAllByText("Package")[1]!);
    fireEvent.change(slot.getByPlaceholderText("Title"), { target: { value: "Profile page" } });
    fireEvent.click(slot.getByText("Add package"));
    await slot.findByText("Package #8 added.");
    expect(calls.find((c) => c.method === "taskAdd")?.input).toEqual({
      projectId: "proj_1",
      role: "developer",
      title: "Profile page",
      send: true,
    });
    fireEvent.click(slot.getByText("Pause executors"));
    await slot.findByText(/Team paused/);
    expect(calls.some((c) => c.method === "pause")).toBe(true);
    slot.lifecycle.unmount();
  });
});
