# Management API 写入 Gate

Management API 以查询为先。运行态写入必须保持范围窄、意图明确、可恢复。

## 允许直接写入

| 命令 | 范围 | 原因 |
| :--- | :--- | :--- |
| `runs checkpoint` | `.agent/runs/*.json` | 追加或更新可观测执行状态。 |
| `runs upsert` | `.agent/runs/*.json` | 面向特殊调用方的底层 Run 状态 upsert。 |
| `runs event` | `.agent/runs/*.json` | 底层 append-only event 写入。 |
| `queues upsert --gate ...` | `.agent/queues/*.json` | 创建或更新 workflow 所属 queue。 |
| `queues item --gate ...` | `.agent/queues/*.json` | 由所属 workflow 更新单个 task item。 |
| `sessions open/heartbeat` | `.agent/sessions/*.json` | owner process 生命周期和 heartbeat。 |
| `sessions pause/close --gate ...` | `.agent/sessions/*.json` | 显式 owner、handoff、user 或 mission 状态转换。 |

Management API 不得直接修改 task-progress、locks、worktrees 或 proposals。Queue/session 命令会拒绝缺失或无效 gate，heartbeat 会拒绝不匹配的 owner。

## Queue 写入 Gate

Queue 写入风险更高，因为它会改变执行顺序和并发。所有写入都必须通过 workflow 批准的 gate。

| 目标动作 | 必须经过的 Gate | 必要证据 | 禁止捷径 |
| :--- | :--- | :--- | :--- |
| 创建 queue | `/parallel` 或 `/worktree plan` | task 列表、依赖分析、并发理由 | dashboard 按钮直接写 queue |
| 暂停 queue | `/approve` 决策或显式用户命令 | 原因、受影响任务、恢复条件 | dashboard 渲染时自动暂停 |
| 恢复 queue | `/approve` 决策或显式用户命令 | 无冲突 lock，queue item 仍有效 | daemon 未经批准自动恢复 |
| drain queue | `/mission validate` 或 `/worktree validate` 结果 | 所有 item 已完成、豁免，或 blocked 且有 follow-up | 删除 queue 状态来隐藏失败 |
| 更新 item 状态 | 所属 workflow 步骤 | run_id、task_id、phase/activity、timestamp | 任意 Management API mutation |

Queue 状态应继续保持 JSON 与 local-first。写入路径必须记录 Run journal checkpoint，保证可观测。

## Session 写入 Gate

Session 写入代表活跃进程、dashboard server 或 worktree owner，不得掩盖 stale 或不安全工作。

| 目标动作 | 必须经过的 Gate | 必要证据 | 禁止捷径 |
| :--- | :--- | :--- | :--- |
| 打开 session | workflow 或 dashboard server 启动 | agent_id、role、started_at、worktree/session scope | read-only query 隐式打开 |
| session heartbeat | 仅 owner process | session_id、last_heartbeat_at、activity | 无关 agent 刷新 heartbeat |
| 暂停 session | 显式用户命令或 handoff gate | 原因、current_run_id/task_id、恢复路径 | dashboard 静默暂停 |
| 关闭 session | owner process、`/handoff` 或显式用户命令 | final status、locks 已释放或转移 | 删除 stale session 文件 |
| 标记 stale | Management API read model | heartbeat 超过阈值 | 仅因 stale 就直接修改 status |

Management API 可以在读取时派生并报告 stale session，但不应仅因为查询执行就把 session status 回写成 `stale`。

## 安全规则

- 所有 queue/session 写入 gate 必须是对当前读取行为的增量补充。
- 运行态 JSON 必须使用原子替换持久化，不得让 reader 看到部分文件。
- 每个 mutation gate 都必须有可读原因和 timestamp。
- 高风险动作需要 `/approve` 或显式用户命令。
- Dashboard 控件可以请求决策，但不得直接修改 queue/session 状态。
- 未来 daemon/dispatch 层消费这些 gate，而不是替代这些 gate。
