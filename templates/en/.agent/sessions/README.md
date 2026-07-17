# Sessions

Session records describe active agent processes, dashboard-manager servers, or long-running worktree owners.

Management API marks a running or paused session as `stale` when `last_heartbeat_at` is older than five minutes.

Sessions may include `phase`, `activity`, `current_run_id`, and `current_task_id` so dashboards can distinguish idle services from sessions that are actively decomposing tasks, invoking agents, editing files, or validating.

Session writes must be routed through explicit workflow or owner-process gates. Management API may derive `stale` at read time, but read-only queries must not rewrite session status just because a heartbeat is old.

The owner opens and heartbeats a session with the same `agent_id`. Pause and close operations also declare `--gate owner|handoff|user|mission`; owner-gated transitions reject mismatched agents.

See `.agent/skills/management-api/write-gates.md` for the write gate contract.
