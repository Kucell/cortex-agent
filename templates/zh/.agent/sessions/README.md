# Sessions

Session 记录描述活跃 agent 进程、dashboard-manager server 或长时间运行的 worktree owner。

当 `last_heartbeat_at` 超过五分钟时，Management API 会在读取时把 running 或 paused session 标记为 `stale`。

Session 可以包含 `phase`、`activity`、`current_run_id` 和 `current_task_id`，方便 dashboard 区分 idle service 与正在拆解任务、调用 agent、编辑文件或验证的 session。

Session 写入必须经过显式 workflow 或 owner-process gate。Management API 可以在读取时派生 `stale`，但 read-only query 不得仅因为 heartbeat 过旧就回写 session status。

Owner 使用相同 `agent_id` 打开并 heartbeat session。Pause/close 还需声明 `--gate owner|handoff|user|mission`；owner gate 会拒绝不匹配的 agent。

写入 gate 合约见 `.agent/skills/management-api/write-gates.md`。
