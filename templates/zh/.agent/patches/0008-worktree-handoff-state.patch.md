---
id: 0008-worktree-handoff-state
target: workflows/handoff.md
anchor: "source_worktree"
---

---

## Worktree 交接补充

如果 handoff 跨 worktree 或分支发生，必须额外记录：

- `source_worktree` / `target_worktree`
- 当前 branch、base commit、HEAD commit
- `git status --short --branch`
- 已提交但未合并的 commit 列表
- `locks_to_release` / `locks_to_acquire`
- 合并后需要在目标主线 worktree 重新执行的验证命令

worktree handoff 完成后，来源 Agent 释放不再持有的锁，目标 Agent 在写入前重新获取锁。
