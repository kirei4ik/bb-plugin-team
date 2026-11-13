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

### Finite execution and team budget

Team keeps a durable technical execution ledger, including lead, executors,
helpers, review returns, system retries and old sessions. Defaults are 8 task
attempt units (start admissions + review returns) and 100 team start admissions.
The Resources panel edits these limits, optional reported-token/minute caps,
and records a concrete manual decision. Increasing limits never resets counts.
A task hold requires a concrete changed approach, recorded in the selected
tracker. Creating another card/session cannot escape an exhausted unfinished
task budget. An automated close/drop does not release an exhausted task budget. Explicit
manual grounded acceptance or a manual resource decision can release that hold;
the team budget continues. Already active work is not interrupted.

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
