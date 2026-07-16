---
id: 0011-worktree-status-state-machine
target: workflows/worktree.md
anchor: "worktree_state"
---

---

## STATUS 状态机补充

`/worktree status` 必须按状态输出唯一 `next_action`，不能每次固定建议同一句。

状态集合：

- `idle`：还没有非主 worktree、active lock 或 active agent，建议 `/worktree plan <tasks>`
- `planned`：已有任务拆分但未创建 worktree，建议 `/worktree create <task-id>`
- `worktree_created`：worktree 已创建但未开始写入，建议获取 lock 后 `/start-task`
- `in_progress`：已有改动、active agent 或 held lock，建议达到可验证点后 `/worktree commit <task-id>`
- `handoff_required`：存在待接收 handoff 或状态冲突，建议 `/handoff resume`
- `merge_ready`：源 worktree 干净且已有提交，建议 `/worktree merge <task-id>`
- `merged`：已合并但未主线验证，建议 `/worktree validate <task-id>`
- `validation_failed`：主线验证失败，建议修复或创建 `/handoff`
- `validated`：主线验证通过，建议 `/sync-plans` 和 `/update-refs`
- `closed`：任务关闭且锁释放，建议清理或保留 worktree

输出必须包含 `worktree_state`、`human_summary`、`next_action` 和可选 `next_actions`。
