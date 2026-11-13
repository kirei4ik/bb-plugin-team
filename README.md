# bb-plugin-team

Role-based agent teams for [bb](https://getbb.app): a lead that plans and
accepts work, and executors (developer, junior, tester, writer, …) that report
back to it. Several teams per project, created from templates.

Русская версия: [README.ru.md](README.ru.md).

## Install

```bash
bb plugin install git:https://github.com/kirei4ik/bb-plugin-team.git@^0.2.0
# or, for development, from a local checkout:
bb plugin install /path/to/bb-plugin-team
```

## Quick start

From the **Team** panel in the navigation rail:

1. The panel lists every project in three groups — *with teams*, *a team can
   be created*, *cannot be created now* (with the reason) — sorted by name,
   with search on top.
2. Open a project, pick a template, adjust roles, providers and models, and
   press **Create team**. A role whose provider is disabled blocks creation.
3. The project's teams appear as a tree: lead → executors → helpers, each row
   with its status, model and current work package. Click a row for actions:
   open, message, hand out a package, stop.

From the CLI (inside a project thread, or with `--project`):

```bash
bb team init --team core --template dev   # .bb/teams/core.yaml + role prompts
bb team doctor --team core                # providers, environments, prompts, git
bb team create --team core                # spawn the threads
bb team status                            # every team of the project
```

## Teams, files and git

| What | Where |
|---|---|
| Team config | `.bb/teams/<team>.yaml` (legacy `.bb/team.yaml` = team `main`) |
| Role prompts | `.bb/teams/<team>/<role>.md` |
| Keeps a team out of git | `.bb/teams/.gitignore` |

New teams are **not versioned** by default. `bb team version on --team core`
(or the panel checkbox) starts tracking them; `off` stops. If the root
`.gitignore` ignores the whole `.bb/`, replace it with `.bb/*` and
`!.bb/teams/` first; the plugin tells you so.

Team threads are titled with the **title format** setting, by default
`👥 {team} · {role}`; the team name is dropped while the project has one team.
Each team gets its own sidebar section (`Team`, `Team · qa`).

## Templates

Built-in: `dev` (lead, developer, junior on a cheap model, tester — the
default, tuned for code quality on a small token budget), `qa`, `docs`,
`product` (manager, analyst, writer). Templates are shared by every project on
the server:

- Settings → Team: edit, duplicate built-ins, create from role kinds with
  prepared prompts.
- CLI: `bb team template list | show | save | delete`;
  `save <id> --kinds lead,developer,junior,tester`, `--from-team core`,
  `--from-template dev`.
- Panel: **⋯ → Save as template** on a team.

Settings → Team provides a dropdown for the default template and the same
role editor for built-in and saved templates. Duplicate a built-in before editing.
BB’s provider/model picker preserves model, reasoning level, and service tier.
Unavailable stored models are retained until explicitly changed. Insert starter
prompts without an AI call. The separate prompt-draft model selection currently
only stores the generator preference.

After changing language, explicitly run `bb plugin reload team` to refresh
native settings labels.

A role without `prompt`/`promptFile` gets the short built-in prompt of its
`kind` (lead, developer, junior, tester, reviewer, writer, analyst, devops,
manager; `developer-2` counts as `developer`).

## Working with a team

```bash
bb team task add developer "Login form" --note "criteria" --send   # tracked package
bb team task update 3 --status review --review '{"result":"Implemented", "checks":[{"what":"Smoke test","result":"passed"}]}'
bb team task done 3 --reason "Criteria met" --expected-submission <report-id> # lead
bb team tell tester --message "rerun smoke"   # or "all"
bb team add-role junior --provider pi --model qwen3
bb team add-role reviewer --thread thr_…      # adopt a free thread
bb team pause [--stop] / bb team resume
bb team stop [<role>|all]
bb team replace developer [--keep]        # fresh thread with a handoff
bb team report --out "$BB_THREAD_STORAGE/team.html"   # inline-vis digest
bb team retitle                           # re-apply the title format
```

- **Helpers**: a thread spawned under a team thread is a helper of that role.
- **Pause** holds agent and plugin-relayed messages to executors; humans are
  never held.
- **notifyOn: [idle, error]** on a role wakes the lead after that role's turns.
- `bb team create` is safe to re-run: it spawns only missing roles and
  re-links executors that lost their lead.

## Config reference

```yaml
version: 1
title: Development team
vars:                       # {{vars.<name>}} in prompts and environments
  testEnv: env:env_abc123
defaults:
  environment: checkout     # checkout | default | worktree | env:<id>
  parentNotifications: stuck
roles:
  - name: lead
    kind: lead
    lead: true
    provider: codex
    promptFile: .bb/teams/core/lead.md
  - name: junior
    kind: junior
    provider: pi
    model: qwen3-coder
    notifyOn: [idle]
  - name: tester
    environment: "{{vars.testEnv}}"
    threadId: thr_abc123    # adopt an existing thread
```

Role fields: `name`, `kind`, `title`, `provider`, `model`, `reasoningLevel`,
`serviceTier`, `permissionMode`, `environment`, `parentNotifications`, `lead`,
`enabled`, `notifyOn`, `threadId`, `prompt` / `promptFile`. Prompt
placeholders: `{{teamName}}`, `{{leadThreadId}}`, `{{leadThreadRef}}`,
`{{role.<name>.threadId}}`, `{{role.<name>.ref}}`, `{{projectId}}`,
`{{workspacePath}}`, `{{vars.<name>}}`. A full example lives in
[examples/teams](examples/teams).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `language` | `en` | CLI, panel and template language (`en`, `ru`) |
| `teamSection` | on | a sidebar section per team |
| `roster` | on | roster message to the lead after create |
| `titleFormat` | `👥 {team} · {role}` | team thread titles |

## Development

```bash
npm install
npm test          # vitest: logic, CLI on a fake host, panel in jsdom
npm run typecheck
bb plugin build && bb plugin reload team
```

MIT licensed; see [LICENSE](LICENSE).

## Beads and session handoff

`bb team tracker beads|builtin|default --project <project>` selects one tracker
for every team and worktree of the project. The project override takes precedence
over the plugin's `defaultTracker` setting (initial default: Beads). `default`
clears the override. Beads errors are explicit; no fallback or automatic migration
occurs. Existing built-in packages remain available by explicitly selecting `builtin`.
Before changing backends, finish packages and replace consumed sessions with
fresh ones; execution references are not migrated. Pinning the currently effective
backend explicitly does not require another session.

Team creation prepares Beads in the project's canonical checkout: it reuses an
existing database or initializes a missing local database using fixed
`--stealth --skip-agents --skip-hooks --init-if-missing` flags. This leaves HEAD
and the Git index unchanged and adds local exclusions to `.git/info/exclude`.
Corruption or an
unavailable database is an explicit error; dry-run never initializes one.
No execution-worktree database is created. The host entry runs `bd`
there on its owning machine, independently of each role's execution worktree.
Team issues use label `bb-team:<team>` and assignee `<role>`; existing issues can
be explicitly assigned with `bd update <id> --assignee <role> --add-label bb-team:<team>`.
IDs remain stable strings. Review uses `in_progress` plus `bb-state:review`;
cancellation uses `closed` plus `bb-state:dropped`. Content, acceptance criteria,
priority, dependencies, decisions, results and checkpoints belong to Beads;
`task update --note` edits its description. No duplicate task cards are persisted.

One session executes one package. Executors save a substantive checkpoint before
review. After acceptance, Team replaces the consumed session automatically when
a next package is ready and all operations have finished. Without ready work it
keeps the session; without a fresh checkpoint it waits for one. Ambiguous failures
require human inspection. To hand off manually, write a JSON file
with `goal`, `criteria` (array), `progress`, `decisions` (array of `{what,why}`),
`checks` (array of `{what,result}`), `blockers` (array), `nextAction`, and `files`
(array). Save it with `bb team checkpoint <id> --file <absolute-json-path>`, then,
after the turn/background operations finish, run `bb team replace <role>`.
Pass `--project` and `--team` to both commands when needed. The lead also needs
a coordination task and checkpoint. A checkpoint of a ready TODO starts that
package in the current session. Checkpoints are capped at 64 KiB; built-in
storage also retains its existing 256 KiB KV limit.

The new session is created with its initial prompt held in the core BB queue by
`message.dispatch`; Team releases that existing request only after switching and
archiving. A pending status is accepted only for a single request held by Team.
Run `team resume` after a release failure; do not create a second prompt.

The checkpoint includes the original environment, branch, HEAD and a fingerprint
of staged, unstaged and untracked contents. Replacement reuses that environment,
checks the saved state, changes role routing, reparents children and retires the
old session before starting the new one. It refuses active operations, queued
messages/interactions, stale checkpoints, missing environments, dirty submodules,
and descendants owned by the old thread through immutable lifecycle ownership.
A Git checkout with a HEAD commit is required. Address messages through
`bb team tell <role>`; `lead` resolves the configured lead role. Important review
and failure events notify the lead; use `tell lead` for blockers/decision requests.
Idle notifications remain opt-in.

Use `doctor` and `replace <role> --dry-run --json` to inspect partial replacements.
Retrying `replace` resumes on the recorded thread. Before the canonical switch,
`replace <role> --abort` restores the original session; after the switch recovery
must finish forward. If a spawn response was lost, explicitly confirm its held
candidate with `replace <role> --thread <new-id>` after inspection. Uncertain
prompt delivery is never retried automatically: inspect the new thread before
sending a message to the role manually. `resume` also rechecks queued readiness
after external dependency changes.

See [README.ru.md](README.ru.md) for a complete checkpoint example.
`npx vitest run acceptance.test.ts` exercises real temporary Git worktrees and
Beads without model calls; BB threads are SDK fixtures, so this does not verify
the installed server's live UI/provider behavior.

## Saved model choices

Role templates retain provider, model and reasoningLevel. The plugin setting
`defaultTemplate` selects the template for new teams in the panel and CLI; an
explicit `--template` takes precedence. Existing teams keep their own configuration.
For a saved `ollama-cloud` template, use
`bb plugin config team set defaultTemplate ollama-cloud`. Missing templates fail
explicitly instead of choosing another provider/model.

The lead receives persistent planning instructions for the selected tracker,
including acceptance criteria, dependencies, order and role assignments. It asks
about product priorities, scope and material costs; a planning request alone does
not authorize implementation. Custom prompt files are preserved. The Team task
table displays the Beads assignee; use `bd show <id>` to inspect it directly or
`bd list --assignee <role>` to filter work.

## Continuing a long task

`bb team checkpoint <id> --file <absolute-json-path> --rotate` saves a handoff
and requests replacement of the current task session after operations finish.
The same task ID, environment, branch and dirty files continue in the new session.
Lead rotation also needs a linked coordination task.

At idle boundaries Team reads the provider's context usage in code. A valid
non-estimated reading of at least 80% requests a handoff; null, invalid or
estimated readings do not trigger threshold rotation. The Pi reading observed
in this environment is estimated, so agents use the explicit request path.
No extra model call measures context. Ambiguous replacement results require
human inspection rather than a duplicate spawn/send.

### Work session state in the panel

The employee card shows the current thread, linked task, context counter accuracy, saved handoff state and waiting reason. Viewing or refreshing it does not call a model. “Save state and replace session” may start the agent to prepare a checkpoint; active operations are not interrupted. A linked task is required, including a coordination task for the lead. Estimated counters do not trigger automatic rotation at 80%.

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
