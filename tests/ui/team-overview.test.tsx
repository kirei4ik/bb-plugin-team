// @vitest-environment jsdom
// Read-only TeamOverview component: deterministic tests for the compact
// epic/team slice, the honest progress contract and the hold categories.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TeamOverview } from "../../src/app/team-overview";
import type {
  ContinuationView,
  Language,
  SnapshotRole,
  SnapshotThread,
  TeamSnapshot,
  TeamTask,
  TaskStatus,
} from "../../src/shared/snapshot";
import type { ResourceSummary } from "../../src/server/resource-control";

afterEach(cleanup);

function makeResources(partial: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    sinceMs: 0,
    policy: {
      taskAttempts: 8,
      coordinationAttempts: 40,
      teamStarts: null,
      tokens: null,
      minutes: null,
    },
    starts: 0,
    remainingStarts: null,
    reportedTokens: null,
    usageCoverage: "unavailable",
    blocked: null,
    holds: {},
    attempts: [],
    fallbacks: [],
    quotaBlocks: [],
    taskCounts: [],
    ...partial,
  };
}

function makeThread(threadId: string, status: string): SnapshotThread {
  return {
    threadId,
    status,
    provider: "pi",
    title: "thread",
    updatedAtMs: 0,
    parentThreadId: null,
  };
}

function makeRole(name: string, partial: Partial<SnapshotRole> = {}): SnapshotRole {
  return {
    name,
    title: name,
    lead: false,
    inConfig: true,
    enabled: true,
    provider: null,
    model: null,
    threads: [],
    helpers: [],
    tasks: [],
    ...partial,
  };
}

function makeTask(
  id: number | string,
  role: string,
  title: string,
  status: TaskStatus,
  extra: Partial<TeamTask> = {},
): TeamTask {
  return {
    id,
    role,
    title,
    status,
    note: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...extra,
  };
}

function makeSnapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    projectId: "proj_1",
    projectName: "demo",
    team: "main",
    teamTitle: "Development team",
    teams: ["main"],
    versioned: false,
    versioningBlocked: false,
    configSource: null,
    configError: null,
    leadRole: "lead",
    paused: false,
    generatedAtMs: 0,
    roles: [],
    ...overrides,
  };
}

function render(snapshot: TeamSnapshot, language: Language = "en") {
  return renderSlot({ component: TeamOverview }, { snapshot, language }, {});
}

