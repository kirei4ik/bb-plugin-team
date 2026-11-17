---
name: team
description: "Role-based agent teams in a project (lead + executors) with bb team: create teams from templates, message roles by name, track work packages, pause, replace, doctor; several teams per project in .bb/teams/<team>.yaml."
---

# Project agent teams (bb team)

A team is a lead thread plus executor threads (developer, junior, tester,
writer, …) that are the lead's child threads and report to it. A project may
hold several teams. Each team is configured in `.bb/teams/<team>.yaml` (the
legacy `.bb/team.yaml` is read as team `main`). Team threads are titled
`👥 <role>` (`👥 <team> · <role>` when the project has several teams).

## Team selection

Every command takes `--team <name>`. Without it the team is the caller thread's
team, else the only team of the project; with several teams and no hint the
command fails and lists them. `--project <id|name>` defaults to the thread's
project or the current directory.

## Lifecycle

```bash
bb team init [--team core] [--template dev|qa|docs|product|<yours>] [--versioned]
bb team init --team core --from <project> [--from-team <team>]   # copy a team
bb team doctor                 # providers, environments, prompts, threads, git
bb team create [--dry-run]     # spawn missing roles; re-links executors to the lead
bb team list                   # teams of the project
bb team status                 # all teams: threads, statuses, current packages, helpers
bb team add-role junior --provider pi --model qwen3   # new role (spawned now)
bb team add-role reviewer --thread thr_…              # adopt a free thread of the project
bb team version on|off         # track the team config in git or keep it out (default: out)
bb team retitle                # re-apply the title format setting
```

## Working as the lead

```bash
bb team task add <role> "<title>" --note "<acceptance criteria>" --send   # tracked package
bb team tell <role> --message "<text>"     # plain message; "all" = every role but you
bb team task list [--role r] [--all]
bb team task done <id> --reason "<checked grounds>" --expected-submission <report-id>
bb team report --out "$BB_THREAD_STORAGE/team.html"   # prints an inline-vis directive
bb team pause [--stop] / bb team resume    # hold agent messages to executors
bb team stop [<role>|all]                  # stop running threads (default: executors)
bb team replace <role> [--keep]            # fresh thread + saved task checkpoint, same environment
```

Delegate by difficulty: simple, well-specified work to `junior` (a cheap
model), complex work to `developer`, verification to `tester`.

## Working as an executor

Report to the lead with `bb thread tell <lead-thread-id> --message-file -`.
When a package is done, run `bb team task update <id> --status review --review '<json>'`. The report contains `result`, `artifacts[]`, `checks[]` (actual `result` or justified `notApplicable`), and `problems[]`. Only
the lead marks packages done; `bb team task done` from an executor thread fails.

## Config `.bb/teams/<team>.yaml`

- `title`, `vars` (`{{vars.<name>}}` in prompts and environments), `defaults`
  (`environment`: `checkout` | `default` | `worktree` | `env:<id>`;
  `parentNotifications`: `stuck` recommended; `permissionMode`).
