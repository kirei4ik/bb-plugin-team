# Changelog

## 0.2.2 — 2026-11-13

- Project-wide tracker selection: Beads by default, built-in tracker retained.
  Missing Beads databases are prepared in the canonical checkout without a Git
  commit; failures are explicit. Existing tasks are not silently migrated.
- Durable checkpoints, environment-preserving session replacement, role routing,
  one active package per role and event-driven session/context continuation.
- Localized settings, unified template/employee model editors, default-template
  picker and starter prompts. Unknown saved selections are preserved.
- Grounded review/acceptance with submission references and concrete rework.
- Finite task attempts and team start budgets, available cumulative usage,
  resource holds and explicitly approved quota handoffs.

### Upgrade notes

Requires BB >=0.49 and Plugin SDK >=0.6.132. Beads mode was tested with bd 1.3.1.
The default resource limits are 8 task work units (start admissions + review
returns) and 100 team start admissions; adjust them with grounds in Resources.
`task done` now requires acceptance grounds; a lead references the reviewed
submission. New/replacement sessions receive updated instructions. Existing
threads, model choices and user templates are not automatically rewritten.
Quota handoff stops for accepted input, uncovered history or missing/stale
checkpoints. Money and provider-internal request limits are not guaranteed.
AI prompt generation remains deferred in its own epic.
