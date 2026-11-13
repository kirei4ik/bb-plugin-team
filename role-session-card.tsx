import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { SessionView } from "./session-view";
import type { Language } from "./snapshot";

const COPY = {
  ru: {
    heading: "Рабочая сессия", current: "Текущий тред", loading: "Загрузка состояния сессии…",
    refresh: "Обновить состояние сессии", failed: "Не удалось получить состояние сессии", requestFailed: "Не удалось запросить передачу", task: "Связанная задача",
    context: "Контекст", exact: "точные данные", estimated: "приблизительно", unavailable: "провайдер не сообщает достоверные данные",
    exactHint: "При точных данных Team запрашивает передачу от 80% после завершения хода. Нужна связанная незавершённая задача.",
    estimatedHint: "По приблизительным данным автоматическая замена на 80% не запускается. Передачу можно запросить вручную.",
    unavailableHint: "Неизвестный объём не означает пустой контекст. Передачу можно запросить вручную.",
    checkpoint: "Состояние для передачи", ready: "сохранено и проверено", missing: "ещё не сохранено", stale: "нужно сохранить заново", checkpointUnavailable: "не удалось проверить",
    phase: "Передача сессии", idle: "не запрошена", "awaiting-checkpoint": "ждём сохранения состояния агентом", "awaiting-safe-boundary": "ждём завершения операций", "awaiting-package": "ждём следующую готовую задачу", replacing: "меняем сессию", error: "остановлена из-за ошибки",
    contextReason: "для продолжения текущей задачи", acceptedReason: "после завершения задачи",
    rotate: "Сохранить состояние и сменить сессию", pending: "Передача запрошена", working: "Запрашиваем передачу…",
    actionHint: "Если состояние ещё не сохранено, запрос может запустить агента и расходовать лимит модели. Активные операции не прерываются. Окружение и незакоммиченные изменения сохраняются.",
    no_session: "У сотрудника пока нет рабочей сессии.", multiple_sessions: "У роли несколько тредов. Сначала определите актуальную сессию.", session_changed: "Сессия изменилась. Обновите карточку.",
    no_task: "С этой сессией не связана задача. Сначала назначьте и запустите задачу через Team; для руководителя — задачу координации. История старого треда не заменяет сохранённое состояние.",
    task_reassigned: "Задача назначена другой роли. Проверьте назначение в трекере.", tracker_unavailable: "Трекер недоступен. Восстановите доступ к задаче.", paused: "Автозапуск исполнителей приостановлен. Продолжите работу команды для передачи.",
    failedReason: "Предыдущая передача завершилась ошибкой. Автоматический повтор отключён; проверьте действие восстановления в карточке сотрудника или bb team doctor.", replacement_pending: "Переключение уже начато. Повторный тред не создаётся; при ошибке требуется восстановление существующей передачи.",
  },
  en: {
    heading: "Work session", current: "Current thread", loading: "Loading session state…", refresh: "Refresh session state", failed: "Could not read session state", requestFailed: "Could not request handoff", task: "Linked task",
    context: "Context", exact: "exact counters", estimated: "estimated", unavailable: "provider does not report reliable counters",
    exactHint: "With exact counters Team requests handoff at 80% after the turn ends. A linked unfinished task is required.",
    estimatedHint: "Estimates do not trigger automatic rotation at 80%. You can request handoff manually.",
    unavailableHint: "Unknown usage does not mean empty context. You can request handoff manually.",
    checkpoint: "Handoff state", ready: "saved and verified", missing: "not saved yet", stale: "needs to be saved again", checkpointUnavailable: "could not verify",
    phase: "Session handoff", idle: "not requested", "awaiting-checkpoint": "waiting for the agent to save state", "awaiting-safe-boundary": "waiting for operations to finish", "awaiting-package": "waiting for the next ready task", replacing: "switching session", error: "stopped after an error",
    contextReason: "to continue the current task", acceptedReason: "after task completion", rotate: "Save state and replace session", pending: "Handoff requested", working: "Requesting handoff…",
    actionHint: "If state has not been saved, this may start the agent and consume model usage. Active operations are not interrupted. The environment and uncommitted changes are preserved.",
    no_session: "This employee has no work session yet.", multiple_sessions: "This role has several threads. Resolve the current session first.", session_changed: "The session changed. Refresh the card.",
    no_task: "No task is linked to this session. Assign and start a task through Team first; a lead needs a coordination task. Old thread history is not saved handoff state.",
    task_reassigned: "The task belongs to another role. Check the tracker assignment.", tracker_unavailable: "The tracker is unavailable. Restore task access first.", paused: "Executor autostart is paused. Resume the team before handoff.",
    failedReason: "The previous handoff failed. Automatic retry is disabled; inspect the recovery action in the employee card or bb team doctor.", replacement_pending: "A switch has already started. No duplicate thread will be created; a failed switch requires recovery.",
  },
} as const;

