# Management API Write Gates

Management API is query-first. Runtime mutations must stay narrow, explicit, and recoverable.

## Allowed Direct Write

| Command | Scope | Reason |
| :--- | :--- | :--- |
| `runs checkpoint` | `.agent/runs/*.json` | Append/upsert observable execution state. |
| `runs upsert` | `.agent/runs/*.json` | Low-level run state upsert for specialized callers. |
| `runs event` | `.agent/runs/*.json` | Low-level append-only event writer. |
| `queues upsert --gate ...` | `.agent/queues/*.json` | Create or update a workflow-owned queue. |
| `queues item --gate ...` | `.agent/queues/*.json` | Update one task item under its owning workflow. |
| `sessions open/heartbeat` | `.agent/sessions/*.json` | Owner-process lifecycle and heartbeat. |
| `sessions pause/close --gate ...` | `.agent/sessions/*.json` | Explicit owner, handoff, user, or mission transition. |
| `inbox send/transition --gate ...` | `.agent/inbox/*.json` | Workflow creation and recipient-owned message lifecycle. |
| `decisions request --gate ...` | `.agent/decisions/*.json` | Create an open, resource-bound approval request. |
| `decisions resolve --gate user` | `.agent/decisions/*.json` | Record an explicit human choice, resolver, and rationale. |
| `decisions supersede --gate requester` | `.agent/decisions/*.json` | Link an open Decision to a compatible open replacement owned by the same requester. |
| `waitpoints create --gate ...` | `.agent/waitpoints/*.json` | Block a risky action under its owning workflow. |
| `waitpoints release --gate owner` | `.agent/waitpoints/*.json` | Consume a matching approved Decision as release evidence. |
| `waitpoints cancel/expire --gate ...` | `.agent/waitpoints/*.json` | Explicit terminal transition by owner, Mission, or user; expiry also checks elapsed time. |

No Management API command may directly mutate task-progress, locks, worktrees, or proposals. Queue/session commands reject missing or invalid gates, and heartbeats reject a mismatched owner.

## Decision And Waitpoint Gates

- A caller-provided gate string is routing metadata, not approval evidence.
- Decisions are created `open`. Only `decisions resolve --gate user` may record approve, reject, or revise, and it must include `resolved_by` and a non-empty rationale.
- Decision resolution is terminal. A changed choice requires a new Decision instead of overwriting history.
- Superseding requires requester ownership, a compatible open replacement, and rationale; it cannot approve either Decision.
- Every Decision and Waitpoint binds an exact `gate.action` and `gate.resource_ref`. Architecture baseline approval uses `architecture`; risky execution uses `merge`, `release`, `destructive`, `credential`, or `external_side_effect`.
- `waitpoints release` fails unless the linked Decision is approved, selected `approve`, has resolver evidence, exactly matches both gate fields, and the Waitpoint has not expired.
- Invalid caller-provided date-time values are rejected before writing any state.
- Waitpoint release records the Decision path in `evidence_refs`; it does not mutate Task gate ownership.
- Dashboard rendering and read-only query commands never resolve or release these objects.

## Queue Write Gates

Queue writes are higher-risk because they can change execution ordering and concurrency. They must be routed through workflow-approved gates.

| Desired Action | Required Gate | Required Evidence | Forbidden Shortcut |
| :--- | :--- | :--- | :--- |
| create queue | `/parallel` or `/worktree plan` | task list, dependency analysis, concurrency reason | dashboard button directly writes queue |
| pause queue | `/approve` decision or explicit user command | reason, impacted tasks, resume condition | auto-pause from dashboard render |
| resume queue | `/approve` decision or explicit user command | no conflicting locks, queue items still valid | daemon resumes without approval |
| drain queue | `/mission validate` or `/worktree validate` result | all items done/waived/blocked with follow-up | deleting queue state to hide failures |
| update item state | owning workflow step | run_id, task_id, phase/activity, timestamp | arbitrary Management API mutation |

Queue state should remain JSON and local-first. The write path must record a Run journal checkpoint for visibility.

## Session Write Gates

Session writes represent active processes, dashboard servers, or worktree owners. They must not hide stale or unsafe work.

| Desired Action | Required Gate | Required Evidence | Forbidden Shortcut |
| :--- | :--- | :--- | :--- |
| open session | workflow or dashboard server start | agent_id, role, started_at, worktree/session scope | implicit open during read-only query |
| heartbeat session | owner process only | session_id, last_heartbeat_at, activity | unrelated agent refreshes heartbeat |
| pause session | explicit user command or handoff gate | reason, current_run_id/task_id, resume path | dashboard pauses silently |
| close session | owner process, `/handoff`, or explicit user command | final status, locks released/transferred | deleting stale session file |
| mark stale | Management API read model | heartbeat older than threshold | mutating status just because it is stale |

Management API may report stale sessions from read-time derivation. It should not rewrite session status to `stale` merely because a query ran.

## Safety Rules

- All queue/session write gates must be additive to current read behavior.
- Persist runtime JSON through atomic replacement; do not leave partial files visible to readers.
- Every mutating gate must have a human-readable reason and timestamp.
- Risky actions require `/approve` or an explicit user command.
- Dashboard controls may request a decision; they must not directly mutate queue/session state.
- Future daemon/dispatch layers consume these gates; they do not replace them.
