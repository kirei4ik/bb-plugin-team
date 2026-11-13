// bbt-iwi.2 — server-level acceptance flow with the fake plugin host: the
// executor's grounded review submission, lead acceptance with a reason,
// manual acceptance, returns with a remark, and the non-accepter callers
// (helpers, threads of another team). No model calls; the built-in tracker
// and BB threads are deterministic SDK fixtures.

import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const CONFIG = `
version: 1
roles:
  - name: lead
    title: Lead
    lead: true
    prompt: Coordinate the work.
  - name: tester
    title: Tester
    prompt: Test the package.
`;

interface FakeThread {
  id: string;
  role: string | null;
  team?: string;
  projectId?: string;
  helperOf?: string;
  status: string;
  parentThreadId: string | null;
  providerId: string;
  title: string;
  archivedAt: number | null;
  notifyOn: string[];
}

function makeHost(threads: Array<Partial<FakeThread> & { id: string }>) {
  const map = new Map<string, FakeThread>();
  for (const thread of threads) {
    map.set(thread.id, {
      role: null,
      status: "idle",
      parentThreadId: "thr_lead",
      providerId: "pi",
      title: thread.id,
      archivedAt: null,
      notifyOn: [],
      ...thread,
    });
  }
  const files = new Map<string, string>([["/ws/demo/.bb/team.yaml", CONFIG]]);
  const toResponse = (thread: FakeThread) =>
    makeThreadResponse({
      id: thread.id,
      projectId: thread.projectId ?? "proj_1",
      status: thread.status as "idle",
      parentThreadId: thread.parentThreadId,
      providerId: thread.providerId,
      title: thread.title,
      archivedAt: thread.archivedAt,
      environmentId: "env_1",
      queuedMessageCount: 0,
      updatedAt: Date.now() - 60_000,
    });
  const metadataOf = (thread: FakeThread): Record<string, unknown> =>
    thread.role
      ? { teamRole: thread.role, ...(thread.team ? { teamName: thread.team } : {}) }
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
    settings: { defaultTracker: "builtin" },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      projects: { list: async () => [project("proj_1", "demo", "/ws/demo")] },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return { content, sha256: "x" };
        },
      },
      environments: {
        list: async () => [
          { id: "env_1", projectId: "proj_1", hostId: "host_1", status: "ready", environmentProviderId: "project-checkout" },
        ],
        get: async () => ({ id: "env_1", hostId: "host_1", path: "/ws/demo", status: "ready" }),
      },
      providers: { list: async () => [{ id: "pi", available: true }] },
      threads: {
        list: async ({ offset }: { offset?: number } = {}) =>
          (offset ?? 0) > 0 ? [] : [...map.values()].map(toResponse),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds
            .map((id) => map.get(id))
            .filter((thread): thread is FakeThread => !!thread)
            .map((thread) => ({ threadId: thread.id, metadata: metadataOf(thread) })),
        }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          const thread = map.get(threadId);
          return thread ? metadataOf(thread) : {};
        },
        get: async ({ threadId }: { threadId: string }) => {
          const thread = map.get(threadId);
          if (!thread) throw new Error("404");
          return toResponse(thread);
        },
        send: async () => ({ ok: true, delivery: "sent" }),
        output: async () => ({ output: "done" }),
      },
    },
  });
  return { bb, harness };
}

const THREADS = [
  { id: "thr_lead", role: "lead", parentThreadId: null },
  { id: "thr_test", role: "tester" },
  { id: "thr_helper", helperOf: "lead" },
  { id: "thr_other", role: "lead", team: "other" },
  // A lead of another project with the same team name: a foreign agent.
  { id: "thr_foreign", role: "lead", projectId: "proj_2" },
];

const REVIEW_JSON = JSON.stringify({
  result: "Smoke checks collected",
  artifacts: ["docs/smoke.md"],
  checks: [
    { what: "Compared with the source", result: "matches" },
    { what: "Code test", notApplicable: "docs-only package" },
  ],
  problems: ["one section still thin"],
});

type Task = {
  id: number;
  status: string;
  review?: {
    submission?: { id: string; submittedBy: string | null };
    decisions?: Array<{ decision: string; reason: string; decidedBy: string; basis: string; submissionRef?: string | null }>;
  };
};

