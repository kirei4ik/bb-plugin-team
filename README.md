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

A role without `prompt`/`promptFile` gets the short built-in prompt of its
`kind` (lead, developer, junior, tester, reviewer, writer, analyst, devops,
manager; `developer-2` counts as `developer`).

## Working with a team

```bash
bb team task add developer "Login form" --note "criteria" --send   # tracked package
bb team task update 3 --status review     # executor: done, waiting for review
bb team task done 3                       # lead only
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
