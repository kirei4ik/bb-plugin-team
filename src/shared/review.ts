// bbt-iwi.2 — verifiable acceptance backend: the executor's review submission
// (result, artifacts, actual checks, remaining problems) and the lead's or
// the user's manual acceptance decisions (accept / changes-requested with a
// reason). Storage belongs to the selected tracker only — Beads issue
// metadata (merge keys bbTeamSubmission / bbTeamAcceptance) or the built-in
// task row; no duplicate kv record is kept.
//
// Honesty contract:
// - The gates are structural: a submission exists, every check has exactly
//   one of an actual result or a justified not-applicable, every decision
//   carries a non-empty reason. Presence of text is never proof a check ran;
//   a decision records WHO accepted on WHAT grounds — it does not certify
//   the truth of the reported checks. The UI says "accepted by the lead" or
//   "manual acceptance", never "verified".
// - The server stamps the actor and time: id/submittedBy/atMs in incoming
//   submission JSON are never trusted (the input schema rejects them).
// - A decision is bound to the id of the submission it grounds on; a
//   rewritten report never serves as the basis of an older accept.
// - Decisions are append-only; the limit is an explicit error, never a
//   silent truncation. Old valid data reads as-is; new transitions need new
//   grounds.

import { z } from "zod";
import type { TaskStatus } from "./snapshot";

/* ──────────────────────── Schemas ──────────────────────── */

const shortText = z.string().trim().min(1).max(2000);

/**
 * One actual check. Valid only with EXACTLY ONE of: a non-empty `result`, or
 * a `notApplicable` justification (allowed for genuinely non-programmatic
 * work). A failed or not-run check stays a result saying so — it is never
 * turned into a pass by these gates.
 */
export const reviewCheckSchema = z
  .object({
    what: shortText,
    result: z.string().trim().max(8000).nullable().optional(),
    notApplicable: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    const result = check.result ?? "";
    const notApplicable = check.notApplicable ?? "";
    if (result && notApplicable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result and notApplicable are mutually exclusive",
      });
    } else if (!result && !notApplicable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "each check needs an actual result or a justified notApplicable",
      });
    }
  });
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;

/**
 * What a caller may send for --review. Strict on purpose: id, submittedBy and
 * atMs from the client are rejected — the server stamps the actor and time.
 */
export const reviewSubmissionInputSchema = z
  .object({
    result: z.string().trim().min(1).max(8000),
    artifacts: z.array(shortText).max(50).optional(),
    checks: z.array(reviewCheckSchema).min(1).max(100),
    problems: z.array(shortText).max(50).optional(),
  })
  .strict();
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionInputSchema>;

/** The stored, server-stamped submission. */
export const reviewSubmissionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    version: z.literal(1),
    result: z.string().trim().min(1).max(8000),
    artifacts: z.array(shortText).max(50).optional(),
    checks: z.array(reviewCheckSchema).min(1).max(100),
    problems: z.array(shortText).max(50).optional(),
    /** Server-stamped role name of the submitting caller; null when manual. */
    submittedBy: z.string().trim().max(100).nullable(),
    atMs: z.number(),
  })
  .strict();
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;

/** One acceptance decision: by the team's lead, or a manual one by the user. */
export const acceptanceDecisionSchema = z
  .object({
    decision: z.enum(["accept", "changes-requested"]),
    reason: z.string().trim().min(1).max(4000),
    /** "lead": the team's lead role; "manual": the explicit manual path (no team thread — not a proof of being human). */
    decidedBy: z.enum(["lead", "manual"]),
    /** "submission": grounded on the stored review report; "manual": explicit override without one. */
    basis: z.enum(["submission", "manual"]),
    decidedByRole: z.string().trim().max(100).nullable().optional(),
    /** Id of the stored submission this decision grounds on (accept decisions). */
    submissionRef: z.string().trim().max(100).nullable().optional(),
    atMs: z.number(),
  })
  .strict();
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;

/** Hard structural limit; the record must also fit the tracker row (≤64 KiB). */
export const DECISIONS_HARD_LIMIT = 100;
export const REVIEW_RECORD_MAX_BYTES = 65536;

