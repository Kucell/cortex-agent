# Management API Write Gates

Management API is query-first. Runtime mutations must stay narrow, explicit, and recoverable.

## Allowed Direct Write

| Command | Scope | Reason |
| :--- | :--- | :--- |
| `runs checkpoint` | `.agent/runs/*.json` | Append/upsert observable execution state. |
| `runs upsert` | `.agent/runs/*.json` | Low-level run state upsert for specialized callers. |
| `runs event` | `.agent/runs/*.json` | Low-level append-only event writer. |

No Management API command may directly mutate task-progress, locks, worktrees, proposals, queues, or sessions unless a future milestone adds an explicit workflow gate.

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
- Every mutating gate must have a human-readable reason and timestamp.
- Risky actions require `/approve` or an explicit user command.
- Dashboard controls may request a decision; they must not directly mutate queue/session state.
- Future daemon/dispatch layers consume these gates; they do not replace them.
