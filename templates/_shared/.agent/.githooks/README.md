# `.agent/.githooks/` — versioned git hooks for the inner .agent repo

These hooks are committed in this repo so they stay in lock-step with
the rest of the state-sync flow. They are **not** active by default —
each clone must opt in once with `core.hooksPath`.

## Why a separate `core.hooksPath`?

- Hooks are per-clone state in normal git. If we put them under
  `.git/hooks/`, they get ignored by `git add` and never propagate to
  other clones. Storing them under `.githooks/` (visible to git) and
  pointing `core.hooksPath` there gives us versioned + distributed
  hooks without per-clone maintenance.
- This repo's git is configured to **not** track `.git/hooks/*` as
  content. `.githooks/` is the source of truth.

## One-time setup per clone

```bash
# from the project root, after cloning:
git -C .agent config core.hooksPath .githooks
```

That's it. The `pre-commit` hook below will now run on every commit
inside the inner `.agent/` repo.

## Hooks

| File | Trigger | Behavior |
|---|---|---|
| `pre-commit` | `git commit` | **Reminder only** — scans working tree for un-staged 9 state-class files and prints a warning. Does NOT block the commit. Skip with `git commit --no-verify`. |

## 9 state classes

```
decisions/  waitpoints/  tasks/  missions/  plans/
dispatch/   workflows/   skills/  branches/registry.json
```

A new state class goes in three places:

1. `lib/state-sync.js` `STATE_DIRS` / `STATE_FILES` (outer repo)
2. `.agent/.githooks/pre-commit` `STATE_DIRS` / `STATE_FILES` (this repo)
3. `tests/state-sync.test.js` (outer repo)

## Disabling / uninstalling

```bash
# skip for one commit:
git -C .agent commit --no-verify

# disable permanently for this clone:
git -C .agent config --unset core.hooksPath
```

The hook scripts stay on disk in this repo; uninstalling just stops
git from invoking them.

## See also

- `bin/cli.js` `state-sync` subcommand
- `lib/state-sync.js` (outer repo)
- `tests/state-sync.test.js` (outer repo)
- `.agent/AGENTS.md` "Workflow" section
