# bb-plugin-team

Role-based agent team for a BB project: a development lead plus executors
(developer, tester, …) configured in `.bb/team.yaml`.

```bash
bb plugin install .        # install once per server

# in a project:
bb team init               # template config + role prompts
bb team create             # spawn the team threads
bb team status             # overview
```

Settings (Settings → Team): `language` (en/ru) for CLI output and templates,
`teamSection` keeps team threads in a sidebar section, `roster` toggles the
roster message to the lead.

Details: `bb team --help`, the `team` skill (`skills/team/SKILL.md`).

Opt-in per project: does nothing in projects without `.bb/team.yaml`.

MIT licensed; see LICENSE.