- `roles[]`: `name`, `kind` (built-in prompt kind: lead, developer, junior,
  tester, reviewer, writer, analyst, devops, manager), `title`, `provider`,
  `model`, `reasoningLevel`, `environment`, `lead: true`, `enabled: false`,
  `notifyOn: [idle, error]` (wake the lead on that role's turns),
  `threadId` (adopt an existing thread), `prompt` or `promptFile`.
- A role without a prompt gets the short built-in prompt of its kind.
- Placeholders: `{{teamName}}`, `{{leadThreadId}}`, `{{leadThreadRef}}`,
  `{{role.<name>.threadId}}`, `{{role.<name>.ref}}`, `{{projectId}}`,
  `{{workspacePath}}`, `{{vars.<name>}}`.

## Helpers, pause, notifications

- A thread spawned under a team thread becomes a **helper** of that role: shown
  under the role, paused with it, never a target of `tell` or packages.
- Pause holds agent and plugin-relayed messages to executors in their queues; a
  human typing into a thread is never held.
- Disabled providers fail before any thread is spawned, with the exact
  `bb provider enable <id>` hint.

## Templates (server-wide)

```bash
bb team template list | show <id> | delete <id>
bb team template save <id> --kinds lead,developer,junior,tester   # prepared prompts
bb team template save <id> --from-team core                        # current team
bb team template save <id> --from-template dev                     # copy a built-in
```

The Team panel (navigation rail) shows every project grouped by state, a tree
of each project's teams with live statuses and actions, and a creation wizard;
Settings → Team holds the template editor.

## Settings

`defaultTemplate` (template id for new teams; explicit selection wins), `defaultTracker` (beads | builtin; project override wins), `language` (en | ru), `teamSection` (a sidebar section per team), `roster`
(roster message to the lead after create), `titleFormat` (default
`👥 {team} · {role}`; `{team}` is dropped while the project has one team).

## Project tracker and task sessions

- `bb team tracker beads|builtin|default --project <id>` selects one tracker for
  the whole project. Project override > plugin default (Beads). `default` clears
  the override. Beads failures are explicit, with no silent fallback.
  Finish packages and replace consumed role sessions before changing backends;
  task/execution references are not migrated. Pinning the effective kind is safe.
- Team creation prepares Beads in the project's canonical checkout on its source
  host: reuse an existing database or initialize a missing local one; corruption
  and unavailable hosts are errors. Dry-run does not initialize anything. Never
  initialize another database in an execution worktree. Issues use `bb-team:<team>` and
  assignee `<role>`. Preserve string IDs and `bb-state:review`/`bb-state:dropped`
  labels. Built-in packages are preserved; migration is always a separate action.
- One package per session. Save a substantive checkpoint before review. Review
  keeps the role occupied. After acceptance Team replaces the consumed session
  automatically when the next package is ready and all operations are finished.
  Without a fresh checkpoint it asks the executor to save one; ambiguous failures
  require human inspection. Dependencies/readiness come from Beads.
- `bb team checkpoint <id> --file <absolute-json-path>` saves a complete handoff
  in the selected task, reads it back, and records its technical reference. JSON:
  `goal`, `criteria[]`, `progress`, `decisions[{what,why}]`, `checks[{what,result}]`,
  `blockers[]`, `nextAction`, `files[]`; all fields required, arrays may be empty
  except criteria. A ready TODO checkpoint starts that package. Maximum 64 KiB;
  the built-in store also has the existing total KV cap. See README.ru.md example.
- `replace` requires the role's current task checkpoint (lead included), an idle
  or error thread with no background work/queued messages/pending interaction,
  and the same ready Git environment/branch/HEAD/dirty fingerprint. It reuses
  environmentId and preserves dirty files. Do not use the old output as a handoff.
  The initial prompt is held in the core BB queue until the canonical switch and
  archive finish, then released by recheck. Pending is allowed only with exactly
  one Team-held request. On a release failure use resume, never send a duplicate.
- State lives in the task; Team keeps task references, execution bindings and
  session history. Use `bb team tell <role>` including alias `lead`; do not embed
  durable addresses to a particular lead thread. Report blockers and decisions
  promptly with `bb team tell lead`; review and execution errors notify the lead.
- `doctor` and `replace --dry-run --json` expose incomplete replacement state.
  Repeat `replace` to finish a partial switch on the existing new thread.
  `replace <role> --abort` is supported only before canonical switching; it
  restores children and preserves the original session. After an uncertain spawn,
  `replace <role> --thread <new-id>` confirms a matching Team-held candidate explicitly.
  Uncertain prompt delivery must be inspected before a manual role message;
  never blindly retry a spawn or send. `resume` also rechecks dependency readiness.
- Dirty submodules, missing Git HEAD, and descendants with immutable old-thread
  lifecycle ownership currently refuse replacement; do not work around them by
  creating a clean worktree. GitHub Issues remain outside this iteration.

## Context handoff

Before closing or requesting archival/replacement of a work session, persist
the task's substantive state in its selected tracker and read it back. Include
goal/criteria, completed and remaining work, decisions with reasons, actual
checks and their limits, environment/worktree/branch/commit/dirty files, pending
operation IDs, blockers, continuing permissions/cost constraints, and the next
action with file/artifact links. Put durable architecture and operating rules in
project documentation and link them from the task; do not create a parallel
backlog. Historical quota observations must be dated, not treated as current.

Task acceptance and session closure are separate: close a task only after its
result is accepted; unfinished work stays open with a precise handoff. Do not
claim handoff complete until the saved record and referenced environment are
verified. An ordinary BB thread outside a Team role saves its handoff directly
in the task tracker; do not fabricate a Team task/session binding. These are agent instructions, not a new runtime archive gate.

- The selected template persists provider/model/reasoning per role. Choose from
  that roster; do not silently switch services or incur unapproved extra costs.
- Preserve authorization: an instruction to implement is sufficient; discussing
  or planning alone is not. The lead manages the selected tracker without asking
  which tracker to use on every task. Ask about product scope/priorities/costs.
- To continue a growing task, save its substantive checkpoint with
  `bb team checkpoint <id> --file <absolute-json-path> --rotate`, then finish the
  current operations. The request waits for a safe boundary; do not stop yourself
  or start another worktree. A lead uses its coordination task.
- Team checks actual context usage once on idle. At 80%, only valid
  `estimated: false` data triggers a request. Missing/estimated metrics do not;
  use the explicit request path when needed (observed Pi metrics are estimated).
  Never infer context from cumulative billing usage or measure it with an LLM.
- Handoff failures stop automatic retry and expose the cause and safe next step
  in the panel/doctor. Inspect uncertainty before any manual send or spawn.

### Template editor settings

Settings → Team shows built-in and saved templates in the same role editor. Built-in templates are read-only; duplicate one before editing. Select the default template by title in the dropdown. The selected default cannot be deleted until another default is chosen.

Role model selection uses BB’s provider/model picker and retains reasoning and service tier in saved templates and generated team configurations. Unavailable saved models are preserved; select a replacement explicitly. Starter role prompts can be inserted without a model call. The separate prompt-draft model setting only stores a selection; it does not itself run generation.

Native settings labels use the saved Team language at plugin load. After changing language, reload the plugin explicitly with `bb plugin reload team` to refresh those labels.

### Session card and handoff

Select an employee in the Team panel to see the current thread, linked task, context counters (exact, estimated, or unavailable), checkpoint freshness and handoff waiting state. Refreshing this card reads BB counters only; it does not invoke a model. Context estimates never trigger the 80% automation threshold.

“Save state and replace session” explicitly requests the existing safe handoff. A missing or stale checkpoint causes one request to the employee to save it; this can start a model turn and consume usage. Active operations finish first. Repeated clicks do not resend the request or create another thread. Without a linked Team task (including a coordination task for the lead), the action is unavailable and the card explains why. A pause or an uncertain prior switch requires resolution first. The same environment and uncommitted changes are retained.

### Review and model profiles

Acceptance requires a reason. The lead reads the current report and passes its
server-stamped id with `--expected-submission`. A stale report reference is
rejected. Manual acceptance without a report is recorded explicitly as manual.
Return with `task update <id> --status in-progress --return-reason "<remark>"`
(and the viewed report id for a lead); the employee receives the remark and
continues the same task and environment. An uncertain delivery is shown as an
error and is never resent automatically. A report records claims and evidence;
it does not prove that the reported checks actually ran.

Role/template `executionPolicy` stores an explicitly approved ordered fallback
list. `noAdditionalCost: true` is the user's declaration, not a price check.
Incomplete/unapproved/duplicate selections cannot be saved. Quota recovery uses these profiles only with a fresh verified checkpoint and
an independent available provider; otherwise it stops explicitly.

The employee card's **Fallback models** editor changes the existing role's
team configuration with the same picker and explicit approval as templates.
Templates are copied at team creation; later template changes are not
inherited. Clearing the list removes backups. The primary model remains the
role's configured value (unset means the BB default). A stale open editor
cannot overwrite newer configuration. Saving reformats the config file and removes YAML comments, as
shown before Save. New/replacement sessions read current profiles; the lead
receives all roles' profiles. Existing sessions are not rewritten on save.

### User decisions in chat

Use work titles in messages to the user, with IDs only as references. Never
answer with a bare code such as `r20`. Check current `bb team report` before
claiming a budget stop: total starts are statistics, while an explicitly selected
epic has its own shared finite cap.

The user can approve a named package's allowance in the lead chat, including a
queued message. Direct user messages to the canonical lead can pass its package
cap for discussion; their starts are still counted. The shared epic cap is never
waived, including for this discussion. Worker messages, automated
turns/retries, manual pauses, quotas, shared token/time limits and failure/partial
handoff holds are not waived. A mixed queue group is eligible only if it contains
an actual user-authored, non-plugin, non-retry row.

When the user explicitly agrees to a new total for a named package, the lead
records it without sending the user to Team:

```sh
bb team budget <id> --json
bb team budget <id> --limit <approved-total> --expected-limit <displayed-limit> --expected-used <displayed-used> --reason '<user decision and grounds>'
```

The second command checks that spending and the previous limit have not changed.
It records the decision in the selected tracker and retains spending and all
other guards. Only a canonical lead in a current direct user control turn (or a
manual caller) can change it; helpers/workers and automated lead turns cannot.
A user chat is evidence of the decision's origin, not proof of semantic consent:
the lead must still obtain explicit agreement, and ask if the package/number is
ambiguous. A conversation start also counts, so re-read before saving. Never
raise limits just to keep working or treat a budget increase as new scope.

Increasing a limit from Team notifies an idle lead with an empty queue. If there
is queued input, it is rechecked rather than duplicated; a running lead is not
interrupted. The form reports when a notification could not be delivered. An
old answer remains historical: new messages/reports contain current state.

### Shared Beads epic budget

An epic budget is opt-in and finite. Tasks and hierarchy remain in Beads; Team
stores only the binding, decisions' technical references and admission ledger.
The lead coordinates on the epic itself, with its Beads assignee set to the lead
role. Executors use direct children; helpers inherit their owner's task. Every
admission consumes the same epic allowance, alongside existing package limits.
New children, retries, review rework, model changes and session rotation retain
spend. A review return consumes an epic unit when its next turn is admitted;
the separate package return counter is unchanged. This limits turns, not money
or model requests inside a turn. BB Send-now bypasses hooks; observed unreserved
turns are counted and hold further admissions for a manual attribution decision.

Use Team → Epic budget, or these commands **in a manual terminal outside an
agent thread**. First create/select a real Beads epic with exactly one
`bb-team:<team>` label. This control never creates an epic implicitly.

```sh
bb team budget <epic-id> --epic --json
# Use activeEpicId (or none), revision and used from that response:
bb team budget <epic-id> --epic --limit <total> --expected-epic <active-id-or-none> --expected-revision <revision> --expected-used <used> --expected-scope <scopeRevision> --reason '<human decision>'
bb team task add <role> '<title>' --parent <epic-id>
```

Inspect the requirements and criteria returned by the first command. The second
command must include the exact displayed `scopeRevision`. In the UI, use **Read
epic requirements**, inspect the text, and explicitly approve those requirements
and criteria before Save. The stored revision covers the epic's identity, title,
description and acceptance criteria; operational notes and budget decisions do
not change it. An external requirements edit holds dispatch/admission until the
human approves the new revision. Old epic budgets without a revision are held
for explicit approval; no spending is reset.

The limit is 1..10000 admission units. Existing reservations/turns must finish
before activation, switching or changing a budget. Decisions are recorded in
Beads before the budget changes; stale state or a failed tracker write refuses
the update. Saving sends no message or new dispatch request. Inspect the state
before manually continuing work. The supported agent-thread CLI refuses changes to this shared budget, including
from the lead during a user conversation. Manual resource changes also require
that no project turn/background operation or outstanding admission is live.
Direct-user-control lead chat keeps its existing package-only exception. Increasing a
package budget cannot bypass the epic cap, quota, failure or scope hold.

Closed/foreign/ambiguous epics, unrelated tasks and unavailable Beads hold new
admissions. Dispatch and admission both check membership; an external Beads edit
can race a read, but it cannot rewrite already charged epic IDs. Nested epics
and automatic planning are not supported. Built-in tracking explicitly refuses
epic activation. Teams without a selected epic keep the previous behavior.
Switching to another epic preserves each epic's history. This first slice does
not expose a command to clear an active binding or switch it to built-in.

RPC authority boundary: BB SDK reports browser, CLI and agent RPC as the same
`client` kind. Team therefore rejects mutation calls from other plugins and
holds manual resource RPC while project turns/background operations or resource
reservations are live. Full scans fail closed on errors/truncation. An inactive
errored session can still receive a human recovery decision. This prevents normal
active agent RPC/CLI escalation; it is not authentication of a human against
arbitrary host code. A host operator or detached program sharing local BB access
remains trusted. No claim of cryptographic client isolation is made.

### Finite execution budgets per work package

Each work package has its own finite allowance: by default 8 units for an
executor package and 40 for a lead coordination package. One start is an agent
processing a new message until a response or stop, potentially using several
actions and model requests. Start admissions (including reservations), helper
starts and review returns count toward the same task ID across models and
sessions. A distinct package has a separate allowance; exhausting one package
does not stop other packages unless they share an exhausted epic budget. The
cumulative team start count is statistics only.

The main panel shows each open package's usage and editable limit. A grounded
change is saved in the selected tracker, with a stale-form check; it never resets
spending or clears failure, quota or unfinished-handoff holds. Increasing the
limit may release an existing queued message. Defaults apply to new packages;
existing effective allowances are retained. Legacy `teamStarts` is accepted for
compatibility but ignored. Upgrade retires only obsolete team/task global start
holds and preserves all accounting. Sessions without a bound package have a
finite initialization allowance per owner session. Optional shared reported-token
and elapsed-minute caps remain independent. Active work is not interrupted.

Opening status calls no model. Counts include conservative reservations;
provider-internal API retries are not separately observable. Reported cumulative
tokens have partial coverage; unsupported counters are unavailable, never zero.
Context-window size and window cost are not used as cumulative spend. These
limits do not guarantee a hard monetary or intra-turn token cap. BB explicitly
lets the user bypass hooks with Send-now; such starts are observed afterwards.

On structured budget-exceeded, or blocked rate-limit with a known window kind,
Team excludes the host/provider quota pool (and known shared window hashes),
selects only an explicitly approved available backup, and uses the existing
checkpoint/replace path for the same task/environment. Arbitrary HTTP429, auth,
503 and unknown errors do not trigger blind model cycling. Unknown reset stays
blocked; a reported reset or allowed state can expire the pool exclusion. Account
scopes not exposed by the SDK are conservatively pooled per host/BB provider.
Quota data is shared across teams on that host; unknown cross-provider accounts
cannot be proved independent. Missing/stale checkpoint, queued operations,
unfinished replacement or uncertain spawn/delivery stop the handoff. No exhausted
model is asked to manufacture a new checkpoint. Inspect/recover the existing
replacement via `bb team replace`/`bb team resume`; automatic event replay never
spawns or sends twice. The panel and `bb team report` show reasons and actual
known selections beside tracker results/acceptance grounds.

Automatic quota handoff supports a refused next input with a causal request
history and a saved checkpoint covering all earlier work. Accepted/mid-stream
input or intervening work after that checkpoint stops automatically even when
Git is unchanged: external side effects cannot be inferred from a clean diff.
Unsupported/incomplete history is an explicit stop. Human recovery must inspect
that state before using the existing manual replace. Compaction/edited re-send
are additional core operations outside message.dispatch; no hard universal
LLM spending limit is claimed.


### Quota planning and employee pause

The resource panel keeps prior reports collapsed. A blocked state gives a short
reason and a separate technical detail. `bb team doctor` includes resource
holds and known Ollama quota exhaustion.

New packages default to 8 executor units or 40 lead coordination units. Existing
package allowances and spending survive upgrades; changing defaults affects new
packages only.
The lead uses the configured lead flag (including custom role names/helpers).
A global resource hold is shown without waking the already blocked lead.

For Pi `ollama-cloud/*`, Team reads the same fixed account-balance endpoint as
Pi's `/ollama-cloud-usage` command. The host resolves a static API key from Pi's
auth.json or OLLAMA_API_KEY; credentials never cross host RPC or appear in
reports. Executable credential sources/custom registries are unsupported and
shown as unavailable; no shell credential command is evaluated. Opening a
quota view makes no model call. Reads are cached for three minutes per host
and refreshed on demand or before a later model start; there is no polling.
A failed refresh does not release the last known exhausted quota. A positive
remainder is a snapshot, not a reservation or a guarantee for the next task.
Purchased credits never authorize paid overage automatically.

Check `bb team report` before assigning a large package: it includes returned
Ollama quota windows, reset times and when they were checked. Ollama models
share their account's quota. Known Pi Ollama/OpenRouter services are distinct
upstream pools; ambiguous services/account data remain conservatively pooled.

In the employee card, Pause holds future turns (human messages included) for
that role and its helpers; it does not interrupt active operations. BB Send-now
remains a core override. Resume releases existing queued work and checks ready
packages. Team pause remains separate.

Choose an explicitly approved backup to prepare a handoff using the existing
checkpoint/replace protocol: same task, role and Git environment/dirty files.
The new session stays paused until explicitly resumed. Live work, queued inputs,
missing/stale checkpoint, unknown/exhausted Ollama backup quota and unfinished
replacements produce explicit errors rather than blind respawn/resend. Failure
keeps the role paused for inspection. A changed employee session or removed
approval rejects a stale action. Arbitrary paid/default substitution is absent.
This action changes the executing session/model for the same employee; it does
not silently assign an in-flight task to another permanent role.

The team-wide quota display is scoped to the canonical project host. Execution
admission and backup validation use the employee's actual environment host.
A different remote execution host is not represented by that one project-host
balance; multi-host quota aggregation remains outside this iteration.


### Guided recovery and the team summary

The main Team view explains current work, the next step and why a decision is
needed. Limits, quota diagnostics and historical holds are collapsed under
“Limits, quotas and history”. Historical unknown outcomes are not presented as
a demand to retry old work.

When the configured coordination task reaches its cap, the summary can grant
four additional lead turns for that task. This is an explicit potentially
billable action, not a policy-wide increase or a guarantee to complete a stage.
The decision is recorded in the chosen task tracker, counts remain intact,
and provider/team limits still apply. Replayed or stale requests do not grant
another allowance.

Employee → “Change provider or model” is one flow: select an exact model from
the actual environment's catalog, check handoff readiness, explicitly authorize
this choice, transfer work, then continue the paused new session. No fallback
configuration is required for this manual choice. It applies only to this task,
including its later sessions; the configured primary and automatic fallback
policy are unchanged. Price/remaining capacity are never inferred from a name
or a catalog entry. Known exhausted pools and unavailable model options refuse
before switching.

If an agent-authored checkpoint is missing/stale, the user can explicitly choose
recovery from the task and current files. The plugin captures only verified Git
facts and records prior progress as unconfirmed. It preserves any old checkpoint
in the task's decisions before replacing it; oversized history refuses instead
of trimming. The new model first inventories work, saves a substantive checkpoint
and asks about unverifiable external effects. It does not call the exhausted
model or treat the old output as a checkpoint. Busy/queued/uncertain operations,
missing environment access and Team limits are never bypassed by this option.


When there is no unfinished task, the same recovery flow saves a future primary
through the existing revision-checked role profile API, without restarting or
changing the current session. It refuses if work started while the form was
open. Actual current model metadata remains separate from the future profile.
Startup restoration now runs through the SDK background lifecycle after factory
registration, not before host RPC is available; no polling or observer model.
A global Team hold does not trigger checkpoint requests/cold replacement sessions,
and a worker's submitted review remains awaiting acceptance rather than an error.

### Quota headroom and deferred continuation

Team holds new Pi/Ollama Cloud turns at or below the team's remaining-quota
threshold (default 10%, editable under resource details). All account windows
matter; switching Ollama models does not change this shared quota. Checks run
before new turns, cached up to three minutes, and do not interrupt active work.
There is no quota polling or model call to monitor the account. Other projects
may consume the same account, so the threshold is headroom, not a guarantee.

After an early quota hold, a positive balance alone does not authorize restart.
In an employee card, explicitly continue the queue, select an independent
approved model, or choose **Continue later**: 30 minutes, two hours, after all
limiting windows reset, or a local date/time. BB's native `sendAt` queue owns the
schedule. The original pending row is moved; a failed turn uses native retry.
Idle employees without queued work are not started. Multiple pending rows need
inspection in the native thread queue first. Scheduling never increases a task
or team budget, clears a team pause, or creates a new session. A paused employee requires an
explicit checkbox to replace its manual pause with the scheduled wait; a new
manual pause after scheduling still holds the deadline.

At the deadline Team rechecks the exact session/task/queued row, fresh Ollama
headroom and execution budgets. A changed task, unknown/low balance, unrelated
error or exhausted Team budget requires another human decision, without a
retry loop. Other providers use known BB exclusions; Team cannot assert their
unknown remaining balance. Cancellation leaves the employee paused and deletes
only its own retry row; an existing user row keeps its content and prior date.
A lost queue RPC response requires inspection, never blind duplicate retry.

### OpenRouter behind different agents

OpenRouter quota belongs to the upstream connection, not the BB provider name.
Team reads its fixed `GET /api/v1/key` endpoint on the actual execution host.
Standard Pi OpenRouter auth and a unique official Qwen Code model profile are
recognized. Arbitrary wrappers need an explicit `quotaSource` on the role:

```yaml
quotaSource:
  service: openrouter
  credentialEnv: AGENT_OPENROUTER_KEY # variable name only; never the secret
```

The same controls are in templates, Add executor and the employee's **Models
and quota profile**. This selects the source for current quota checks; it does
not change the agent's credentials or model connection. Templates are copied,
not live-linked. Omit `quotaSource` for automatic detection. Unsupported launch
or project overrides, executable auth and ambiguous profiles remain unknown;
Team never substitutes another agent's key. For wrappers, the operator must
select the variable containing the key actually used by that connection.

Daily free requests, key spending caps, applicable budgets and account balance
are separate. Null is unknown/unset, not zero. The account credits endpoint is
queried with the same credential; if management permission is absent, only that
balance remains unknown. Team does not request a management key or enable paid
usage. Per-minute/upstream-model availability is not confirmed by daily counts.
Identical opaque key identities group employees; different keys do not prove
independent accounts. Automatic quota fallback never treats two known
OpenRouter launchers as independent merely because their BB provider differs.

Existing threshold, durable pause/decision and native delayed continuation
apply to known OpenRouter free-request and monetary limits. Paid caps are not
misrepresented as free-request counts. An explicit resume/due-time continuation
requires fresh relevant capacity; failure keeps the wait, not an automatic retry
loop. Unknown first-time counters are shown as unknown, not availability.
Checks are cached up to three minutes before turns, not model-API request by
request; a single active turn or other users can exhaust quota during that time.
The reserve reduces risk and does not guarantee uninterrupted completion.

### Restoring an archived session binding

If Team hides an existing employee behind a pointer to an archived session,
its main panel shows **Team sessions need recovery**. **Restore binding** only
adopts a unique, already marked live session in the same environment, after
checking that no replacement is unfinished. It leaves the employee paused,
preserves tasks/budgets and never spawns or sends a message. Open the employee
card afterwards and explicitly continue when ready. Multiple candidates,
inaccessible old state and environment differences require inspection.
If all sessions for a role were archived, **Create missing** creates a new
session and starts its model; it is a separate action, not read-only recovery.
Creation refuses hidden/uncertain candidates rather than adding duplicates.

A blocked quota recovery on the current session is different from a retired old
session. If the quota reset but the saved decision hold remains, open **Limits,
quotas and history**, record the decision for that task, then **Allow next start
with this decision**. A reset does not itself authorize execution. This action
keeps existing budgets and still checks provider capacity; no replacement is
required merely to release a grounded current-session hold.

### Execution diagnostics and unfinished replacement

Employee diagnostics separate tracker status from confirmed activity. Pending or
idle sessions are not active work. The execution history keeps technical events
for 30 days, up to 2000 per team; its JSON export excludes prompts and raw errors.
Use the employee's Inspect session recovery flow for an existing partial switch;
inspect its exact session/queue and confirm the server-checked action. Never
resend unknown input or spawn another candidate blindly. Reset time alone is not
fresh quota confirmation. A handoff carries the original task's instructions,
criteria and decisions as well as its checkpoint. It does not grant acceptance
permission or erase a requirement to wait for an external reviewer.