/** Everything the task carries about review + acceptance (append-only). */
export interface TaskReviewRecord {
  version: 1;
  submission?: ReviewSubmission;
  decisions: AcceptanceDecision[];
}

/* ──────────────────────── Normalization / merge ──────────────────────── */

/**
 * Tolerant read of stored review data: invalid pieces are dropped, valid old
 * decisions and submissions always survive (nothing is deleted here).
 */
export function normalizeReviewRecord(raw: unknown): TaskReviewRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as {
    submission?: unknown;
    decisions?: unknown;
  };
  let submission: ReviewSubmission | undefined;
  const parsedSubmission = reviewSubmissionSchema.safeParse(value.submission);
  if (parsedSubmission.success) submission = parsedSubmission.data;
  const decisions: AcceptanceDecision[] = Array.isArray(value.decisions)
    ? value.decisions
        .map((decision) => acceptanceDecisionSchema.safeParse(decision))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data as AcceptanceDecision)
    : [];
  if (!submission && decisions.length === 0) return undefined;
  return { version: 1, submission, decisions };
}

/** Serialize the record; throws when it cannot fit a tracker row/metadata. */
export function reviewRecordBytes(record: TaskReviewRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/**
 * Merge a submission and/or a decision into the existing record. Append-only:
 * a valid new submission replaces the previous one (kept decisions keep their
 * submissionRef — an old accept never silently re-grounds on a new report),
 * decisions are appended and never removed. The record must stay within the
 * tracker row budget — an oversized append is an explicit error, never a
 * silent truncation.
 */
export function mergeReviewRecord(
  existing: TaskReviewRecord | undefined,
  patch: { submission?: unknown; decision?: unknown },
): TaskReviewRecord {
  const damage = reviewRecordDamage(existing);
  if (damage) throw new Error(damage);
  const base = existing ?? { version: 1 as const, decisions: [] };
  let submission = base.submission;
  if (patch.submission !== undefined && patch.submission !== null) {
    submission = reviewSubmissionSchema.parse(patch.submission);
  }
  const decisions = [...base.decisions];
  if (patch.decision !== undefined && patch.decision !== null) {
    const decision = acceptanceDecisionSchema.parse(patch.decision);
    if (decision.basis === "submission" && (!submission || decision.submissionRef !== submission.id)) {
      throw new Error("The reviewed report changed; refresh the task before deciding");
    }
    const latest = decisions.at(-1);
    const same = latest && latest.decision === decision.decision && latest.reason === decision.reason &&
      latest.decidedBy === decision.decidedBy && latest.basis === decision.basis &&
      latest.decidedByRole === decision.decidedByRole && (latest.submissionRef ?? null) === (decision.submissionRef ?? null);
    if (!same) decisions.push(decision);
    if (decisions.length > DECISIONS_HARD_LIMIT) {
      throw new Error(
        `acceptance history is full (${DECISIONS_HARD_LIMIT} decisions); nothing more is appended — escalate to the user instead of resetting or rewriting history`,
      );
    }
  }
  const record: TaskReviewRecord = { version: 1, submission, decisions };
  const bytes = reviewRecordBytes(record);
  if (bytes > REVIEW_RECORD_MAX_BYTES) {
    throw new Error(
      `review record does not fit the tracker row (${bytes} > ${REVIEW_RECORD_MAX_BYTES} bytes); keep submissions concise`,
    );
  }
  return record;
}

/** The latest decision, if any (an older accept is superseded by a later return). */
export function latestDecision(
  record: TaskReviewRecord | undefined,
): AcceptanceDecision | null {
  return record?.decisions.at(-1) ?? null;
}

/**
 * bbt-iwi.2 integrity fix: describe pieces of a RAW stored record that the
 * tolerant read would drop. A damaged record must never be overwritten by a
 * later append — the caller refuses with this message instead, so the
 * original (possibly unsupported) history is preserved for a human decision.
 */
export function reviewRecordDamage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "the stored review record is malformed; refusing to overwrite it";
  const value = raw as {
    submission?: unknown;
    decisions?: unknown;
  };
  const damaged: string[] = [];
  if (value.submission !== undefined && value.submission !== null) {
    if (!reviewSubmissionSchema.safeParse(value.submission).success) {
      damaged.push("submission");
    }
  }
  if (value.decisions !== undefined && value.decisions !== null) {
    if (!Array.isArray(value.decisions)) {
      damaged.push("decisions (not a list)");
    } else {
      const invalid = value.decisions.filter(
        (decision) => !acceptanceDecisionSchema.safeParse(decision).success,
      ).length;
      if (invalid > 0) damaged.push(`${invalid} decision(s)`);
    }
  }
  return damaged.length > 0
    ? `the stored review record is damaged (${damaged.join(", ")}); refusing to overwrite it — escalate to the user instead of rewriting history`
    : null;
}

