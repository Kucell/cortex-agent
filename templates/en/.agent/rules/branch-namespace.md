# Optional Branch Namespace Rule

## Status

Branch namespaces are an optional framework capability and are disabled by default. The presence of this rule, the helper script, or `.agent/branches/` does not activate routing.

A project enables the capability only after it explicitly records that decision in its local agent configuration and updates the relevant project workflows to resolve branch-scoped destinations through the helper. Until then, existing flat paths keep their current meaning.

## Scoped Content

When enabled, route only branch-local operational content to:

| Content | Destination |
| --- | --- |
| Plans | `.agent/branches/<branch-slug>/plans/` |
| Missions | `.agent/branches/<branch-slug>/missions/` |
| Handoffs | `.agent/branches/<branch-slug>/handoffs/` |
| Incidents | `.agent/branches/<branch-slug>/incidents/` |

Keep shared framework and long-lived knowledge in their existing locations, including `rules/`, `workflows/`, `skills/`, `references/`, `plugins/`, `config/`, and `.agent/plans/proposals/`.

## Required Behavior

1. Resolve destinations with `.agent/scripts/agent-branch-helper.sh`; do not duplicate slug logic in workflows.
2. Treat the helper's output as the destination. Do not construct paths from untrusted task or branch text.
3. Stop and ask for a checked-out branch when HEAD is detached. Do not write detached work into another branch's namespace.
4. Pass only `plans`, `missions`, `handoffs`, or `incidents` to directory subcommands.
5. Keep worktree ownership, locks, handoff payloads, and merge validation governed by their existing rules. Namespacing changes storage paths only.
6. Decide promotion, archival, or deletion during the project's normal merge process. The helper does not move or remove content.

## Slug Safety

The helper percent-encodes the branch name: literal `%` becomes `%25`, then `/` becomes `%2F`. This reversible mapping prevents lossy collisions such as `feature/a-b` versus `feature-a/b`. Workflows must never replace `/` with `-` independently.

## Standard Use

```bash
bash .agent/scripts/agent-branch-helper.sh status
PLAN_DIR=$(bash .agent/scripts/agent-branch-helper.sh ensure-current plans)
```

Use `namespace`, `relpath`, or `status` for read-only discovery. `ensure` and `ensure-current` are the only commands that create directories.
