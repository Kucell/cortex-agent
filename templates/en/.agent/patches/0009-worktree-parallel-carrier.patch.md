---
id: 0009-worktree-parallel-carrier
target: workflows/parallel.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Worktree Parallel Carrier Addendum

When a batch needs real parallel development, read `.agent/rules/worktree-collaboration.md`, run the `--isolation auto` preflight, and resolve the batch to `shared`, `locked`, `worktree`, or `serial`.

- Suitable: different modules/directories, independent validation, isolated dev servers or runtime state
- Not suitable: shared contract, shared type, migration file, exclusive device, or remote environment
- When resolved to `worktree`, automatically enter `/worktree plan`; `/worktree create` still owns creation
- Same-file or shared-contract writes must resolve to `serial`; worktrees cannot force them into parallel execution
- After each worktree completes a verifiable task, run `/ship` or `/commit` promptly
- After merge, rerun functional validation in the target mainline worktree
