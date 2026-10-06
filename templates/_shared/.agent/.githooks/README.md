# `.agent/.githooks/` — versioned git hooks for the inner .agent repo

These hooks are committed so they stay in lock-step with the state-sync flow.
They are **not** active by default; each clone opts in once with
`core.hooksPath`.

## One-time setup

```bash
git -C .agent config core.hooksPath .githooks
```

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