describe("TeamOverview: рабочее состояние команды", () => {
  it("показывает рабочую роль и задачу", () => {
    const snapshot = makeSnapshot({
      roles: [
        makeRole("developer", {
          title: "Developer",
          threads: [makeThread("thr_d", "active")],
          tasks: [makeTask(7, "developer", "Login form", "in-progress")],
          executionState: {
            kind: "working",
            taskId: 7,
            errorCode: null,
            safeAction: null,
            atMs: 0,
          },
        }),
      ],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Working")).toBeTruthy();
    expect(slot.getByText(/#7 Login form/)).toBeTruthy();
  });

  it("показывает ожидание без выдуманной активности", () => {
    const snapshot = makeSnapshot({
      roles: [
        makeRole("developer", {
          tasks: [makeTask(8, "developer", "Profile page", "todo")],
          executionState: {
            kind: "waiting",
            taskId: null,
            errorCode: "session_missing",
            safeAction: null,
            atMs: 0,
          },
        }),
      ],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Waiting")).toBeTruthy();
    expect(slot.queryByText("Working")).toBeNull();
  });

  it("нужно решение по приёмке", () => {
    const snapshot = makeSnapshot({
      roles: [
        makeRole("lead", {
          lead: true,
          tasks: [makeTask(9, "lead", "Review feature", "review")],
          executionState: {
            kind: "awaiting-acceptance",
            taskId: 9,
            errorCode: null,
            safeAction: null,
            atMs: 0,
          },
        }),
      ],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Needs decision")).toBeTruthy();
    expect(slot.getByText(/#9 Review feature/)).toBeTruthy();
  });

  it("показывает ошибку с причиной и безопасным действием", () => {
    const snapshot = makeSnapshot({
      roles: [
        makeRole("developer", {
          tasks: [makeTask(7, "developer", "Login form", "in-progress")],
          executionState: {
            kind: "error",
            taskId: 7,
            errorCode: "spawn_uncertain",
            errorMessage: "The host disconnected during creation.",
            safeAction: "Inspect the prepared candidate before retrying.",
            atMs: 0,
          },
        }),
      ],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Needs attention")).toBeTruthy();
    expect(slot.getByText("Cause and next action")).toBeTruthy();
    expect(slot.getByText(/The host disconnected during creation\./)).toBeTruthy();
    expect(slot.getByText(/Inspect the prepared candidate before retrying\./)).toBeTruthy();
  });

  it("проблемы привязки сессий требуют решения и считаются кратко", () => {
    const snapshot = makeSnapshot({
      bindingIssues: [
        { role: "tester", currentThreadId: "old", candidates: ["fresh"], state: "repairable" },
        { role: "qa", currentThreadId: "old2", candidates: [], state: "missing" },
      ],
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Needs decision")).toBeTruthy();
    expect(slot.getByText(/session recovery: 2/)).toBeTruthy();
  });
});

describe("TeamOverview: категории ограничений", () => {
  it("удержание по квоте провайдера", () => {
    const snapshot = makeSnapshot({
      resources: makeResources({
        quotaBlocks: [{ provider: "pi", hostId: null, resetAtMs: null }],
      }),
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot);
    expect(slot.getByText("quota: provider quota held")).toBeTruthy();
  });

  it("исчерпанный бюджет эпика", () => {
    const epic: NonNullable<ResourceSummary["epic"]> = {
      id: "epic-1",
      used: 5,
      limit: 5,
      remaining: 0,
      blocked: "Epic budget exhausted (epic-1: 5/5); use Team → Epic budget for a human decision",
      revision: 1,
      sinceMs: 0,
      title: "Release profile",
      approvedScopeRevision: "abc123",
    };
    const snapshot = makeSnapshot({
      resources: makeResources({ epic }),
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot);
    expect(slot.getByText("budget: 5/5")).toBeTruthy();
    expect(slot.getByText(/remaining 0/)).toBeTruthy();
  });

  it("одновременные квота и несовпадение объёма", () => {
    const epic: NonNullable<ResourceSummary["epic"]> = {
      id: "epic-1",
      used: 0,
      limit: 5,
      remaining: 5,
      blocked: null,
      revision: 1,
      sinceMs: 0,
      title: "Release profile",
      approvedScopeRevision: "abc12345",
      observedScopeRevision: "def67890",
      scopeMismatch:
        "Epic scope changed since approval (approved abc12345, observed def67890); a human must approve the new revision",
    };
    const snapshot = makeSnapshot({
      resources: makeResources({
        epic,
        quotaBlocks: [{ provider: "pi", hostId: null, resetAtMs: null }],
      }),
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot);
    expect(slot.getByText("scope: scope changed since approval")).toBeTruthy();
    expect(slot.getByText("quota: provider quota held")).toBeTruthy();
    expect(slot.getByText(/Current scope — changed since approval, not approved/)).toBeTruthy();
  });
});

describe("TeamOverview: честный прогресс", () => {
  it("принятие подтверждается только записями трекера, а не счётчиком закрытых задач", () => {
    const epic: NonNullable<ResourceSummary["epic"]> = {
      id: "epic-1",
      used: 1,
      limit: 5,
      remaining: 4,
      blocked: null,
      revision: 1,
      sinceMs: 0,
      title: "Release profile",
      approvedScopeRevision: "abc123",
      criteria: "Two accepted tasks",
      progress: { total: 1, done: 1, accepted: 1, review: 0, working: 0, queued: 0 },
    };
    const snapshot = makeSnapshot({
      resources: makeResources({
        epic,
        results: {
          accepted: 1,
          review: 0,
          reports: 1,
          recent: [
            {
              id: 7,
              title: "Login form",
              result: "done",
              checks: [],
              acceptanceReason: "Accepted by the lead on the recorded report.",
            },
          ],
        },
      }),
      roles: [
        makeRole("developer", {
          tasks: [
            makeTask(7, "developer", "Login form", "done", {
              review: {
                version: 1,
                decisions: [
                  {
                    decision: "accept",
                    reason: "Accepted by the lead on the recorded report.",
                    decidedBy: "lead",
                    basis: "submission",
                    atMs: 0,
                  },
                ],
              },
            }),
          ],
        }),
      ],
    });
    const slot = render(snapshot);
    // Team-level done count is "closed", not "accepted".
    expect(slot.getByText(/closed 1/)).toBeTruthy();
    // Recorded acceptance comes only from the epic child progress.
    expect(slot.getByText(/1 accepted/)).toBeTruthy();
    expect(slot.getByText(/reports 1/)).toBeTruthy();
    expect(slot.getByText(/decisions 1/)).toBeTruthy();
    // Grounds come from the tracker record, not invented evidence.
    expect(slot.getByText(/Accepted by the lead on the recorded report\./)).toBeTruthy();
    expect(
      slot.getByText(
        /Closed tasks are recorded outcomes, not proof that epic criteria are met\./,
      ),
    ).toBeTruthy();
  });

  it("без эпика — краткая сводка команды", () => {
    const snapshot = makeSnapshot({
      resources: makeResources(),
      roles: [
        makeRole("lead", { lead: true, threads: [makeThread("thr_l", "idle")] }),
        makeRole("developer", {
          threads: [makeThread("thr_d", "active")],
          tasks: [makeTask(7, "developer", "Login form", "in-progress")],
          executionState: {
            kind: "working",
            taskId: 7,
            errorCode: null,
            safeAction: null,
            atMs: 0,
          },
        }),
      ],
    });
    const slot = render(snapshot);
    expect(slot.getByText(/No active epic; existing package limits apply\./)).toBeTruthy();
    expect(slot.getByText(/2 roles/)).toBeTruthy();
    expect(slot.getByText(/1 working/)).toBeTruthy();
    expect(slot.getByText(/Tokens and money: unknown/)).toBeTruthy();
  });
});

describe("TeamOverview: расписание и очередь", () => {
  it("показывает источник очереди и статус доставки, не превращая пустой sendAt в epoch 0", () => {
    const continuations: ContinuationView[] = [
      {
        role: "developer",
        threadId: "thr_d",
        taskId: 7,
        sendAt: 1700000000000,
        stage: "needs-decision",
        queuedMessageId: null,
        queueState: null,
        queueSendAt: null,
        source: "bb-queue",
        reason: "Queue state unknown; inspect the native queue",
      },
    ];
    const snapshot = makeSnapshot({
      continuations,
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot);
    expect(slot.getByText("Scheduled / queue")).toBeTruthy();
    expect(slot.getByText(/needs decision/)).toBeTruthy();
    expect(slot.getByText(/BB queue/)).toBeTruthy();
    expect(slot.getByText("delivery: scheduled delivery needs a decision")).toBeTruthy();
    // Planned time is visible by default: the intent reference, not epoch 0.
    expect(slot.getByText(/intent/)).toBeTruthy();
    expect(slot.queryByText(/1970/)).toBeNull();
    // Raw technical codes live behind the details, not in the default view.
    expect(slot.getByText(/stage: needs-decision/)).toBeTruthy();
    expect(slot.getByText(/source: bb-queue/)).toBeTruthy();
  });
});

describe("TeamOverview: локализация", () => {
  it("пауза и сводка без эпика на русском", () => {
    const snapshot = makeSnapshot({
      paused: true,
      resources: makeResources(),
      roles: [makeRole("developer")],
    });
    const slot = render(snapshot, "ru");
    expect(slot.getByText("пауза")).toBeTruthy();
    expect(slot.getByText(/Активного эпика нет/)).toBeTruthy();
  });
});


it("does not present an unavailable tracker scope as freshly approved",()=>{
 const snapshot=makeSnapshot({resources:makeResources({epic:{id:"epic",title:"Goal",limit:10,used:1,remaining:9,revision:1,sinceMs:0,approvedScopeRevision:"saved",observedScopeRevision:"saved",blocked:"Epic scope held: Beads unavailable"}})});
 const s=render(snapshot);expect(s.getByText(/Requirements unavailable/)).toBeTruthy();expect(s.queryByText("Approved scope")).toBeNull();expect(s.getByText(/requirements could not be verified/)).toBeTruthy();
});
