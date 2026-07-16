---
id: 0008-worktree-handoff-state
target: workflows/handoff.md
anchor: "source_worktree"
---

---

## Worktree Handoff Addendum

If handoff crosses worktrees or branches, additionally record:

- `source_worktree` / `target_worktree`
- current branch, base commit, HEAD commit
- `git status --short --branch`
- commits not yet merged
- `locks_to_release` / `locks_to_acquire`
- validation commands that must be rerun in the target mainline worktree after merge

After worktree handoff, the source agent releases locks it no longer owns, and the target agent re-acquires locks before writing.
