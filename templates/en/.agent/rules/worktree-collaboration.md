# Worktree Collaboration Rules

When multiple agents need to advance one large project in parallel, use Git worktrees to isolate working directories. Worktrees isolate filesystems only; task state, handoff, locks, and merge order are still coordinated by `.agent/`.

## 1. When to Use

Use worktrees when:

- Tasks edit different modules or directories.
- A mission needs multiple implementation branches or explorations.
- Different agents need isolated dev servers, tests, or local state.
- You want to reduce file churn in one shared working directory.

Do not use worktrees when:

- Tasks share the same core file, shared type, database migration, or interface contract.
- The architecture decision is not confirmed.
- Work needs an exclusive device, remote machine, license, or migration window.
- The task is a small single-file fix.

## 2. Worktree Identity

Each worktree must have recoverable identity:

- `worktree_path`
- `branch`
- `base_branch`
- `base_commit`
- `task_id` / `mission_id`
- `agent_id` and role
- `owned_files`

Record these fields in Agent Registry or handoff JSON.

## 3. Shared .agent

Multiple worktrees must share one `.agent` state directory so task-progress, locks, handoffs, artifacts, and dashboard state do not split.

Recommended approach: create a symbolic link in child worktrees:

```bash
rm -rf <child-worktree>/.agent
ln -s <primary-worktree>/.agent <child-worktree>/.agent
```

Notes:

- Do not hard-link directories; most file systems do not support directory hard links safely.
- Do not copy `.agent` into every worktree and let each copy diverge.
- All worktrees should share `.agent/locks/`, `.agent/handoffs/`, `.agent/artifacts/`, and `.agent/metrics/agent-dashboard.html`.
- If an experimental worktree intentionally uses isolated state, explain that in handoff or coordination report.

## 4. Locks and Write Boundaries

- Acquire `task:<id>` or `file:<path>` Progress Locks before writing code.
- Different worktrees can still edit the same file; worktrees do not replace locks.
- Changes outside `owned_files` must be explained in handoff or coordination reports first.
- If a lock conflicts, stop writing and ask coordinator for recovery options.

## 5. Handoff Requirements

Cross-worktree handoff must record:

- Source and target worktree
- Current branch, `HEAD` commit, and base commit
- Uncommitted state from `git status --short`
- Commits not yet merged
- Locks held or locks to release
- Artifact Bus state and validation results
- Whether the next step continues in the same worktree or moves to another one

Do not copy large diffs into handoffs; use paths, commits, and artifact references.

## 6. State Sync

Multi-worktree coordination must follow:

1. Each worktree writes task state to `.agent/artifacts/<task-id>/` or mission milestones.
2. `/handoff` is the formal context-transfer path across agents or worktrees.
3. `/sync-plans` synchronizes planning state only; it does not mean code is merged.
4. Before merge, check registry, locks, handoff, and git state for consistency.
5. After merge, run `/update-refs`; if developer docs changed, run `/publish-docs`.

## 7. Timely Commits and Mainline Validation

- After each worktree completes a verifiable task, run `/ship <task-id>` or `/commit` promptly. Do not keep large uncommitted changes for long.
- Validation inside a worktree proves only that branch's local state; after merge, rerun key validation in the target mainline worktree.
- Before merge, the source worktree should be clean, have clear commits, record validation commands, and update handoff / Artifact Bus state.
- After merge, the target worktree should pass functional validation, pass `git diff --check`, synchronize task plans, and release or transfer locks.
- If post-merge validation fails, fix in the merge target first. If work must return to the source worktree, create a handoff with failure evidence and recovery steps.

## 8. Merge Order

Recommended merge order:

1. Contracts, types, public interfaces
2. Backend or core logic
3. UI / integration layer
4. Tests, validation, and docs

If multiple worktrees edit the same contract, pause implementation and return to `/arch-design` or `/plan`.
