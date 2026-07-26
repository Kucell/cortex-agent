# Dispatch Runtime Contracts — Phase 0

This directory freezes three terms for Cortex Agent v1.7.0. Phase 0 provides contracts and fail-closed CLI discovery only; it does not execute work or start background processes.

## Vocabulary

### Dispatch

A single explicit or triggered attempt to hand an already-approved task to an execution agent and record its Run journal. A future Dispatch implementation must validate idempotency, concurrency, queues, locks, and workflow gates before execution.

### Daemon

An optional local user-space coordinator that may poll Queues and Decisions and request Dispatch. It is **disabled by default**, requires explicit user startup, and must never bypass workflow-owned state transitions.

### Trigger

A declarative request telling a future Daemon when to consider Dispatch. A Trigger is not authorization. `schedule`, `file_change`, and `post_commit` require explicit opt-in; Phase 0 does not create or consume Trigger records.

## Boundaries

- Management API remains the query and controlled Run-journal layer; it is not the scheduler.
- Coordinator selects ownership and handoff; Dispatch determines when approved execution starts.
- Decision, Waitpoint, Progress Lock, Queue, Mission, Worktree, and Ship gates remain authoritative.
- Dashboard controls do not directly mutate Dispatch state.
- Phase 0 CLI commands are stubs and perform no runtime writes.

## CLI Surface

```bash
cortex-agent dispatch <task-id> [options]
cortex-agent daemon <start|stop|status> [options]
cortex-agent trigger <create|list|disable> [options]
```

Use `cortex-agent help <command> --json` for discovery. Executing a Phase 0 stub fails closed with `PHASE_ZERO_STUB` and exit code `2`.

## Schemas

- `trigger.schema.json`: declarative Trigger request; opt-in requirements are explicit.
- `daemon-state.schema.json`: recoverable state for a future optional Daemon.
- `idempotency.schema.json`: durable future Dispatch deduplication record.

## Non-Goals

Phase 0 does not implement `dispatch-state`, dry-run planning, task execution, Daemon polling, schedules, file watching, post-commit actions, automatic merge, Ship, deployment, or Decision resolution.
