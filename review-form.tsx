// bbt-iwi.2 — review & acceptance card for a team work package.
// Standalone component for the parent to integrate into the Team panel's
// task detail (app.tsx stays untouched):
//   <ReviewForm projectId={projectId} team={team} task={task} language={language} onChanged={refresh} />
//
// Honesty wording: the record says "accepted by the lead" or "manual
// acceptance" with the recorded grounds — never "verified": presence of text
// is not a passed check, and the decision's reason is the accepter's own
// accountability, not proof the reported checks are true.

import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Language, TeamTask } from "./snapshot";

const COPY = {
  ru: {
    heading: "Ревью и приёмка",
    empty: "Отчёта ревью ещё нет.",
    result: "Результат",
    artifacts: "Артефакты",
    problems: "Оставшиеся проблемы",
    checks: "Проверки",
    notApplicable: "неприменимо",
    checkResult: "итог",
    decisions: "Решения",
    accepted: "принято руководителем",
    acceptedManual: "ручная приёмка",
    changesRequested: "возврат с замечанием",
    basisSubmission: "по отчёту ревью",
    basisManual: "вручную без отчёта",
    noProblems: "не указаны",
    acceptLabel: "Принять задачу",
    acceptReason: "Основание приёмки: что проверено и почему этого достаточно",
    returnLabel: "Вернуть на доработку",
    returnReason: "Конкретное замечание для исполнителя",
    working: "Сохраняем…",
    failed: "Не удалось обновить пакет",
    reasonRequired: "Укажите причину: без неё приёмка/возврат не сохраняются",
  },
  en: {
    heading: "Review & acceptance",
    empty: "No review report yet.",
    result: "Result",
    artifacts: "Artifacts",
    problems: "Remaining problems",
    checks: "Checks",
    notApplicable: "not applicable",
    checkResult: "outcome",
    decisions: "Decisions",
    accepted: "accepted by the lead",
    acceptedManual: "manual acceptance",
    changesRequested: "returned with a remark",
    basisSubmission: "grounded on the review report",
    basisManual: "manually, without a report",
    noProblems: "none reported",
    acceptLabel: "Accept task",
    acceptReason: "Acceptance grounds: what you checked and why it is enough",
    returnLabel: "Request rework",
    returnReason: "Concrete remark for the executor",
    working: "Saving…",
    failed: "Could not update the package",
    reasonRequired: "State the reason: acceptance/return is not saved without one",
  },
} as const;

export function ReviewForm({ projectId, team, task, language, onChanged }: {
  projectId: string;
  team: string;
  task: TeamTask;
  language: Language;
  onChanged: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const labels = COPY[language];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptText, setAcceptText] = useState("");
  const [returnText, setReturnText] = useState("");

  const review = task.review;
  const submission = review?.submission;
  const decisions = review?.decisions ?? [];

  const call = async (status: "done" | "in-progress", reason: string, reasonField: "acceptReason" | "returnReason") => {
    if (busy) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(labels.reasonRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.call("taskUpdate", {
        projectId,
        team,
        id: task.id,
        status,
        [reasonField]: trimmed,
        // Stale-view protection: ground the decision on the very report this
        // card rendered; a rewritten report is a conflict, not auto-accepted.
        expectedSubmissionId: submission?.id ?? null,
      });
      setAcceptText("");
      setReturnText("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section aria-label={labels.heading} className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
    <strong>{labels.heading}</strong>
    {error && <span role="alert">{labels.failed}: {error}</span>}
    {!submission && <p className="text-muted-foreground">{labels.empty}</p>}
    {submission && <>
      <div>{labels.result} ({submission.id}): {submission.result}</div>
      {submission.artifacts && submission.artifacts.length > 0 && (
        <div>{labels.artifacts}:
          <ul className="list-disc pl-4">
            {submission.artifacts.map((artifact) => <li key={artifact} className="break-all">{artifact}</li>)}
          </ul>
        </div>
      )}
      <div>{labels.checks}:
        <ul className="list-disc pl-4">
          {submission.checks.map((check, index) => (
            <li key={index}>
              {check.what}:{" "}
              {check.notApplicable
                ? <>{labels.notApplicable} — {check.notApplicable}</>
                : <>{labels.checkResult}: {check.result}</>}
            </li>
          ))}
        </ul>
      </div>
      <div>{labels.problems}: {submission.problems?.length ? submission.problems.join("; ") : labels.noProblems}</div>
    </>}
    {decisions.length > 0 && <>
      <div>{labels.decisions}:
        <ul className="list-disc pl-4">
          {decisions.map((decision, index) => (
            <li key={index}>
              {decision.decision === "accept"
                ? (decision.decidedBy === "lead" ? labels.accepted : labels.acceptedManual)
                : labels.changesRequested}{" "}
              — {decision.reason} ({decision.basis === "submission" ? labels.basisSubmission : labels.basisManual})
            </li>
          ))}
        </ul>
      </div>
    </>}
    {task.status !== "done" && task.status !== "dropped" && <>
      <label className="flex flex-col gap-1">
        <span>{labels.acceptReason}</span>
        <textarea value={acceptText} onChange={(event) => setAcceptText(event.target.value)} rows={2} maxLength={4000} />
      </label>
      <button type="button" disabled={busy} onClick={() => void call("done", acceptText, "acceptReason")}
        className="self-start rounded-md border border-border px-2 py-1 text-left disabled:opacity-50">
        {busy ? labels.working : labels.acceptLabel}
      </button>
      {task.status === "review" && <>
      <label className="flex flex-col gap-1">
        <span>{labels.returnReason}</span>
        <textarea value={returnText} onChange={(event) => setReturnText(event.target.value)} rows={2} maxLength={4000} />
      </label>
      <button type="button" disabled={busy} onClick={() => void call("in-progress", returnText, "returnReason")}
        className="self-start rounded-md border border-border px-2 py-1 text-left disabled:opacity-50">
        {busy ? labels.working : labels.returnLabel}
      </button>
      </>}
    </>}
  </section>;
}
