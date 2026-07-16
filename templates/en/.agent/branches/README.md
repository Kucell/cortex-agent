# Branch Namespaces

This directory is the optional home for branch-scoped operational state when multiple clones or worktrees share one `.agent` tree.

## Default

The capability is disabled by default. These files do not redirect existing plans, missions, handoffs, or incidents. A project must explicitly opt in and adapt only the workflows that should use branch-scoped state.

## Layout

```text
.agent/branches/
  <branch-slug>/
    plans/
    missions/
    handoffs/
    incidents/
```

The helper encodes `%` as `%25` and `/` as `%2F`, so slugs are lossless and collision-safe. For example, `feature/search` becomes `feature%2Fsearch`; a literal branch named `feature%2Fsearch` becomes `feature%252Fsearch`.

## Commands

```bash
bash .agent/scripts/agent-branch-helper.sh branch-name
bash .agent/scripts/agent-branch-helper.sh branch-slug
bash .agent/scripts/agent-branch-helper.sh namespace
bash .agent/scripts/agent-branch-helper.sh ensure
bash .agent/scripts/agent-branch-helper.sh ensure-current plans
bash .agent/scripts/agent-branch-helper.sh relpath plans
bash .agent/scripts/agent-branch-helper.sh status
```

`branch-name`, `branch-slug`, `namespace`, `relpath`, and `status` do not write. `ensure` creates all four supported directories; `ensure-current` creates one. Directory arguments are restricted to `plans`, `missions`, `handoffs`, and `incidents`.

The script derives the agent root from its own location. Set `AGENT_ROOT` only when the shared agent tree lives elsewhere:

```bash
AGENT_ROOT=/path/to/shared/.agent \
  bash .agent/scripts/agent-branch-helper.sh namespace
```

It detects the repository from the caller's current worktree, so a shared script still routes each worktree by its own checked-out branch. Detached HEAD is rejected before any namespace directory is created.

## Boundaries

Do not namespace `rules/`, `workflows/`, `skills/`, `references/`, `plugins/`, `config/`, or `.agent/plans/proposals/`. Branch namespaces do not replace worktree coordination, locks, handoff metadata, commits, or merge validation.

See [`../rules/branch-namespace.md`](../rules/branch-namespace.md) and [`../skills/branch-namespace/SKILL.md`](../skills/branch-namespace/SKILL.md).
