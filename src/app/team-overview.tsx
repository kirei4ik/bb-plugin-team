// Read-only compact overview of one team snapshot (GitHub Issue #6 UI slice).
// Honest: unknown tokens/money stay unknown; closed tasks and child counts are
// never presented as proven criteria; acceptance grounds come only from the tracker.
import { currentTask } from "../shared/snapshot";
import type { Language, SnapshotRole, TeamSnapshot } from "../shared/snapshot";
import { quotaHeadroom } from "../shared/ollama-usage";

type BlockCategory = "scope" | "budget" | "quota" | "pause" | "delivery";
interface Block {
  category: BlockCategory;
  summary: string;
  technical: string | null;
}

const MAX_LIST = 3;
const RUNNING = ["active", "starting"] as const;

function timeLabel(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString();
}

const STAGE_LABELS: Record<string, { en: string; ru: string }> = {
  preparing: { en: "preparing", ru: "готовится" },
  scheduled: { en: "scheduled", ru: "запланировано" },
  "needs-decision": { en: "needs decision", ru: "нужно решение" },
  released: { en: "conditions passed", ru: "условия выполнены" },
};

function stageLabel(stage: string, ru: boolean): string {
  return STAGE_LABELS[stage]?.[ru ? "ru" : "en"] ?? stage;
}

