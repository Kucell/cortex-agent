# `.agent/.githooks/` — versioned git hooks for the `.agent/` directory

These hooks are committed so they stay in lock-step with the state-sync flow.
They are **not** active by default. These hooks apply only when `.agent/` is
itself a Git repository; in a managed project with a plain `.agent/` directory,
Git never invokes them.

`core.hooksPath` is repository-level configuration. Only enable these hooks
after confirming that `.agent/` is a separate Git repository. Otherwise,
`git -C .agent config core.hooksPath .githooks` would change the outer
project's hook path.

## One-time setup (separate `.agent/` repository only)

```bash
git -C .agent config core.hooksPath .githooks
```

`cortex-agent init` / `upgrade` wires the hook only when `.agent/` is a
separate repository. If `.agent/` is a plain directory, leaving it inactive
is expected.

## State classification

The pre-commit reminder does **not** maintain its own list of state directories.
It reads:

```text
.agent/contracts/state-classes.json
```

That contract is the state-class source of truth. Only entries whose
`sync_policy` is `tracked` or `derived` are included in automatic
state-sync reminders. `local`, `evidence`, `legacy`, and `ignored`
classes are not automatically staged.

This keeps the hook aligned with the outer `lib/state-sync/` implementation.

## Hook behavior

| File | Trigger | Behavior |
|---|---|---|
| `pre-commit` | `git commit` | Reminder only — reports unstaged/untracked registry-managed syncable state. It does not block the commit. |

If the registry contract is missing, the hook fails open with a warning and
asks the developer to run `cortex-agent update`; it does not invent a
fallback state list.

## Disabling

```bash
# skip once
git -C .agent commit --no-verify

# disable for this clone
git -C .agent config --unset core.hooksPath
```

## See also

- `contracts/state-classes.json`
- `bin/cli.js` `state-sync` subcommand
- `lib/state-registry/`
- `lib/state-sync/`
