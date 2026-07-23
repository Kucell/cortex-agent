---
name: worktree
description: Plan, create, inspect, and integrate isolated single-task worktrees with explicit ownership and protected merge approval.
---

# Worktree Workflow (/worktree)

Use worktrees to isolate parallel implementation while sharing the project's canonical `.agent` state. This workflow owns single-task branch integration only. It does not own project-level, multi-source Checkpoint integration.

## Commands

```text
/worktree plan <task-ids...>
/worktree create <task-id>
/worktree status
/worktree merge <task-id>
/worktree cleanup <task-id>
```

## Planning and Creation

1. Read the task plan, dependencies, file scopes, locks, repository policy, and active worktrees.
2. Parallelize only independent tasks with non-overlapping write scopes. Shared files require explicit sequencing or ownership.
3. Record the branch, worktree path, task ID, agent/session owner, expected files, validation command, and handoff target.
4. Resolve the path with `.agent/workspaces/scripts/worktree-layout.js resolve`. By default create `<repo-parent>/<repo>-worktrees/<task-id>[-slug]`; do not add another flat `<repo>-<task-id>` directory beside unrelated projects.
5. Create the container and worktree from the required base commit. Keep `.agent` as one shared source of truth through the repository-supported link strategy; never copy diverging coordination state into each worktree.
6. Register Queue, Run, Session, lock, and handoff state through their owning APIs. A filesystem directory alone is not coordinator state.

Example resolution and creation:

```bash
node .agent/workspaces/scripts/worktree-layout.js resolve --repo "$(pwd)" --task-id T-001
mkdir -p ../<repo>-worktrees
git worktree add ../<repo>-worktrees/T-001 -b agent/T-001-<slug>
```

Before moving a legacy worktree, run the read-only `plan` command, check dirty state and active processes, then use `git worktree move`; never move it with Finder or `mv`.

Checkpoint runtime progress with the Management API, including the exact phase and evidence:

```bash
cortex-agent runs checkpoint --project . \
  --run-id R-<id> \
  --gate worktree \
  --payload-json '{"phase":"editing","task_id":"T-<id>","worktree_path":"<path>"}'
```

## Status and Handoff

`/worktree status` is read-only. Report branch/head, clean or dirty state, lock owner, Run phase, Session heartbeat, validation result, handoff readiness, and one recommended `next_action`. Never treat stale Dashboard data as authority over repository state.

Before handoff, the producing agent must record changed paths, validation commands and results, artifact refs, known risks, source commit, and remaining work. The receiving owner verifies the evidence before claiming the next write scope.

## Single-Task Merge

### Preconditions

- The source task is implementation-complete and has a clean, reviewable commit.
- Required tests and diff checks pass, with evidence recorded.
- No conflicting lock or unconsumed handoff exists.
- Fetch or rebase, when required, is completed before freezing the merge candidate.

`/worktree` owns only this single-task merge. Read repository policy and determine an approved integration strategy: `fast-forward`, `squash`, `local-merge`, or `pr-handoff`. Never select a strategy implicitly.

If the strategy is not already frozen by policy, create a separate merge Decision/Waitpoint for the proposed strategy before freezing the candidate. Bind the source branch/head, target branch/head, strategy, and digest in one exact resource:

```text
git:<repository>#integrate:<source-branch>@<source-head>-><target-branch>@<target-head>#strategy:<integration-strategy>#digest:<resource-digest>
```

IDs include source and target short SHAs plus the first 8-12 digest characters:

```bash
cortex-agent decisions request --project . \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate worktree \
  --payload-json '{"type":"merge","requested_by":"/worktree","prompt":"Approve this exact single-task integration?","options":["approve","reject","revise"],"gate":{"action":"merge","resource_ref":"<resource-ref>"}}'

cortex-agent waitpoints create --project . \
  --waitpoint-id WP-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate worktree \
  --owner-workflow /worktree \
  --reason "Exact commits and integration strategy require user approval" \
  --action merge \
  --resource-ref "<resource-ref>" \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8>
```

Stop and display `/approve decision <decision-id>`. Dashboard is read-only and cannot approve. On resume, recompute both heads, strategy, and digest. If any value changed, create new records; never reuse stale approval.

Only `/worktree` may consume its matching Waitpoint:

```bash
cortex-agent waitpoints release --project . \
  --waitpoint-id WP-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate owner \
  --owner-workflow /worktree \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --released-by /worktree \
  --release-note "Approved Decision matches commits, strategy and resource digest"
```

After release, do not rebase or change source/target heads. Execute only the approved strategy:

| Strategy | Required behavior |
| --- | --- |
| `fast-forward` | Advance only when a fast-forward remains possible. |
| `squash` | Create one candidate commit using `/commit`; preserve source evidence. |
| `local-merge` | Use repository-configured merge arguments; do not hard-code a merge style. |
| `pr-handoff` | Prepare and report the PR handoff; pushing/opening a PR needs its own external-side-effect authorization. |

Run integration validation on the target branch and record before/after commits, source commit, strategy, commands, and results. Validation failure blocks completion and preserves evidence; never auto-reset or auto-revert.

## External and Destructive Operations

- Read-only `status`, `diff`, `diff --check`, and local log inspection need no Decision.
- `fetch` requires a dedicated `action=external_side_effect` Decision/Waitpoint.
- Rebase rewrites source commits and requires a dedicated `action=destructive` Decision/Waitpoint.
- Push and PR creation require dedicated external-side-effect authorization.

## Routing Boundary

- `/plan` selects task splitting and worktree candidates.
- `/ship` owns task delivery evidence.
- `/mission` owns milestone validation.
- At a phase-level or multi-source project integration boundary, report that the project-level Checkpoint integration route is pending approval. Do not name, invoke, or emulate an unapproved workflow.
