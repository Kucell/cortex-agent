---
name: branch-namespace
description: Optionally route branch-local plans, missions, handoffs, and incidents into collision-safe namespaces when clones or worktrees share one .agent tree.
---

# Branch Namespace

## Purpose

Use this skill only after a project explicitly enables branch namespaces. It resolves branch-local storage without changing Git worktree, lock, handoff, or merge semantics.

## Preconditions

1. Read `.agent/rules/branch-namespace.md` and `.agent/branches/README.md`.
2. Confirm the project has opted in. File presence alone is not opt-in.
3. Run commands from the target Git worktree, even if `.agent` is shared by symlink.
4. Check `status` before writing. If HEAD is detached, stop and ask for a branch checkout.

## Resolve a Destination

```bash
bash .agent/scripts/agent-branch-helper.sh status
TARGET_DIR=$(bash .agent/scripts/agent-branch-helper.sh ensure-current plans)
```

Replace `plans` only with `missions`, `handoffs`, or `incidents`. Write the new branch-local artifact under `TARGET_DIR` and preserve any existing project naming conventions.

Use read-only discovery when no directory should be created:

```bash
bash .agent/scripts/agent-branch-helper.sh namespace
bash .agent/scripts/agent-branch-helper.sh relpath handoffs
```

## Shared Agent Root

The helper normally derives `.agent` from its own path. If the script is not stored inside the shared agent root, provide the root explicitly:

```bash
AGENT_ROOT=/path/to/shared/.agent \
  bash path/to/agent-branch-helper.sh ensure-current missions
```

Never embed that machine path in committed rules, skills, or workflows.

## Guardrails

- Do not route proposals or shared rules, workflows, skills, references, plugins, or configuration into a branch namespace.
- Do not hand-build a slug or replace `/` with `-`; use the helper output.
- Do not accept arbitrary directory names.
- Do not copy, promote, archive, or delete another branch's content without the project's merge policy and explicit task scope.
- Do not alter existing worktree or handoff coordination rules while adopting this storage convention.

## Completion

Report the branch name, encoded slug, destination path, files written, and validation performed. Do not commit unless the user separately requests it.
