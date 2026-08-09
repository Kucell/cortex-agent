---
name: dependency-analysis
description: Parallel task dependency and conflict analysis. Used by /sync-plans and /parallel to detect file-level conflicts, shared interface dependencies, blockers, and duplicate work across concurrent tasks before dispatching or merging workers.
---

# Dependency Analysis Skill

## Goal

Given the active task set (`.agent/plans/task-progress.md` + `.agent/plans/*.md` + `.agent/missions/*/mission-plan.md`), produce a factual dependency/conflict picture **before** workers are dispatched or merged. Read-only: this skill never mutates git or plan files.

## The 4 Analyses

### 1. 冲突检测 (File-level Conflicts)

Check whether two in-flight tasks touch the same source files.

```bash
# Active worktrees and their branches
git worktree list
# Files changed per worker branch vs its base
git diff --stat <base>..<branch>
# Overlap: intersect the changed-file lists of every pair of active branches
```

- Same file changed by 2+ active branches → flag as conflict risk; serialize or re-scope.
- `bin/cli.js`, `lib/commands.js`, `task-progress.md` are historical hotspots — check them first.

### 2. 接口依赖 (Shared Interface Dependencies)

Check whether multiple plans rely on an underlying interface that does not exist yet.

```bash
# For each interface a plan references, verify it exists
grep -rn "require(\"../lib/<module>\")" lib/ bin/
ls lib/<module>.js
```

- Interface referenced but absent → the dependent task is blocked until the owning milestone merges.

### 3. 依赖对齐 (Blockers)

Build the depends-on chain from mission plans (`Depends On` column in milestone tables) and mark each active task:

- `ready` — all dependencies merged to main
- `blocked` — at least one dependency not merged; name the blocking milestone/commit

### 4. 重复工作识别 (Duplicate Work)

Check whether two tasks implement similar functionality.

- Compare `Goal` / `In scope` sections of active mission plans and proposals.
- Same capability appearing in 2+ scopes → escalate for de-duplication before dispatch.

## Output Contract

Return a compact report:

```
- 冲突: [file × taskA × taskB] 或 "无"
- 接口缺口: [interface ← blocked task] 或 "无"
- Blocker 链: task → waiting-on milestone/commit
- 重复工作: [capability × taskA × taskB] 或 "无"
```

## When to Use

- `/sync-plans` Step 2 (parallel task analysis)
- `/parallel` before batching workers
- `/mission` EXECUTE 前,确认 milestone 依赖已就绪