export function RoleSessionCard({ projectId, team, role, threadId, revision, language, onChanged }: {
  projectId: string; team: string; role: string; threadId: string | null; revision: string; language: Language;
  onChanged: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const labels = COPY[language];
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void rpc.call("sessionView", { projectId, team, role }).then(
      result => { if (active) { setView(result); setLoading(false); } },
      cause => { if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } },
    );
    return () => { active = false; };
  }, [rpc, projectId, team, role, threadId, revision, refresh]);
  const pending = Boolean(view && view.phase !== "error" && (view.reason || view.phase === "replacing"));
  const rotate = async () => {
    if (busy || !view?.threadId) return;
    setBusy(true);
    setActionError(null);
    try {
      setView(await rpc.call("sessionRotate", { projectId, team, role, expectedThreadId: view.threadId }));
      await onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      setRefresh(value => value + 1); // Read again; never repeat the mutation.
    } finally { setBusy(false); }
  };
  const usage = view?.context;
  const percentage = usage?.usedTokens != null && usage.limitTokens != null ? Math.round(usage.usedTokens / usage.limitTokens * 1000) / 10 : null;
  const number = (n: number) => n.toLocaleString(language);
  return <section aria-label={labels.heading} className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
    <strong>{labels.heading}</strong>
    {loading && <span role="status">{labels.loading}</span>}
    {error && <span role="alert">{labels.failed}: {error}</span>}
    {actionError && <span role="alert">{labels.requestFailed}: {actionError}</span>}
    {view && <>
      {view.threadId && <div>{labels.current}: <span className="break-all">{view.threadId}</span></div>}
      <div>{labels.context}: {percentage == null ? labels.unavailable : `${usage?.kind === "estimated" ? "≈" : ""}${percentage}% · ${number(usage!.usedTokens!)} / ${number(usage!.limitTokens!)} · ${usage?.kind === "exact" ? labels.exact : labels.estimated}`}</div>
      {percentage != null && <progress aria-label={labels.context} max={100} value={Math.min(100, percentage)} className="w-full" />}
      <p className="text-muted-foreground">{usage?.kind === "exact" ? labels.exactHint : usage?.kind === "estimated" ? labels.estimatedHint : labels.unavailableHint}</p>
      {view.taskId != null && <div>{labels.task}: #{view.taskId}</div>}
      <div>{labels.checkpoint}: {view.checkpoint === "unavailable" ? labels.checkpointUnavailable : labels[view.checkpoint]}</div>
      <div role="status">{labels.phase}: {labels[view.phase]}{view.reason ? ` · ${view.reason === "context" ? labels.contextReason : labels.acceptedReason}` : ""}</div>
      {view.blockedReason && <p>{view.blockedReason === "failed" ? labels.failedReason : labels[view.blockedReason]}{view.errorCode ? ` (${view.errorCode})` : ""}</p>}
      <button type="button" onClick={() => void rotate()} disabled={loading || busy || pending || Boolean(view.blockedReason) || !view.threadId}
        className="rounded-md border border-border px-2 py-1 text-left disabled:opacity-50">{busy ? labels.working : pending ? labels.pending : labels.rotate}</button>
      <p className="text-muted-foreground">{labels.actionHint}</p>
    </>}
    <button type="button" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)} className="self-start underline disabled:opacity-50">{labels.refresh}</button>
  </section>;
}
