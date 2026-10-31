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
bb team task done <id>                     # only the lead accepts
bb team report --out "$BB_THREAD_STORAGE/team.html"   # prints an inline-vis directive
bb team pause [--stop] / bb team resume    # hold agent messages to executors
bb team stop [<role>|all]                  # stop running threads (default: executors)
bb team replace <role> [--keep]            # fresh thread + handoff (last report, open packages)
```

Delegate by difficulty: simple, well-specified work to `junior` (a cheap
model), complex work to `developer`, verification to `tester`.

## Working as an executor

Report to the lead with `bb thread tell <lead-thread-id> --message-file -`.
When a package is done, run `bb team task update <id> --status review`. Only
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

`language` (en | ru), `teamSection` (a sidebar section per team), `roster`
(roster message to the lead after create), `titleFormat` (default
`👥 {team} · {role}`; `{team}` is dropped while the project has one team).