/* ──────────────────────── Acceptance gates ──────────────────────── */

/**
 * Who is asking. "lead": this team's lead role (a lead's helper is NOT the
 * lead). "executor": any other team-marked thread — including helpers and
 * threads marked for another team (an agent, not the user). "manual": no team
 * thread at all — the explicit manual path; it is the user's interface, not a
 * proof that a human acted.
 */
export type AcceptanceCaller = "executor" | "lead" | "manual";

/** Server stamps for the submission of this call (id + actor come from the server). */
export interface SubmissionStamp {
  id: string;
  submittedBy: string | null;
}

export interface AcceptanceGateInput {
  caller: AcceptanceCaller;
  callerRole: string | null;
  from: TaskStatus;
  to: TaskStatus | undefined;
  /** Review data already stored on the task. */
  record: TaskReviewRecord | undefined;
  /** Submission supplied in this call (raw object/JSON string), if any. */
  submission: unknown;
  acceptReason: string | null | undefined;
  returnReason: string | null | undefined;
  /**
   * bbt-iwi.2 fix: the id of the submission the caller reviewed. When
   * given, it must match the submission stored after this call — a stale
   * UI/CLI view never auto-accepts a rewritten, unreviewed report. A manual
   * acceptance grounds on the report only through this explicit reference.
   */
  expectedSubmissionId: string | null | undefined;
  /** Server-generated stamp for this call's submission. */
  stamp: SubmissionStamp;
  nowMs: number;
}

export interface AcceptanceGateOk {
  ok: true;
  /** Submission to record (when supplied and valid, server-stamped). */
  submission?: ReviewSubmission;
  /** Decision to record (when the caller supplied grounds). */
  decision?: AcceptanceDecision;
}

export type AcceptanceGateErrorCode =
  | "review_submission_required"
  | "acceptance_reason_required"
  | "return_reason_required"
  | "submission_conflict"
  | "only_lead_accepts";

export type AcceptanceGateError = { ok: false; code: AcceptanceGateErrorCode };

const cleanReason = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
};

/**
 * Parse a client-supplied submission and stamp it with the server's actor and
 * time. Incoming id/submittedBy/atMs are rejected by the strict input schema —
 * the server never trusts caller-supplied stamps.
 */
const parseProvidedSubmission = (
  submission: unknown,
  stamp: SubmissionStamp,
  nowMs: number,
): { ok: true; submission: ReviewSubmission } | { ok: false } => {
  if (submission === undefined || submission === null || submission === "") {
    return { ok: false };
  }
  let value: unknown = submission;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false };
    }
  }
  const parsed = reviewSubmissionInputSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  return {
    ok: true,
    submission: {
      id: stamp.id,
      version: 1,
      ...parsed.data,
      submittedBy: stamp.submittedBy,
      atMs: nowMs,
    },
  };
};

/**
 * Basis of an accept decision: the lead always grounds on the required
 * report; the manual path grounds on the report only through an explicit
 * expectedSubmissionId reference — never an unfamiliar new report.
 */
const acceptBasis = (
  caller: AcceptanceCaller,
  currentSubmission: ReviewSubmission | undefined,
  expected: string | null,
): "submission" | "manual" => {
  if (!currentSubmission) return "manual";
  if (caller === "lead") return "submission";
  return expected === currentSubmission.id ? "submission" : "manual";
};

const decisionOf = (
  decision: "accept" | "changes-requested",
  reason: string,
  caller: AcceptanceCaller,
  callerRole: string | null,
  basis: "submission" | "manual",
  submission: ReviewSubmission | undefined,
  nowMs: number,
): AcceptanceDecision => ({
  decision,
  reason,
  decidedBy: caller === "lead" ? "lead" : "manual",
  basis,
  ...(caller === "lead" ? { decidedByRole: callerRole } : {}),
  ...(basis === "submission" && submission ? { submissionRef: submission.id } : {}),
  atMs: nowMs,
});