export function TeamOverview({
  snapshot,
  language,
}: {
  snapshot: TeamSnapshot;
  language: Language;
}) {
  const ru = language === "ru";
  const resources = snapshot.resources;
  const epic = resources?.epic;
  const continuations = snapshot.continuations ?? [];
  const roles = snapshot.roles;
  const bindingIssues = snapshot.bindingIssues ?? [];
  const tasks = roles.flatMap((role) => role.tasks);
  const running = (role: SnapshotRole) =>
    role.threads.some((thread) => (RUNNING as readonly string[]).includes(thread.status));

  const results = resources?.results;
  const closedTasks =
    results?.accepted ?? tasks.filter((task) => task.status === "done").length;
  const reviewTasks =
    results?.review ?? tasks.filter((task) => task.status === "review").length;
  const reports =
    results?.reports ??
    tasks.filter((task) => task.review?.submission !== undefined).length;
  const decisions = tasks.reduce(
    (sum, task) => sum + (task.review?.decisions?.length ?? 0),
    0,
  );

  const work =
    roles.find((role) => role.executionState?.kind === "working") ??
    roles.find((role) => running(role));
  const workTask = work ? currentTask(work.tasks) : null;
  const errorRole = roles.find((role) => role.executionState?.kind === "error");
  const decisionRole = roles.find(
    (role) =>
      role.executionState?.kind === "awaiting-acceptance" ||
      role.executionState?.kind === "awaiting-team-decision",
  );

  const quota = quotaHeadroom(resources?.ollamaUsage, resources?.quotaPolicy);
  const quotaHeld = (resources?.quotaBlocks?.length ?? 0) > 0 || quota.held;

  /* ── Hold categories ─────────────────────────────────────────────────── */
  const blocks: Block[] = [];
  const scopeUnknown=epic?.blocked?.startsWith("Epic scope held:")===true;
  if (scopeUnknown) {
    blocks.push({category:"scope",summary:ru?"требования не удалось проверить":"requirements could not be verified",technical:epic?.blocked??null});
  } else if (epic?.scopeMismatch) {
    blocks.push({
      category: "scope",
      summary: ru ? "объём изменился после утверждения" : "scope changed since approval",
      technical: epic.scopeMismatch,
    });
  } else if (epic && !epic.approvedScopeRevision) {
    blocks.push({
      category: "scope",
      summary: ru ? "объём не утверждён" : "scope not approved",
      technical: epic.blocked,
    });
  }
  if (epic && epic.used >= epic.limit) {
    blocks.push({ category: "budget", summary: `${epic.used}/${epic.limit}`, technical: epic.blocked });
  } else if (
    resources?.blocked &&
    /Epic budget exhausted|Task attempt limit reached|Team start limit reached/.test(resources.blocked)
  ) {
    blocks.push({ category: "budget", summary: resources.blocked, technical: resources.blocked });
  }
  if (quotaHeld) {
    const pools = (resources?.quotaBlocks ?? [])
      .map((entry) => `${entry.provider}${entry.hostId ? ` · ${entry.hostId}` : ""}`)
      .join("; ");
    blocks.push({
      category: "quota",
      summary: ru ? "квота провайдера удерживается" : "provider quota held",
      technical: pools.length ? pools : null,
    });
  }
  if (snapshot.paused) {
    blocks.push({ category: "pause", summary: ru ? "команда на паузе" : "team paused", technical: null });
  }
  if (continuations.some((c) => c.stage === "needs-decision")) {
    blocks.push({
      category: "delivery",
      summary: ru ? "доставка по расписанию требует решения" : "scheduled delivery needs a decision",
      technical: null,
    });
  }

  /* ── State line (error > decision > working > waiting) ──────────────── */
  const state = errorRole
    ? {
        text: ru ? "Требует внимания" : "Needs attention",
        role: errorRole,
        task: currentTask(errorRole.tasks),
        note: null,
      }
    : decisionRole
      ? {
          text: ru ? "Нужно решение" : "Needs decision",
          role: decisionRole,
          task: currentTask(decisionRole.tasks),
          note: null,
        }
      : bindingIssues.length > 0
        ? {
            text: ru ? "Нужно решение" : "Needs decision",
            role: null,
            task: null,
            note: `${ru ? "восстановление сессий" : "session recovery"}: ${bindingIssues.length}`,
          }
        : work
          ? { text: ru ? "Работает" : "Working", role: work, task: workTask, note: null }
          : { text: ru ? "Ожидает" : "Waiting", role: null, task: null, note: null };

  const openTasks = tasks.filter((task) =>
    ["todo", "in-progress", "review"].includes(task.status),
  ).length;
  const enabledRoles = roles.filter((role) => role.enabled);
  const workingCount = roles.filter(
    (role) => role.executionState?.kind === "working" || running(role),
  ).length;
  const errorCount = roles.filter((role) => role.executionState?.kind === "error").length;

  const blockLabel: Record<BlockCategory, string> = {
    scope: ru ? "объём" : "scope",
    budget: ru ? "бюджет" : "budget",
    quota: ru ? "квота" : "quota",
    pause: ru ? "пауза" : "pause",
    delivery: ru ? "доставка" : "delivery",
  };

  return (
    <section aria-label={ru ? "Обзор команды" : "Team overview"} className="flex flex-col gap-3 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <strong>{snapshot.teamTitle ?? snapshot.team}</strong>
        <span className="text-muted-foreground">{snapshot.team}</span>
        {snapshot.paused && (
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
            {ru ? "пауза" : "paused"}
          </span>
        )}
      </header>

      {epic ? (
        <section aria-label={ru ? "Эпик" : "Epic"} className="flex flex-col gap-1 rounded-md border border-border p-2">
          <strong>{epic.title ?? epic.id}</strong>
          <p>
            {epic.id} · {ru ? "допусков" : "admissions"} {epic.used}/{epic.limit} ·{" "}
            {ru ? "остаток" : "remaining"} {epic.remaining}
          </p>
          <p className="text-muted-foreground">
            {scopeUnknown ? (ru?"Требования недоступны; утверждённая ревизия не проверена":"Requirements unavailable; approved revision could not be checked") : epic.scopeMismatch
              ? ru
                ? "Текущий объём — изменён после утверждения, не утверждён"
                : "Current scope — changed since approval, not approved"
              : !epic.approvedScopeRevision
                ? ru
                  ? "Объём ещё не утверждён для этого бюджета"
                  : "Scope not yet approved for this budget"
                : ru
                  ? "Объём утверждён"
                  : "Approved scope"}
          </p>
          {epic.trackerStatus === "done" && epic.acceptanceReason ? (
            <details>
              <summary>{ru ? "Эпик принят" : "Epic accepted"}</summary>
              <p>{epic.acceptanceReason}</p>
            </details>
          ) : null}
          {epic.progress ? (
            <p>
              {ru ? "Дочерние задачи эпика" : "Epic child tasks"}: {epic.progress.done}/
              {epic.progress.total} {ru ? "закрыто" : "closed"} · {epic.progress.accepted}{" "}
              {ru ? "принято" : "accepted"} · {epic.progress.review}{" "}
              {ru ? "на ревью" : "in review"} · {epic.progress.working}{" "}
              {ru ? "в работе" : "in progress"} · {epic.progress.queued}{" "}
              {ru ? "в очереди" : "queued"}
            </p>
          ) : null}
          {epic.criteria ? (
            epic.criteria.length > 140 ? (
              <details>
                <summary>{ru ? "Критерии" : "Criteria"}</summary>
                <p className="whitespace-pre-wrap">{epic.criteria}</p>
              </details>
            ) : (
              <p>
                {ru ? "Критерии" : "Criteria"}: {epic.criteria}
              </p>
            )
          ) : null}
          {epic.unattributedTasks && epic.unattributedTasks.length > 0 ? (
            <details>
              <summary>
                {ru ? "Задачи вне эпика удерживаются" : "Tasks outside the epic are held"}:{" "}
                {epic.unattributedTasks.length}
              </summary>
              <ul>
                {epic.unattributedTasks.slice(0, MAX_LIST).map((task) => (
                  <li key={String(task.id)}>
                    #{task.id} {task.title}
                  </li>
                ))}
                {epic.unattributedTasks.length > MAX_LIST && (
                  <li>
                    +{epic.unattributedTasks.length - MAX_LIST} {ru ? "ещё" : "more"}
                  </li>
                )}
              </ul>
            </details>
          ) : null}
        </section>
      ) : (
        <section aria-label={ru ? "Сводка команды" : "Team summary"} className="flex flex-col gap-1 rounded-md border border-border p-2">
          <p>
            {enabledRoles.length} {ru ? "ролей" : "roles"} · {workingCount}{" "}
            {ru ? "работает" : "working"}
            {errorCount > 0
              ? ` · ${errorCount} ${ru ? "с ошибкой" : "in error"}`
              : ""}{" "}
            · {openTasks} {ru ? "открытых задач" : "open packages"}
          </p>
          <p className="text-muted-foreground">
            {ru
              ? "Активного эпика нет; действуют прежние лимиты пакетов."
              : "No active epic; existing package limits apply."}
          </p>
        </section>
      )}

      <section aria-label={ru ? "Статус работы" : "Work status"} className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong>{state.text}</strong>
          {state.role && <span>· {state.role.title ?? state.role.name}</span>}
          {state.task && (
            <span>
              · #{state.task.id} {state.task.title}
            </span>
          )}
          {state.note && <span>· {state.note}</span>}
        </div>
        {(errorRole?.executionState?.errorMessage || errorRole?.executionState?.safeAction) && (
          <details>
            <summary>{ru ? "Причина и следующее действие" : "Cause and next action"}</summary>
            {errorRole.executionState.errorMessage && <p>{errorRole.executionState.errorMessage}</p>}
            {errorRole.executionState.safeAction && <p>{errorRole.executionState.safeAction}</p>}
          </details>
        )}
      </section>

      <section aria-label={ru ? "Прогресс" : "Progress"} className="flex flex-col gap-1">
        <p>
          {ru ? "закрыто" : "closed"} {closedTasks} ·{" "}
          {ru ? "на ревью" : "in review"} {reviewTasks} ·{" "}
          {ru ? "отчётов" : "reports"} {reports} ·{" "}
          {ru ? "решений" : "decisions"} {decisions}
        </p>
        <p className="text-xs text-muted-foreground">
          {ru
            ? "Закрытые задачи — зафиксированный результат, а не доказательство выполнения критериев эпика."
            : "Closed tasks are recorded outcomes, not proof that epic criteria are met."}
        </p>
        {results?.recent && results.recent.length > 0 ? (
          <details>
            <summary>{ru ? "Основания приёмки" : "Acceptance grounds"}</summary>
            <ul>
              {results.recent.slice(0, MAX_LIST).map((task) => (
                <li key={String(task.id)}>
                  #{task.id} {task.title}:{" "}
                  {task.acceptanceReason ?? (ru ? "основание не записано" : "no grounds recorded")}
                </li>
              ))}
              {results.recent.length > MAX_LIST && (
                <li>
                  +{results.recent.length - MAX_LIST} {ru ? "ещё" : "more"}
                </li>
              )}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-label={ru ? "Учёт" : "Accounting"} className="flex flex-col gap-1">
        <p>
          {resources?.reportedTokens == null
            ? ru
              ? "Токены и деньги: неизвестны"
              : "Tokens and money: unknown"
            : `${ru ? "Сообщённые токены" : "Reported tokens"}: ${resources.reportedTokens} · ${ru ? "деньги неизвестны" : "money unknown"}`}
        </p>
        <details>
          <summary>{ru ? "Пояснение учёта" : "Accounting explanation"}</summary>
          <p className="text-xs text-muted-foreground">
            {ru
              ? "Сообщённые токены не включают размер контекста; денежный расход неизвестен, жёсткий денежный предел не гарантируется."
              : "Reported tokens exclude the context-window size; monetary cost is unknown and no hard spending guarantee exists."}
          </p>
        </details>
      </section>

      {blocks.length > 0 ? (
        <section aria-label={ru ? "Ограничения" : "Holds"} className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-1">
            {blocks.map((block) => (
              <span
                key={block.category}
                className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground"
              >
                {blockLabel[block.category]}: {block.summary}
              </span>
            ))}
          </div>
          {blocks.some((block) => block.technical) && (
            <details>
              <summary>{ru ? "Технические причины" : "Technical causes"}</summary>
              {blocks
                .filter((block) => block.technical)
                .map((block) => (
                  <p key={block.category}>
                    {blockLabel[block.category]}: {block.technical}
                  </p>
                ))}
            </details>
          )}
        </section>
      ) : null}

      {continuations.length > 0 ? (
        <section
          aria-label={ru ? "Запланированные продолжения" : "Scheduled continuations"}
          className="flex flex-col gap-1 rounded-md border border-border p-2"
        >
          <strong>{ru ? "Запланировано / очередь" : "Scheduled / queue"}</strong>
          {continuations.slice(0, MAX_LIST).map((continuation, index) => (
            <div key={`${continuation.role}:${continuation.threadId}:${index}`}>
              {continuation.role} · {stageLabel(continuation.stage, ru)} ·{" "}
              {ru ? "очередь BB" : "BB queue"} ·{" "}
              {continuation.queueSendAt !== null
                ? timeLabel(continuation.queueSendAt)
                : continuation.sendAt !== null
                  ? `${ru ? "ориентир" : "intent"} ${timeLabel(continuation.sendAt)}`
                  : ru
                    ? "время неизвестно"
                    : "time unknown"}
              <details>
                <summary>{ru ? "технически" : "technical"}</summary>
                <p>
                  stage: {continuation.stage} · source: {continuation.source} ·{" "}
                  {ru ? "очередь" : "queue"}{" "}
                  {continuation.queueState ?? (ru ? "неизвестно" : "unknown")}
                  {continuation.queuedMessageId
                    ? ` · message: ${continuation.queuedMessageId}`
                    : ""}
                </p>
                {continuation.reason && <p>{continuation.reason}</p>}
              </details>
            </div>
          ))}
          {continuations.length > MAX_LIST && (
            <p>
              +{continuations.length - MAX_LIST} {ru ? "ещё" : "more"}
            </p>
          )}
        </section>
      ) : null}
    </section>
  );
}
