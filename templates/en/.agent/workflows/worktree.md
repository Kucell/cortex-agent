---
name: worktree
description: Use Git worktrees to isolate parallel agent development, coordinated through registry, locks, handoffs, and artifacts.
---

# Worktree Collaboration Workflow (/worktree)

## Goal

Use Git worktrees to give multiple agents isolated working directories while keeping task state, locks, handoff, and merge order recoverable.

`/worktree` does not replace `/parallel`, `/mission`, `/handoff`, or `/ship`. It adds workspace isolation and state sync between those workflows.

## Usage

```text
/worktree plan T-001 T-002
/worktree create T-001 --branch agent/T-001-auth
/worktree status
/worktree handoff T-001 --to ../project-T-001
/worktree sync
/worktree commit T-001
/worktree merge T-001
/worktree validate T-001
```

## Core Rules

- Read `.agent/rules/worktree-collaboration.md` first.
- Each worktree maps to one task, one branch, and one agent owner.
- Acquire Progress Locks before writing.
- Handoff must record worktree path, branch, base commit, HEAD commit, and git status.
- After a worktree completes a verifiable task, run `/ship` or `/commit` promptly.
- Before merge, registry, locks, artifacts, handoff, and git state must agree.
- After merge, rerun functional validation in the target mainline worktree.

## PLAN

Before creating worktrees:

1. Read `.agent/rules/task-decomposition.md` and `.agent/rules/worktree-collaboration.md`.
2. Read `.agent/plans/task-progress.md` or mission plan.
3. Decide which tasks are suitable for worktree parallelism.
4. Output the plan:

```text
Worktree plan:
  T-001 -> ../project-T-001 -> branch agent/T-001-auth -> implementer
  T-002 -> ../project-T-002 -> branch agent/T-002-ui -> implementer

Serial work:
  T-000 contract baseline must finish first

Shared risk:
  src/types/api.ts must not be edited by multiple worktrees
```

## CREATE

Create the worktree:

```bash
git worktree add ../<repo>-<task-id> -b agent/<task-id>-<slug>
```

Then in the new worktree:

1. Run `cortex-agent upgrade --lang=<lang>` to fill `.agent` capabilities.
2. Record `base_branch`, `base_commit`, `branch`, and `worktree_path`.
3. Check in to registry.
4. Acquire the task lock and include `worktree_path` and `branch` in lock metadata.

## STATUS

Summarize all worktree state:

1. `git worktree list --porcelain`
2. `git status --short --branch` in each worktree
3. registry active agents
4. held locks
5. latest Artifact Bus state
6. open handoffs

## HANDOFF

For cross-worktree transfer, run `/handoff create` and ensure Markdown and JSON include:

- `source_worktree`
- `target_worktree`
- `branch`
- `base_commit`
- `head_commit`
- `git_status`
- `locks_to_release`
- `locks_to_acquire`
- `artifact_refs`

After handoff, the source agent releases locks it no longer owns; the target agent re-acquires locks before writing.

## SYNC

Sync state without merging code:

1. Scan worktree list.
2. Mark stale registry entries.
3. Sweep expired locks.
4. Validate handoff JSON.
5. Compare task-progress / mission state / artifacts.
6. Output divergences that need human attention.

## COMMIT

Promptly close a verifiable task inside the worktree:

1. Confirm the current `task_id`, `branch`, and `base_commit`.
2. Run task-level validation commands and record results in Artifact Bus or mission milestone.
3. Run `/ship <task-id>`; for an intermediate checkpoint, run `/commit`.
4. After commit, record task_id, worktree_path, branch, commit, and validation.
5. Update handoff or coordination report so coordinator knows whether this worktree is `merge_ready` or should continue.

## MERGE

Pre-merge gate:

- The source worktree is clean; if not, return to `COMMIT` or create a handoff explaining why.
- The source branch has at least one clear commit made via `/ship` or `/commit`.
- The task lock is held by the current agent, released, or transferred.
- `/ship` completed or has an explicit waiver.
- Worktree-local validation commands are recorded.
- There is no unresolved handoff.
- Rebase or merge with the base branch has no conflicts.

## VALIDATE

After merge, rerun validation in the target mainline worktree:

1. Run key tests, build, lint, or user-specified validation commands.
2. For UI, device, or cross-machine projects, collect runtime evidence through the domain validation skill or validation-contract.
3. Run `git diff --check`.
4. If validation fails, record failed commands and evidence, fix in the target worktree first, or create `/handoff` if work must return to the source worktree.
5. If validation passes, mark the task as merge-ready/closed and update Artifact Bus or mission milestone.

After merge and validation pass:

1. Update `/sync-plans`.
2. Run `/update-refs`.
3. Run `/publish-docs` if needed.
4. Check out registry.
5. Release locks.
6. Clean up or retain the worktree after user confirmation.

## Workflow Integration

- `/plan`: decides task breakdown and worktree candidates.
- `/parallel`: may use worktrees as the parallel execution carrier.
- `/mission`: milestones may map to one or more worktrees.
- `/handoff`: the only formal cross-worktree context transfer path.
- `/ship`: closes each worktree task.
