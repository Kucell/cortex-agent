---
id: 0010-worktree-mission-coordination
target: workflows/mission.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Mission Worktree 协同补充

当 mission 的多个 milestone 可并行推进时，读取 `.agent/rules/worktree-collaboration.md`，并在 mission plan 中记录：

- milestone 对应的 worktree path / branch / owner agent
- 每个 worktree 的 base commit 和目标合并分支
- handoff、Artifact Bus、locks 的状态引用
- 每个 worktree 的及时提交点
- 合并后的主线验证命令和证据要求

mission 不能只因为子 worktree 验证通过就完成；必须在合并目标 worktree 重新验证后才能推进到 COMPLETE。
