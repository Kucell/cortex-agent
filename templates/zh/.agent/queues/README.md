# Queues

Queue 记录描述 parallel 或 worktree 执行批次、并发限制和 task item 状态。

Queue item 可以包含 `phase`、`activity`、`run_id` 和 `updated_at`，方便 dashboard 展示当前 item 正在拆解、调用 agent、编辑、验证、blocked 或 done。

Queue 写入必须经过显式 workflow gate，例如 `/parallel`、`/worktree plan`、`/approve` 或 mission validation。Management API query 命令可以读取 queues，但不得直接 pause、resume、drain 或重写 queue item。

批次使用 `queues upsert --gate <gate>`，单个任务使用 `queues item --gate <gate>`。支持 `parallel`、`worktree`、`approve`、`mission`；缺失 gate 时默认拒绝写入。

写入 gate 合约见 `.agent/skills/management-api/write-gates.md`。