const cleanExpected = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
};

/** A stored accept decision that may close the task without a new reason. */
const reusableAccept = (
  latest: AcceptanceDecision | null,
  caller: AcceptanceCaller,
  currentSubmission: ReviewSubmission | undefined,
): boolean =>
  latest?.decision === "accept" &&
  latest.decidedBy === (caller === "lead" ? "lead" : "manual") &&
  // A reportless accept never grants closure — not for the lead, not for a
  // stale manual one; grounding survives only on the same submission id.
  latest.basis === "submission" &&
  !!currentSubmission &&
  latest.submissionRef === currentSubmission.id;

/** An identical retry (same decision, grounds and reason) appends nothing. */
const duplicateDecision = (
  latest: AcceptanceDecision | null,
  decision: "accept" | "changes-requested",
  reason: string,
  caller: AcceptanceCaller,
  currentSubmission: ReviewSubmission | undefined,
  expected: string | null,
): boolean =>
  latest?.decision === decision &&
  latest.reason === reason &&
  latest.decidedBy === (caller === "lead" ? "lead" : "manual") &&
  latest.basis === acceptBasis(caller, currentSubmission, expected) &&
  (latest.submissionRef ?? null) === (acceptBasis(caller, currentSubmission, expected) === "submission" ? currentSubmission?.id ?? null : null);

/**
 * The verifiable-acceptance gate for one task update (bbt-iwi.2).
 *
 * Every done transition (except an idempotent done→done) and every entry into
 * review is gated for team threads: the lead accepts only with a grounded
 * review report on the task plus a reason — a reportless pre-recorded accept
 * never grants closure; executors (and helpers, and threads of other teams or
 * projects) never accept. The manual path (no team thread) always requires a
 * non-empty reason; its acceptance grounds on a report only through an
 * explicit expectedSubmissionId, and a mismatching expected id is a conflict
 * with no writes — a stale view never accepts a rewritten, unreviewed report.
 * A malformed provided report is rejected on every transition, never silently
 * replaced by the older stored one. Identical retries append no duplicates.
 */
