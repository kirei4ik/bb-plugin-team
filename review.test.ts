// bbt-iwi.2 — pure tests for the verifiable-acceptance backend: submission
// schemas (server stamps, result XOR notApplicable), append-only merge with
// explicit limits, and the acceptance gates per caller class (executor /
// lead / manual). No SDK, no AI.

import { describe, expect, it } from "vitest";
import {
  DECISIONS_HARD_LIMIT,
  REVIEW_RECORD_MAX_BYTES,
  acceptanceGate,
  latestDecision,
  mergeReviewRecord,
  normalizeReviewRecord,
  reviewCheckSchema,
  reviewRecordDamage,
  reviewSubmissionInputSchema,
  type AcceptanceGateInput,
  type TaskReviewRecord,
} from "./review";

const STAMP = { id: "sub_stamp1", submittedBy: "tester" };
const NOW = 1_700_000_000_000;

const submissionJson = JSON.stringify({
  result: "Collected the provider list",
  artifacts: ["docs/providers.md"],
  checks: [{ what: "Compared with the docs", result: "3 providers match" }],
  problems: ["one provider undocumented"],
});

const gate = (patch: Partial<AcceptanceGateInput>) =>
  acceptanceGate({
    caller: "executor",
    callerRole: "tester",
    from: "in-progress",
    to: undefined,
    record: undefined,
    submission: undefined,
    acceptReason: undefined,
    returnReason: undefined,
    stamp: STAMP,
    nowMs: NOW,
    expectedSubmissionId: patch.caller === "lead" ? patch.record?.submission?.id : undefined,
    ...patch,
  });

const storedRecord = (submissionId = "sub_stamp1"): TaskReviewRecord => ({
  version: 1,
  submission: {
    id: submissionId,
    version: 1,
    result: "Implemented the feature",
    artifacts: [],
    checks: [{ what: "Targeted test", result: "pass" }],
    problems: [],
    submittedBy: "developer",
    atMs: NOW - 1000,
  },
  decisions: [],
});

describe("review schemas (bbt-iwi.2)", () => {
  it("rejects caller-supplied stamps: id, submittedBy, atMs are server-only", () => {
    const forged = JSON.parse(submissionJson) as Record<string, unknown>;
    forged.id = "sub_forged";
    forged.atMs = 5;
    forged.submittedBy = "lead";
    expect(reviewSubmissionInputSchema.safeParse(forged).success).toBe(false);
    expect(reviewSubmissionInputSchema.safeParse(JSON.parse(submissionJson)).success).toBe(true);
  });

  it("a check is result XOR notApplicable; a justification is required for N/A", () => {
    expect(reviewCheckSchema.safeParse({ what: "x", result: "pass" }).success).toBe(true);
    expect(reviewCheckSchema.safeParse({ what: "x", notApplicable: "docs-only task" }).success).toBe(true);
    expect(
      reviewCheckSchema.safeParse({ what: "x", result: "pass", notApplicable: "why" }).success,
    ).toBe(false);
    expect(reviewCheckSchema.safeParse({ what: "x", result: "" }).success).toBe(false);
    expect(reviewCheckSchema.safeParse({ what: "x", notApplicable: "" }).success).toBe(false);
    expect(reviewCheckSchema.safeParse({ what: "x" }).success).toBe(false);
  });
});

