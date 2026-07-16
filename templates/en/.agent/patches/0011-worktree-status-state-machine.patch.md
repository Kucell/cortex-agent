---
id: 0011-worktree-status-state-machine
target: workflows/worktree.md
anchor: "worktree_state"
---

---

## STATUS State Machine Addendum

`/worktree status` must output one state-driven `next_action`; it must not repeat a fixed suggestion every time.

States:

- `idle`: no non-main worktree, active lock, or active agent; recommend `/worktree plan <tasks>`
- `planned`: tasks are decomposed but worktrees do not exist; recommend `/worktree create <task-id>`
- `worktree_created`: worktree exists but writing has not started; recommend acquiring lock then `/start-task`
- `in_progress`: changes, active agent, or held lock exists; recommend `/worktree commit <task-id>` after a verifiable point
- `handoff_required`: pending handoff or state conflict exists; recommend `/handoff resume`
- `merge_ready`: source worktree is clean and committed; recommend `/worktree merge <task-id>`
- `merged`: merged but not mainline-validated; recommend `/worktree validate <task-id>`
- `validation_failed`: mainline validation failed; recommend fix or `/handoff`
- `validated`: mainline validation passed; recommend `/sync-plans` and `/update-refs`
- `closed`: task closed and locks released; recommend cleaning up or keeping the worktree

Output must include `worktree_state`, `human_summary`, `next_action`, and optional `next_actions`.