export function acceptanceGate(input: AcceptanceGateInput): AcceptanceGateOk | AcceptanceGateError {
  const { caller, callerRole, from, to, record, stamp, nowMs } = input;
  if (caller === "executor" && (to === "done" || to === "dropped")) return {ok:false,code:"only_lead_accepts"};
  const provided = parseProvidedSubmission(input.submission, stamp, nowMs);
  const hasProvided =
    input.submission !== undefined && input.submission !== null && input.submission !== "";
  // A malformed explicitly provided report is rejected on EVERY transition —
  // it must never be silently replaced by the older stored one.
  if (hasProvided && !provided.ok) {
    return { ok: false, code: "review_submission_required" };
  }
  if (provided.ok && record?.submission) {
    const content = (report: ReviewSubmission) => JSON.stringify({result:report.result, artifacts:report.artifacts ?? [], checks:report.checks, problems:report.problems ?? [], submittedBy:report.submittedBy});
    if (content(provided.submission) === content(record.submission)) provided.submission = record.submission;
  }
  // The submission that will be stored after this call, if any.
  const currentSubmission = provided.ok ? provided.submission : record?.submission;
  const expected = cleanExpected(input.expectedSubmissionId);
  // The explicit reviewed-id reference: any mismatch is a conflict with no
  // writes (a missing current report conflicts with a non-null expectation).
  if (input.expectedSubmissionId !== undefined && (currentSubmission?.id ?? null) !== expected) {
    return { ok: false, code: "submission_conflict" };
  }
  const latest = latestDecision(record);
  const makesDecision = cleanReason(input.acceptReason) !== null || cleanReason(input.returnReason) !== null ||
    (to === "done" && from !== "done" && latest?.decision === "accept");
  if (caller === "lead" && currentSubmission && makesDecision && expected === null) {
    return { ok:false, code:"submission_conflict" };
  }
  const withSubmission = (decision?: AcceptanceDecision): AcceptanceGateOk => ({
    ok: true,
    ...(provided.ok ? { submission: provided.submission } : {}),
    ...(decision ? { decision } : {}),
  });

  if (to === undefined || to === from) {
    // Record-only update (no transition): a provided submission must be
    // valid (checked above); decisions belong to the lead or the manual path.
    const acceptReason = cleanReason(input.acceptReason);
    if (input.acceptReason !== undefined && input.acceptReason !== null && acceptReason === null) {
      return { ok: false, code: "acceptance_reason_required" };
    }
    if (acceptReason !== null) {
      if (caller === "executor") return { ok: false, code: "only_lead_accepts" };
      // The lead never records acceptance without a grounded report.
      if (caller === "lead" && !currentSubmission) {
        return { ok: false, code: "review_submission_required" };
      }
      // A repeat accept that already stands on the same grounds appends
      // nothing (double click; the task is not re-decided by new wording).
      if (
        latest?.decision === "accept" &&
        latest.decidedBy === (caller === "lead" ? "lead" : "manual") &&
        latest.basis === acceptBasis(caller, currentSubmission, expected) &&
        (latest.submissionRef ?? null) === (acceptBasis(caller, currentSubmission, expected) === "submission" ? currentSubmission?.id ?? null : null)
      ) {
        return withSubmission();
      }
      return withSubmission(
        decisionOf(
          "accept", acceptReason, caller, callerRole,
          acceptBasis(caller, currentSubmission, expected), currentSubmission, nowMs,
        ),
      );
    }
    const returnReason = cleanReason(input.returnReason);
    if (input.returnReason !== undefined && input.returnReason !== null && returnReason === null) {
      return { ok: false, code: "return_reason_required" };
    }
    if (returnReason !== null) {
      if (caller === "executor") return { ok: false, code: "only_lead_accepts" };
      if (duplicateDecision(latest, "changes-requested", returnReason, caller, currentSubmission, expected)) {
        return withSubmission();
      }
      return withSubmission(
        decisionOf(
          "changes-requested", returnReason, caller, callerRole,
          acceptBasis(caller, currentSubmission, expected), currentSubmission, nowMs,
        ),
      );
    }
    return withSubmission();
  }

  if (to === "review") {
    if (provided.ok) return { ok: true, submission: provided.submission };
    if (record?.submission) return { ok: true };
    // Team threads (executors, helpers, the lead) must ground review entry;
    // the manual path may also place a package into review by hand.
    if (caller === "manual" && !hasProvided) return { ok: true };
    return { ok: false, code: "review_submission_required" };
  }

  if (to === "done") {
    if (caller === "executor") return { ok: false, code: "only_lead_accepts" };
    const reason = cleanReason(input.acceptReason);
    if (reason) {
      // The lead never bypasses the grounded report by a direct close.
      if (caller === "lead" && !currentSubmission) {
        return { ok: false, code: "review_submission_required" };
      }
      // A retry after a failed status update appends no second decision.
      if (duplicateDecision(latest, "accept", reason, caller, currentSubmission, expected)) {
        return withSubmission();
      }
      return withSubmission(
        decisionOf(
          "accept", reason, caller, callerRole,
          acceptBasis(caller, currentSubmission, expected), currentSubmission, nowMs,
        ),
      );
    }
    // No new reason: only a stored accept that still grounds on the very
    // submission stored now (and on a real report) may close the task.
    if (reusableAccept(latest, caller, currentSubmission)) {
      return withSubmission();
    }
    return { ok: false, code: "acceptance_reason_required" };
  }

  if ((to === "todo" || to === "in-progress") && from === "review") {
    const reason = cleanReason(input.returnReason);
    if (caller === "executor") {
      // The executor may withdraw their own review; no acceptance decision.
      return { ok: true };
    }
    if (!reason) return { ok: false, code: "return_reason_required" };
    if (duplicateDecision(latest, "changes-requested", reason, caller, currentSubmission, expected)) {
      return withSubmission();
    }
    return withSubmission(
      decisionOf(
        "changes-requested", reason, caller, callerRole,
        acceptBasis(caller, currentSubmission, expected), currentSubmission, nowMs,
      ),
    );
  }

  return { ok: true };
}
