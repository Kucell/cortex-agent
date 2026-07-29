---
description: Read-only dispatch dry-run (FAE-003) and explicit manual dispatch (FAE-004) for cortex-agent.
---

# Dispatch (FAE-003 / FAE-004)

`cortex-agent dispatch` ships two manually-triggered surfaces:

- `dispatch dry-run <task-id>` (FAE-003): read-only plan preview. Never writes
  to `.agent/`, never spawns subprocesses, never opens network sockets.
- `dispatch <task-id>` (FAE-004): explicit manual dispatch. Requires an
  approved Decision, an idempotency key, a host, and a gate. Persists a
  7-day idempotency record under `.agent-runtime/dispatch/idempotency/`.

`dispatch execute` / `dispatch daemon` / `trigger` remain Phase 0 stubs
(no execution, no daemon, no trigger, no automatic fallback).

## Dry-run (FAE-003)

```bash
cortex-agent dispatch dry-run <task-id> \
  [--idempotency-key <key>] \
  [--concurrency-key <scope>] \
  [--queue <queue-id>] \
  [--output json|human] \
  [--fail-on-conflict]
```

The dry-run reports `would_proceed`, `idempotency.would_duplicate`,
`locks.would_conflict_with`, `concurrency.current_active`,
`worktree.would_create`, `next_run_event`, `errors`, and a
`mutation_evidence` summary (always zero on success).

## Explicit dispatch (FAE-004)

```bash
cortex-agent dispatch <task-id> \
  --idempotency-key <key> \
  --host <claude-code|pi|codex|cursor> \
  --gate <mission|agent|user|owner> \
  [--ttl <seconds>] [--no-rollback] [--force] \
  [--output json|human]
```

The dispatch composes (in order):

1. **Idempotency short-circuit**: same key + accepted status returns the
   existing record.
2. **Approval gate**: an approved Decision in `.agent/decisions/` whose
   `relations.task_ids` includes `<task-id>`.
3. **Plan gate**: `dispatch-plan.resolveDispatchPlan` returns
   `would_proceed=true` (no lock / lease / idempotency conflict).
4. **Lease acquire**: `cortex-agent lease acquire --scope task:<task-id>
   --owner <host> --idempotency-key <key>` (fencing token recorded).
5. **Capability-aware dispatch**: composes the audited owner that emits
   Operation / boundary events.
6. **Coordination Task**: `CoordinationApplicationService.submit` with the
   full event envelope (`task.created`, journal_only notification).
7. **Idempotency persistence**: `.agent-runtime/dispatch/idempotency/<key>.json`
   (fsync + 0o600 + atomic rename, 7-day retention).
8. **Notification handshake**: `createNotificationHarness(root)` reports the
   available harness state; no spawn, no network.

If any gate fails after the lease is acquired, the lease is released and
the idempotency record is marked `failed`. The dispatch **fails closed**.

## Boundaries

- Manual trigger only. `automatic_dispatch_enabled` and `daemon_enabled`
  remain frozen `false`.
- No subprocess spawn, no network socket, no credential access.
- No writes to `.agent/` (read-only sources for the plan and approval
  lookup). Writes limited to `.agent-runtime/dispatch/idempotency/` and
  `.agent-runtime/coordination/` (lease state + journal).
- No git stage / commit / push / merge / force-push / publish / release /
  install / update.
- Sensitive-evidence strings (`sk-…`, `MINIMAX_API<KEY>`, `MINIMAX<TOKEN>`,
  `api[-_]?key`, `password`) are rejected at the argument boundary.

## Cross-references

- FAE-003 proposal: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-003-dispatch-dry-run.md`
- FAE-004 proposal: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-004-dispatch-execution.md`
- FAE-007 public lease: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-007-public-ownership-lease.md`
- Mission M-013: `.agent/missions/M-013/mission-plan.md`
- Reusable resolver: `lib/dispatch-plan.js`
- Executable dispatch: `lib/dispatch-execute.js`
- Compatibility fallback retired: `.agent/workflows/launch-governed-agent.md`