describe("merge and normalize (append-only, explicit limits)", () => {
  it("appends decisions, replaces submissions, and never deletes old decisions", () => {
    let record = mergeReviewRecord(undefined, { submission: storedRecord().submission });
    record = mergeReviewRecord(record, {
      decision: { decision: "changes-requested", reason: "fix the edge case", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW },
    });
    record = mergeReviewRecord(record, {
      decision: { decision: "accept", reason: "fixed and re-tested", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW + 1 },
    });
    expect(record.decisions.map((d) => d.decision)).toEqual(["changes-requested", "accept"]);
    // A re-submitted report replaces the submission; decisions keep their refs.
    record = mergeReviewRecord(record, { submission: { ...storedRecord("sub_new").submission!, id: "sub_new" } });
    expect(record.submission?.id).toBe("sub_new");
    expect(record.decisions[0]!.submissionRef).toBe("sub_stamp1");
  });

  it("rejects an oversized or over-long append instead of truncating", () => {
    const big = storedRecord();
    big.submission!.result = "x".repeat(8000);
    big.submission!.problems = Array.from({ length: 50 }, (_, i) => `p${i}`.repeat(40));
    expect(() => mergeReviewRecord(big, { submission: big.submission })).not.toThrow();
    const record: TaskReviewRecord = { ...storedRecord(), decisions: [] };
    for (let i = 0; i < DECISIONS_HARD_LIMIT; i += 1) {
      record.decisions.push({ decision: "accept", reason: `r${i}`, decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW });
    }
    expect(() =>
      mergeReviewRecord(record, { decision: { decision: "accept", reason: "one more", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW } }),
    ).toThrow(/acceptance history is full/);
    const wide: TaskReviewRecord = {
      version: 1,
      submission: {
        id: "s", version: 1, result: "r".repeat(8000), artifacts: Array.from({ length: 50 }, () => "a".repeat(2000)),
        checks: Array.from({ length: 100 }, () => ({ what: "w".repeat(2000), result: "r".repeat(8000) })),
        problems: [], submittedBy: "dev", atMs: NOW,
      },
      decisions: [],
    };
    expect(() => mergeReviewRecord(wide, {})).toThrow(/does not fit the tracker row/);
  });

  it("normalize keeps valid old data and drops junk pieces", () => {
    const record = storedRecord();
    record.decisions.push({ decision: "accept", reason: "ok", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: 1 });
    const normalized = normalizeReviewRecord({ ...record, decisions: [...record.decisions, { garbage: true }] })!;
    expect(normalized.decisions).toHaveLength(1);
    expect(normalized.submission?.id).toBe("sub_stamp1");
    expect(normalizeReviewRecord({ decisions: [] })).toBeUndefined();
    expect(normalizeReviewRecord("junk")).toBeUndefined();
  });
});

describe("acceptance gate: review entry", () => {
  it("an executor needs a grounded submission; the server stamps it", () => {
    const fail = gate({ to: "review" });
    expect(fail).toEqual({ ok: false, code: "review_submission_required" });
    const ok = gate({ to: "review", submission: submissionJson });
    if (!ok.ok || !ok.submission) throw new Error("expected ok");
    expect(ok.submission.id).toBe("sub_stamp1");
    expect(ok.submission.submittedBy).toBe("tester");
    expect(ok.submission.atMs).toBe(NOW);
  });

  it("a stored submission satisfies review entry without a new one", () => {
    expect(gate({ to: "review", record: storedRecord() })).toEqual({ ok: true });
  });

  it("an invalid provided submission is rejected for every caller", () => {
    expect(gate({ to: "review", submission: { result: "no checks", checks: [] } })).toEqual({
      ok: false,
      code: "review_submission_required",
    });
    expect(gate({ caller: "manual", to: "review", submission: "{invalid json" })).toEqual({
      ok: false,
      code: "review_submission_required",
    });
  });

  it("the manual path may place a package into review by hand", () => {
    expect(gate({ caller: "manual", callerRole: null, to: "review" })).toEqual({ ok: true });
  });
});

