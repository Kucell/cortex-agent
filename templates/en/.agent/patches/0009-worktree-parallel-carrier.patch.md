---
id: 0009-worktree-parallel-carrier
target: workflows/parallel.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Worktree Parallel Carrier Addendum

When a batch needs real parallel development, read `.agent/rules/worktree-collaboration.md` and decide whether each task should get an isolated worktree.

- Suitable: different modules/directories, independent validation, isolated dev servers or runtime state
- Not suitable: shared contract, shared type, migration file, exclusive device, or remote environment
- After each worktree completes a verifiable task, run `/ship` or `/commit` promptly
- After merge, rerun functional validation in the target mainline worktree