const listTasks = async (harness: ReturnType<typeof makeHost>["harness"]) => {
  const result = await harness.behavior.runCli(["task", "list", "--all", "--json", "--project", "demo", "--team", "main"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).tasks as Task[];
};

describe("verifiable acceptance flow (bbt-iwi.2)", () => {
  it("executor reports with grounds, lead accepts with a reason, manual path stays explicit", async () => {
    const { bb, harness } = makeHost(THREADS);
    await plugin(bb);
    const as = (threadId: string) => ({ projectId: "proj_1", threadId });
    const cli = (args: string[], ctx?: { projectId: string; threadId: string }) =>
      harness.behavior.runCli([...args, "--project", "demo", "--team", "main"], ctx);

    await cli(["task", "add", "tester", "Smoke package"]);
    // Executor cannot enter review without a grounded report.
    const bare = await cli(["task", "update", "1", "--status", "review"], as("thr_test"));
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr).toContain("grounded review report");
    // Server-stamped submission enters review.
    const review = await cli(["task", "update", "1", "--status", "review", "--review", REVIEW_JSON], as("thr_test"));
    expect(review.exitCode, review.stderr).toBe(0);
    let [task] = await listTasks(harness);
    expect(task.status).toBe("review");
    expect(task.review?.submission?.submittedBy).toBe("tester");
    expect(task.review?.submission?.id).toMatch(/^sub_/);
    const submissionId = task.review!.submission!.id;
    // Executor never accepts.
    const self = await cli(["task", "done", "1"], as("thr_test"));
    expect(self.exitCode).not.toBe(0);
    expect(self.stderr).toContain("only the lead accepts");
    // Lead needs a reason even with a grounded report on the task.
    const bareAccept = await cli(["task", "done", "1"], as("thr_lead"));
    expect(bareAccept.exitCode).not.toBe(0);
    expect(bareAccept.stderr).toContain("needs grounds");
    const accepted = await cli(["task", "done", "1", "--reason", "report matches the diff and the N/A is justified", "--expected-submission", submissionId], as("thr_lead"));
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    [task] = await listTasks(harness);
    expect(task.status).toBe("done");
    expect(task.review?.decisions).toEqual([
      expect.objectContaining({
        decision: "accept",
        decidedBy: "lead",
        basis: "submission",
        submissionRef: submissionId,
      }),
    ]);
    // A repeated accept (double click) does not append a second decision.
    const repeat = await cli(["task", "done", "1", "--reason", "checked again", "--expected-submission", submissionId], as("thr_lead"));
    expect(repeat.exitCode, repeat.stderr).toBe(0);
    [task] = await listTasks(harness);
    expect(task.review?.decisions).toHaveLength(1);
  });

  it("return from review needs a concrete remark; the manual path needs a reason too", async () => {
    const { bb, harness } = makeHost(THREADS);
    await plugin(bb);
    const as = (threadId: string) => ({ projectId: "proj_1", threadId });
    const cli = (args: string[], ctx?: { projectId: string; threadId: string }) =>
      harness.behavior.runCli([...args, "--project", "demo", "--team", "main"], ctx);

    await cli(["task", "add", "tester", "Second package"]);
    await cli(["task", "update", "1", "--status", "review", "--review", REVIEW_JSON], as("thr_test"));
    const returningSubmissionId = (await listTasks(harness))[0]!.review!.submission!.id;
    // Lead return without a remark is refused.
    const bare = await cli(["task", "update", "1", "--status", "todo"], as("thr_lead"));
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr).toContain("concrete remark");
    const returned = await cli(["task", "update", "1", "--status", "todo", "--return-reason", "the N/A needs the package scope as justification", "--expected-submission", returningSubmissionId], as("thr_lead"));
    expect(returned.exitCode, returned.stderr).toBe(0);
    let [task] = await listTasks(harness);
    expect(task.status).toBe("todo");
    expect(task.review?.decisions?.[0]).toEqual(
      expect.objectContaining({ decision: "changes-requested", decidedBy: "lead" }),
    );
    // The executor resubmits; the manual path without a reason is refused.
    await cli(["task", "update", "1", "--status", "review", "--review", REVIEW_JSON], as("thr_test"));
    const bareManual = await cli(["task", "done", "1"]);
    expect(bareManual.exitCode).not.toBe(0);
    expect(bareManual.stderr).toContain("needs grounds");
    const manual = await cli(["task", "done", "1", "--reason", "I reviewed the result myself"]);
    expect(manual.exitCode, manual.stderr).toBe(0);
    [task] = await listTasks(harness);
    // Without an explicit expected id the stored report does not ground a
    // manual accept: it stays an explicit manual override.
    expect(task.review?.decisions?.at(-1)).toEqual(
      expect.objectContaining({ decision: "accept", decidedBy: "manual", basis: "manual" }),
    );
    // Reopen, then ground explicitly on the reviewed report id.
    const reopened = await cli(["task", "update", "1", "--status", "review"]);
    expect(reopened.exitCode, reopened.stderr).toBe(0);
    const submissionId = (await listTasks(harness))[0]!.review!.submission!.id;
    const grounded = await cli(["task", "done", "1", "--reason", "the report matches the diff", "--expected-submission", submissionId]);
    expect(grounded.exitCode, grounded.stderr).toBe(0);
    [task] = await listTasks(harness);
    expect(task.review?.decisions?.at(-1)).toEqual(
      expect.objectContaining({ decision: "accept", decidedBy: "manual", basis: "submission", submissionRef: submissionId }),
    );
  });

  it("no direct close bypass: manual overrides without a report are explicit; helpers and other teams never accept", async () => {
    const { bb, harness } = makeHost(THREADS);
    await plugin(bb);
    const as = (threadId: string) => ({ projectId: "proj_1", threadId });
    const cli = (args: string[], ctx?: { projectId: string; threadId: string }) =>
      harness.behavior.runCli([...args, "--project", "demo", "--team", "main"], ctx);

    // The lead cannot close a package that never got a grounded report.
    await cli(["task", "add", "tester", "Unreported package"]);
    const leadBypass = await cli(["task", "done", "1", "--reason", "trust me"], as("thr_lead"));
    expect(leadBypass.exitCode).not.toBe(0);
    expect(leadBypass.stderr).toContain("grounded review report");
    // The manual path may accept without a report — but only with a reason,
    // and the decision is recorded as an explicit manual override.
    const manual = await cli(["task", "done", "1", "--reason", "trivial errand, verified directly"]);
    expect(manual.exitCode, manual.stderr).toBe(0);
    const [task] = await listTasks(harness);
    const decision = task.review?.decisions?.[0];
    expect(decision).toEqual(
      expect.objectContaining({ decision: "accept", decidedBy: "manual", basis: "manual" }),
    );
    expect(decision?.submissionRef ?? null).toBeNull();
    // A helper of the lead is not the lead.
    await cli(["task", "add", "tester", "Helper package"]);
    const helper = await cli(["task", "done", "2", "--reason", "as the lead's helper"], as("thr_helper"));
    expect(helper.exitCode).not.toBe(0);
    expect(helper.stderr).toContain("only the lead accepts");
    // A thread marked as a lead of another team is an agent here, not the user.
    await cli(["task", "add", "tester", "Cross-team package"]);
    const other = await cli(["task", "done", "3", "--reason", "other team's lead"], as("thr_other"));
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr).toContain("only the lead accepts");
  });

  it("a stale expected id is a conflict without writes; a foreign project's lead never accepts here", async () => {
    const { bb, harness } = makeHost(THREADS);
    await plugin(bb);
    const as = (threadId: string) => ({ projectId: "proj_1", threadId });
    const cli = (args: string[], ctx?: { projectId: string; threadId: string }) =>
      harness.behavior.runCli([...args, "--project", "demo", "--team", "main"], ctx);

    await cli(["task", "add", "tester", "Rewritten package"]);
    await cli(["task", "update", "1", "--status", "review", "--review", REVIEW_JSON], as("thr_test"));
    const firstId = (await listTasks(harness))[0]!.review!.submission!.id;
    // The executor rewrites the report after the lead already opened it.
    const rewritten = JSON.stringify({ ...JSON.parse(REVIEW_JSON), result: "Rewritten result" });
    await cli(["task", "update", "1", "--status", "review", "--review", rewritten], as("thr_test"));
    const secondId = (await listTasks(harness))[0]!.review!.submission!.id;
    expect(secondId).not.toBe(firstId);
    // Accepting the stale view is a conflict; nothing is written.
    const stale = await cli(["task", "done", "1", "--reason", "reviewed the first report", "--expected-submission", firstId], as("thr_lead"));
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain("review report changed");
    let [task] = await listTasks(harness);
    expect(task.status).toBe("review");
    expect(task.review?.decisions ?? []).toHaveLength(0);
    // Grounding on the current report id accepts cleanly.
    const fresh = await cli(["task", "done", "1", "--reason", "reviewed the rewritten report", "--expected-submission", secondId], as("thr_lead"));
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    [task] = await listTasks(harness);
    expect(task.review?.decisions?.[0]).toEqual(
      expect.objectContaining({ decision: "accept", decidedBy: "lead", submissionRef: secondId }),
    );
    // A lead of another project with the same team name is a foreign agent.
    await cli(["task", "add", "tester", "Foreign package"]);
    const foreign = await cli(["task", "done", "2", "--reason", "as the other project's lead"], as("thr_foreign"));
    expect(foreign.exitCode).not.toBe(0);
    expect(foreign.stderr).toContain("only the lead accepts");
  });
});