describe("acceptance gate: done (all transitions)", () => {
  it("executors never accept — not even with a reason", () => {
    expect(gate({ to: "done", acceptReason: "looks fine" })).toEqual({ ok: false, code: "only_lead_accepts" });
  });

  it("the lead needs both a grounded report and a reason; no direct close bypass", () => {
    // in-progress → done and todo → done are gated the same way.
    expect(gate({ caller: "lead", callerRole: "lead", to: "done", acceptReason: "fine" })).toEqual({
      ok: false,
      code: "review_submission_required",
    });
    expect(gate({ caller: "lead", callerRole: "lead", from: "todo", to: "done", acceptReason: "fine" })).toEqual({
      ok: false,
      code: "review_submission_required",
    });
    expect(gate({ caller: "lead", callerRole: "lead", to: "done" })).toEqual({
      ok: false,
      code: "acceptance_reason_required",
    });
    const ok = gate({ caller: "lead", callerRole: "lead", to: "done", record: storedRecord(), acceptReason: "tests pass, diff reviewed" });
    if (!ok.ok || !ok.decision) throw new Error("expected ok");
    expect(ok.decision.decidedBy).toBe("lead");
    expect(ok.decision.basis).toBe("submission");
    expect(ok.decision.submissionRef).toBe("sub_stamp1");
  });

  it("the manual path always needs a reason; grounding on a report requires an explicit expected id", () => {
    expect(gate({ caller: "manual", callerRole: null, to: "done" })).toEqual({
      ok: false,
      code: "acceptance_reason_required",
    });
    const reportless = gate({ caller: "manual", callerRole: null, to: "done", acceptReason: "I reviewed the result myself" });
    if (!reportless.ok || !reportless.decision) throw new Error("expected ok");
    expect(reportless.decision.decidedBy).toBe("manual");
    expect(reportless.decision.basis).toBe("manual");
    expect(reportless.decision.submissionRef ?? null).toBeNull();
    // A stored report alone does not ground a manual accept — only the
    // explicit expectedSubmissionId reference does (stale-UI protection).
    const ungrounded = gate({ caller: "manual", callerRole: null, to: "done", record: storedRecord(), acceptReason: "report matches the diff" });
    if (!ungrounded.ok || !ungrounded.decision) throw new Error("expected ok");
    expect(ungrounded.decision.basis).toBe("manual");
    expect(ungrounded.decision.submissionRef ?? null).toBeNull();
    const grounded = gate({ caller: "manual", callerRole: null, to: "done", record: storedRecord(), acceptReason: "report matches the diff", expectedSubmissionId: "sub_stamp1" });
    if (!grounded.ok || !grounded.decision) throw new Error("expected ok");
    expect(grounded.decision.basis).toBe("submission");
    expect(grounded.decision.submissionRef).toBe("sub_stamp1");
  });

  it("a mismatching expectedSubmissionId is a conflict with no writes", () => {
    // Matching expectation passes and grounds the decision.
    const ok = gate({ caller: "lead", callerRole: "lead", to: "done", record: storedRecord(), acceptReason: "I reviewed this report", expectedSubmissionId: "sub_stamp1" });
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.decision?.submissionRef).toBe("sub_stamp1");
    // The report was rewritten after it was reviewed: stale acceptance is a conflict.
    const rewritten: TaskReviewRecord = { ...storedRecord(), submission: { ...storedRecord().submission!, id: "sub_stamp2" } };
    expect(gate({ caller: "lead", callerRole: "lead", to: "done", record: rewritten, acceptReason: "I reviewed report A", expectedSubmissionId: "sub_stamp1" })).toEqual({
      ok: false,
      code: "submission_conflict",
    });
    // Expecting a report where none is stored is a conflict too.
    expect(gate({ caller: "manual", callerRole: null, to: "done", acceptReason: "x", expectedSubmissionId: "sub_stamp1" })).toEqual({
      ok: false,
      code: "submission_conflict",
    });
  });

  it("a recorded accept closes the task only while it still grounds on the stored submission", () => {
    const accepted: TaskReviewRecord = {
      ...storedRecord(),
      decisions: [
        { decision: "accept", reason: "checked", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW - 500 },
      ],
    };
    // Same submission: idempotent close, no second decision.
    expect(gate({ caller: "lead", callerRole: "lead", to: "done", record: accepted })).toEqual({ ok: true });
    // The report was rewritten since the accept: the old accept no longer grounds.
    const rewritten: TaskReviewRecord = { ...accepted, submission: { ...accepted.submission!, id: "sub_stamp2" } };
    expect(gate({ caller: "lead", callerRole: "lead", to: "done", record: rewritten })).toEqual({
      ok: false,
      code: "acceptance_reason_required",
    });
  });

  it("done → done is idempotent: a repeated reason does not append a second decision", () => {
    const accepted: TaskReviewRecord = {
      ...storedRecord(),
      decisions: [
        { decision: "accept", reason: "checked", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW - 500 },
      ],
    };
    const repeat = gate({ caller: "lead", callerRole: "lead", from: "done", to: "done", record: accepted, acceptReason: "checked again" });
    expect(repeat).toEqual({ ok: true });
  });
});

