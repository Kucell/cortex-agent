---
name: worktree-audit
description: Read-only worktree dirty-state audit that classifies recovery-required, tracked, dist, and untracked changes without mutating Git state.
---

# Worktree Audit

Use this skill to inspect dirty worktrees before a handoff, commit, merge, cleanup, or recovery operation.

```bash
node .agent/skills/worktree-audit/scripts/index.js --dirty-only
node .agent/skills/worktree-audit/scripts/index.js --dirty-only --json
node .agent/skills/worktree-audit/scripts/index.js --repo /path/to/repository
```

The command is strictly read-only. It never stages, commits, stashes, resolves conflicts, aborts an operation, removes files, or changes branches.

Interpret `recovery_required` as a hard stop: the owning agent must explicitly resolve or abort the interrupted Git operation before `/worktree commit` or `/worktree merge` may continue.
