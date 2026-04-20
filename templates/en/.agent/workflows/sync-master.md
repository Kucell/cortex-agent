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
- Short 1–2 sentence summary for the user.

## References

- `.agent/rules/ai-behavior.md`
- `.agent/rules/commit-standards.md`
