---
id: 0012-worktree-shared-agent-state
target: workflows/worktree.md
anchor: "agent_state_path"
---

---

## 共享 .agent 状态补充

创建子 worktree 后，不要复制一份 `.agent`。应将子 worktree 的 `.agent` 符号链接到主 worktree 的 `.agent`：

```bash
rm -rf <child-worktree>/.agent
ln -s <primary-worktree>/.agent <child-worktree>/.agent
```

原因：

- locks、handoffs、artifacts、metrics 和 dashboard 必须共享
- 每个 worktree 复制 `.agent` 会导致状态分裂
- 目录硬链接不可靠，符号链接更安全

registry、lock metadata、handoff JSON 中应记录 `agent_state_path`。