describe("acceptance gate: return from review", () => {
  it("the lead and the manual path need a concrete remark; an executor withdraws without a decision", () => {
    expect(gate({ caller: "lead", callerRole: "lead", from: "review", to: "todo" })).toEqual({
      ok: false,
      code: "return_reason_required",
    });
    expect(gate({ caller: "manual", callerRole: null, from: "review", to: "todo" })).toEqual({
      ok: false,
      code: "return_reason_required",
    });
    const ok = gate({
      caller: "lead", callerRole: "lead", from: "review", to: "todo",
      record: storedRecord(), returnReason: "the edge case at line 3 is not covered",
    });
    if (!ok.ok || !ok.decision) throw new Error("expected ok");
    expect(ok.decision.decision).toBe("changes-requested");
    expect(ok.decision.reason).toContain("edge case");
    expect(gate({ from: "review", to: "todo" })).toEqual({ ok: true });
  });

  it("executors never record acceptance decisions on record-only updates", () => {
    expect(gate({ to: undefined, acceptReason: "self-accept" })).toEqual({ ok: false, code: "only_lead_accepts" });
    expect(gate({ to: undefined, returnReason: "self-return" })).toEqual({ ok: false, code: "only_lead_accepts" });
  });

  it("an identical retry after a failed status update appends no second decision", () => {
    const accepted: TaskReviewRecord = {
      ...storedRecord(),
      decisions: [
        { decision: "accept", reason: "checked the diff", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: NOW - 500 },
      ],
    };
    const retry = gate({ caller: "lead", callerRole: "lead", from: "review", to: "done", record: accepted, acceptReason: "checked the diff" });
    expect(retry).toEqual({ ok: true });
    const newGrounds = gate({ caller: "lead", callerRole: "lead", from: "review", to: "done", record: accepted, acceptReason: "re-checked after fixes" });
    if (!newGrounds.ok || !newGrounds.decision) throw new Error("expected ok");
    expect(newGrounds.decision.reason).toBe("re-checked after fixes");
  });

  it("reviewRecordDamage refuses to overwrite unsupported stored pieces", () => {
    const record = storedRecord();
    expect(reviewRecordDamage(record)).toBeNull();
    expect(reviewRecordDamage(undefined)).toBeNull();
    expect(reviewRecordDamage({ submission: { no: "id" }, decisions: [] })).toMatch(/submission/);
    expect(reviewRecordDamage({ decisions: [{ garbage: true }] })).toMatch(/1 decision/);
    expect(reviewRecordDamage({ decisions: "no" })).toMatch(/not a list/);
  });

  it("latestDecision reflects the newest entry", () => {
    const record = mergeReviewRecord(storedRecord(), {
      decision: { decision: "changes-requested", reason: "fix", decidedBy: "lead", basis: "submission", submissionRef: "sub_stamp1", atMs: 1 },
    });
    expect(latestDecision(record)?.decision).toBe("changes-requested");
  });

  it("REVIEW_RECORD_MAX_BYTES budget is enforced on merge, not silently trimmed", () => {
    expect(REVIEW_RECORD_MAX_BYTES).toBe(65536);
  });
});
