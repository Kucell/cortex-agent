# Queues

Queue records describe parallel or worktree execution batches, concurrency limits, and task item states.

Queue items may include `phase`, `activity`, `run_id`, and `updated_at` so dashboards can show which queued item is decomposing, invoking an agent, editing, validating, blocked, or done.

Queue writes must be routed through explicit workflow gates such as `/parallel`, `/worktree plan`, `/approve`, or mission validation. Management API query commands may read queues, but they must not pause, resume, drain, or rewrite queue items directly.

Use `queues upsert --gate <gate>` for the batch and `queues item --gate <gate>` for one task. Supported gates are `parallel`, `worktree`, `approve`, and `mission`; missing gates fail closed.

See `.agent/skills/management-api/write-gates.md` for the write gate contract.
