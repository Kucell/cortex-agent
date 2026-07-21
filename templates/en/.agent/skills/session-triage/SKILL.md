---
name: session-triage
description: Decide whether to open a Mission + Run based on session signals (turns, debug keywords, tool failures). Open, observe, record-tool. Keeps active-task persistence automatic per `runtime-state-required`.
---

# session-triage (L1 audit-trail — Phase 1)

Decide whether the current session warrants an active-task persistence
record (mission + run + structured events).  When it does, open both in
one shot.  When the agent makes observations or hits tool failures, log
them as typed events so a fresh agent / a future session can resume.

## When to Use

- SessionStart hook fires and the session has 3+ turns of investigation / debug work → run `triage` automatically.
- At any time during the session, when the user surfaces an observation → run `observe --message "…"`.
- After any tool failure → run `record-tool --tool <name> --exit <n> --stderr "…"`.

## Commands

### 0. `triage` — decide & open if warranted

```bash
node .agent/skills/session-triage/scripts/index.js triage \
  --threshold 3 \
  --signal-file /tmp/session-signals.json  # optional, defaults to stdin
```

Reads a JSON `{ turns: N, text: "...", tool_failures: N, user_questions: N }`.
Prints `{ open: bool, mission_id?: "M-NNN", run_id?: "R-...", reason }`.
Side-effect (when `open: true`): invokes `management-api` to create
both a mission and a run via existing endpoints (`missions/M-NNN/`,
`runs/R-...json`). Pure logic when stdin is empty / signals weak —
prints `open: false` and exits 0 (no failure).

### 1. `observe` — log a human observation

```bash
node .agent/skills/session-triage/scripts/index.js observe \
  --run-id <id> --message "user observed canvas render area disappeared" \
  [--phase triage|investigation]
```

Appends a `human_observation` event to the run's events[].

### 2. `record-tool` — log a tool failure

```bash
node .agent/skills/session-triage/scripts/index.js record-tool \
  --run-id <id> --tool bash --exit 1 --stderr "ENOENT: no such file" \
  [--phase investigation]
```

Appends a `tool_failure` event.

### 3. `investigation-step` — log a deliberate step

```bash
node .agent/skills/session-triage/scripts/index.js step \
  --run-id <id> --message "read .agent/missions/M-012/follow-ups.md"
```

Appends an `investigation_step` event.

## Implementation Notes

- Pure CLI; no daemon, no network.
- Reuses `management-api runs event` from the existing library so event-type enum stays in one place. See `templates/{zh,en}/.agent/runs/run.schema.json` for the new enum values.
- Auto-generated `mission_id` reads `.agent/missions/` to compute `max(NNN) + 1` (skips gaps when a mission is archived).
- Auto-generated `run_id` reads `.agent/runs/` similarly.

## Guarantees

- **No destructive action**: every action is additive; never overwrites existing.
- **Idempotent on retry**: re-running `triage` with the same signals won't double-open (skips if a recent run with the same `slug` exists in 24 h).
- **Audit-friendly**: every action prints `ok: true / action / path`.

## Non-Goals

- Does not auto-close missions — that's user / owner work.
- Does not read transcript content (Phase 2 concern).
- Does not promote events to `experiences/` automatically.

## Relation

- `management-api` — writes via runs event / runs upsert.
- `mission` — creates new mission when open.
- `runtime-state-required` rule — defines the trigger.
- Phase 2 (`audit-trail-transcript-link`) — relies on event types this skill emits.
