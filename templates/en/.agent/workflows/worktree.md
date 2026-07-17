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
- When Management API exists, record worktree creation, lock acquisition, commit, merge, and validation in the Run journal.

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

1. Link the child worktree `.agent` to the primary worktree's shared `.agent`:

```bash
rm -rf ../<repo>-<task-id>/.agent
ln -s "$(pwd)/.agent" ../<repo>-<task-id>/.agent
```

2. In the child worktree, verify `.agent` points to shared state:

```bash
test -L .agent && readlink .agent
```

3. Record `base_branch`, `base_commit`, `branch`, `worktree_path`, and `agent_state_path`.
4. Check in to registry.
5. Acquire the task lock and include `worktree_path`, `branch`, and `agent_state_path` in lock metadata.
6. Call `management-api runs checkpoint` for `creating_worktree` / `lock_acquired`.

## STATUS

Summarize all worktree state:

1. `git worktree list --porcelain`
2. `git status --short --branch` in each worktree
3. registry active agents
4. held locks
5. latest Artifact Bus state
6. open handoffs

Always output a state-machine result, not a fixed suggestion:

| `worktree_state` | Condition | `next_action` |
| :--- | :--- | :--- |
| `idle` | no non-main worktree, no active lock, no active agent | `/worktree plan <tasks>` |
| `planned` | tasks are planned but no worktree exists yet | `/worktree create <task-id>` |
| `worktree_created` | worktree exists but has no writes and no lock | acquire task/file lock, then `/start-task` |
| `in_progress` | worktree has changes, active agent, or held lock | after a verifiable point, `/worktree commit <task-id>` |
| `handoff_required` | pending handoff or inconsistent state exists | `/handoff resume <handoff>` |
| `merge_ready` | source worktree is clean, committed, and validation is recorded | `/worktree merge <task-id>` |
| `merged` | branch is merged but mainline is not validated | `/worktree validate <task-id>` |
| `validation_failed` | mainline validation failed | fix or create `/handoff` |
| `validated` | mainline validation passed | `/sync-plans`, `/update-refs` |
| `closed` | task is closed and locks are released | clean up or keep worktree |

JSON output must include:

```json
{
  "type": "worktree_coordination_report",
  "worktree_state": "idle | planned | worktree_created | in_progress | handoff_required | merge_ready | merged | validation_failed | validated | closed",
  "status": "ready | blocked | merge_ready | validated",
  "worktrees": [],
  "locks": [],
  "handoffs": [],
  "human_summary": "one-sentence progress explanation",
  "blocked_reasons": [],
  "next_action": "single recommended next step",
  "next_actions": ["optional follow-up actions"]
}
```

Also output a human-readable summary explaining why that next_action was chosen.

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
4. Append `command_started` / `command_finished` around validation commands, then append `validation_passed` or `validation_failed`.
5. After commit, record task_id, worktree_path, branch, commit, and validation.
6. Update handoff or coordination report so coordinator knows whether this worktree is `merge_ready` or should continue.
7. Append a `command_finished` Run event indicating the worktree commit completed.

## MERGE

Pre-merge gate:

- The source worktree is clean; if not, return to `COMMIT` or create a handoff explaining why.
- The source branch has at least one clear commit made via `/ship` or `/commit`.
- The task lock is held by the current agent, released, or transferred.
- `/ship` completed or has an explicit waiver.
- Worktree-local validation commands are recorded.
- There is no unresolved handoff.
- Rebase or merge with the base branch has no conflicts.

Append `merge_started` / `merge_completed` Run events around the merge. If the merge conflicts or fails, append `failed` or `blocked`.

## VALIDATE

After merge, rerun validation in the target mainline worktree:

1. Run key tests, build, lint, or user-specified validation commands.
2. For UI, device, or cross-machine projects, collect runtime evidence through the domain validation skill or validation-contract.
3. Run `git diff --check`.
4. If validation fails, record failed commands and evidence, fix in the target worktree first, or create `/handoff` if work must return to the source worktree.
5. If validation passes, mark the task as merge-ready/closed and update Artifact Bus or mission milestone.
6. Update Run journal to `status=completed`, `phase=completed`, and append a `completed` event.

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

## Queue And Session Runtime Writes

- `/worktree plan` creates a batch with `queues upsert --gate worktree`; after worktree creation and lock acquisition, `queues item --gate worktree` records the running task, path, agent, and run.
- `/worktree commit` marks an item `done` only after validation evidence exists. Failures become `blocked`; never delete an item to hide failure.
- A long-running worktree owner may open and heartbeat a Session, then pause or close it through owner or handoff gates.
- Queue and Session writes must agree with Run checkpoints and lock state.
