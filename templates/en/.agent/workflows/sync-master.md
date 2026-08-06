---
description: Sync with the default branch via fetch + rebase (no casual merge). Stash safety + optional build check. Supports main or master.
---

# Workflow: /sync-master

Use when the user wants to **update their branch from the remote default branch** (pull latest, rebase).

## Default branch name

- Usually **`main`** or **`master`**. Replace `main` below if your remote uses another name (check `git branch -r` / `origin/HEAD`).

Examples below use **`origin/main`**; swap for **`origin/master`** if needed.

## 1. Working tree safety

- Run `git status`.
- If there are uncommitted changes, **`git stash push -m "sync-master wip"`** (or equivalent) before fetch/rebase.

## 2. Fetch

- `git fetch origin` (or `git fetch origin main`).

## 3. Rebase (no casual merge)

- `git rebase origin/main` (or `origin/master`).
- **Do not** use `git merge` for day-to-day “catch up my branch” sync.

## 4. Conflicts

- List conflicted files, propose resolution; pause automation until the user continues with `git rebase --continue`.

## 5. Stash pop + optional check

- If you stashed: `git stash pop` (resolve conflicts if any).
- Optionally run the project’s quick check (`npm test`, `npm run build`, `tsc --noEmit`, etc.).

## 6. Post-sync registry update (MS-003)

If the current branch is registered in `.agent/branches/registry.json` (i.e. visible in `cortex-agent branch list`), call `branch sync` to refresh `last_sync` and `commits_ahead`:

```bash
# Use git rev-parse --abbrev-ref HEAD to obtain the current branch name
cortex-agent branch sync <current-branch> --no-rebase
```

- Expected exit 0; the registry entry's `last_sync` is updated to the current ISO timestamp
- `commits_ahead` is recomputed from `git rev-list --count <base>..<head>` after the rebase
- **Skip rule**: if the current branch is not in the registry (e.g. ad-hoc feature branch, scratch work) → silently skip, no error. Users can verify with `cortex-agent branch list`
- **Behavior on main**: `branch sync main` is effectively a no-op (base == self); `--no-rebase` still updates `last_sync` but does not change other state

> Naming conventions and registry schema: see `.agent/rules/branch-management.md`. Subcommand details: `cortex-agent branch sync --help`.

## 7. Report

- Short 1–2 sentence summary for the user covering:
  - rebase result (success / conflicts need manual resolution)
  - if the registry was updated: `Updated registry for <branch>: last_sync=<ts> commits_ahead=<N>`
  - if the registry was skipped: keep the summary brief, do not surface registry details

## References

- `.agent/rules/ai-behavior.md`
- `.agent/rules/commit-standards.md`
