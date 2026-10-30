---
name: team
description: "Spawn a role-based agent team for a project (lead + executors) with bb team init/create/status from .bb/team.yaml; settings for language, sidebar section, and roster."
---

# Project agent team (bb team)

The `team` plugin spawns a persistent role-based team of threads for a project
(development lead, developers, testers — any roster). The lead is the head
thread; executors are its child threads and report to it by message.

## New-project flow

```bash
bb team init              # 1) template: .bb/team.yaml + .bb/team/roles/*.md
# edit .bb/team.yaml for the project
bb team create            # 2) spawn the team threads
bb team status            # 3) overview of config and threads
```

- `bb team init [--project <id|name>] [--force]` — write the config template
  and role prompts. `--force` overwrites existing files.
- `bb team create [--project <id|name>] [--dry-run]` — spawn threads from the
  config. `--dry-run` prints the plan without creating anything. Re-runs skip
  roles that already have threads and repair missing parent links.
- `bb team status [--project <id|name>]` — config and live team overview.

All commands accept `--json` and run from any thread or terminal.

## Adopting existing threads

Threads do not need to exist beforehand — `bb team create` spawns them. To
bind threads you already run, give the role a `threadId`:

```yaml
  - name: lead
    threadId: thr_abc123   # an existing thread becomes the lead
  - name: developer
    threadId: thr_def456   # becomes a child thread of the lead
```

The plugin marks them with team roles, repairs the parent link, and sends the
lead a roster. Provider, model, and title of adopted threads are not changed.
Adopted threads must not be archived; the error suggests `bb thread unarchive`.

## Plugin settings

Settings → Team (or `bb settings`):

- **Language** (`language`, `en` | `ru`, default `en`) — CLI output and
  scaffold template language (team.yaml comments, role prompts).
- **Team sidebar section** (`teamSection`, default on) — keep team threads in
  a dedicated sidebar section (Team / Команда). Created and adopted threads are
  moved there.
- **Send team roster** (`roster`, default on) — send the lead the roster
  message after `bb team create`.

## Config .bb/team.yaml

- `defaults.environment`: `checkout` (one shared working tree — template
  default) | `default` | `worktree` | `env:<id>`.
- `defaults.parentNotifications`: `stuck` — the lead is woken only on
  executor failures and blockers; finished reports arrive as messages.
- `roles[]`: `name` (unique), `title`, `provider`, `model`,
  `promptFile`/`prompt` (exactly one; not needed for adopted threads),
  optional `lead: true` (otherwise the first role), `enabled: false`,
  `environment`, `permissionMode`, `parentNotifications`, `threadId`.
- Prompt placeholders: `{{leadThreadId}}`, `{{leadThreadRef}}`,
  `{{role.<name>.threadId}}`, `{{role.<name>.ref}}`, `{{projectId}}`,
  `{{workspacePath}}`.
- Disabled providers fail fast with the exact `bb provider enable` hint.

## Not global

The plugin does nothing in projects without `.bb/team.yaml`: it is opt-in per
project via `bb team init`.