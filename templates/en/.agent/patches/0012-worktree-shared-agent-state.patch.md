---
id: 0012-worktree-shared-agent-state
target: workflows/worktree.md
anchor: "agent_state_path"
---

---

## Shared .agent State Addendum

After creating a child worktree, do not copy `.agent`. Symlink the child worktree `.agent` to the primary worktree `.agent`:

```bash
rm -rf <child-worktree>/.agent
ln -s <primary-worktree>/.agent <child-worktree>/.agent
```

Why:

- locks, handoffs, artifacts, metrics, and dashboard must be shared
- copied `.agent` directories split state across worktrees
- directory hard links are not reliable; symlinks are safer

Record `agent_state_path` in registry, lock metadata, and handoff JSON.
