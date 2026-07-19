# Worktree Directory Layout

## Default

Cortex Agent groups all secondary worktrees for one repository in one sibling container:

```text
<repo-parent>/
  <repo>/
  <repo>-worktrees/
    <mission-or-task-id>[-slug]/
```

Example:

```text
AI-Apps/
  AI-Workbench/
  AI-Workbench-worktrees/
    M007/
    M008-admin-ui/
```

This keeps unrelated projects readable and avoids placing cloned dependency trees, IDE watchers, search indexes, and build output inside the primary repository.

An internal `<repo>/.worktrees/` root is allowed only through explicit repository policy. It must be ignored by Git and excluded from IDE/indexer/watch configuration.

## Resolution

```bash
node .agent/workspaces/scripts/worktree-layout.js resolve \
  --repo /path/to/repo \
  --task-id T-001
```

`CORTEX_WORKTREE_ROOT` or `--root` overrides the sibling container. The resolver canonicalizes macOS path aliases such as `/var` and `/private/var`, rejects repository-internal roots by default, and removes a repeated repository prefix from legacy child names.

## Migration

Generate a read-only plan first:

```bash
node .agent/workspaces/scripts/worktree-layout.js plan --repo /path/to/repo
```

For each candidate:

1. Confirm the worktree is registered and its target does not exist.
2. Inspect full `git status`, including untracked files.
3. Check active Agent, terminal, IDE, dev-server, debugger, and container volume references.
4. Decide whether an already merged clean worktree should be removed instead of migrated.
5. Create the shared container.
6. Move with `git worktree move <old> <new>`; never use Finder, `mv`, or copy/delete.
7. Update persisted `worktree_path` references through their owning workflow/state writer.
8. Verify Git registration, branch, HEAD, status, shared `.agent`, locks, Session/Run/Queue/WorkspaceIdentity, and project tests.
9. Emit path-change evidence and keep an old-to-new mapping in the migration record.

Dirty or active worktrees are not automatic migration candidates. A dirty worktree needs an explicit handoff or commit decision; an active worktree is migrated only after its processes and owners release the old path.

## Naming

- Prefer `M007`, `T-402`, or `M007-desktop-alpha`.
- Do not repeat the repository name inside its container.
- Preserve the Git branch name; moving a worktree does not rename its branch.
- A retry that must coexist uses an explicit attempt suffix rather than silently reusing an occupied path.
