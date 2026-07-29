# Hook: Pre-Commit Check

## Trigger
This hook fires automatically before a `git commit` completes.

## Purpose
Enforce code quality and prevent common errors from entering the codebase.

## Steps
1. **Identify staged files**: Get the list of all staged files pending commit.
2. **Run linters**: Run the project's configured linting tools (e.g. ESLint, Ruff) against each staged file and check for errors.
3. **Scan for secrets**: Check staged files for hardcoded API keys, tokens, or other sensitive information.
4. **Verify test coverage** (optional): Run a quick coverage check to ensure new code is adequately tested.

## Outcome
- If any step fails, the commit is aborted and an error message explaining the failure is shown to the user.
- If all steps pass, the commit proceeds normally.

---

# Hook Adapter: Claude Code Governance (T-ACN-017)

## Overview
The Claude Code Hook Adapter bridges Claude Code hooks to the Coordination Machine, enforcing governance over the agent lifecycle. Every hook payload is validated, redacted, and rate-limited before reaching the coordination service.

## Hook Mapping

| Hook Name | Coordination Event | Notes |
|-----------|-------------------|-------|
| `SessionStart` | `task.accepted` | Only through real launcher (CORTEX_LAUNCH_CONTEXT required) |
| `PostToolUse` | `task.progress` | Rate-limited (5000ms window), merged within window |
| `TestStart` | `task.testing` | Auto-detected from test signal (npm test, vitest, jest, etc.) |
| `Notification` | `task.input_required` | Raw payload stripped; only requestedAction forwarded |
| `Permission` | `task.input_required` | Raw payload stripped; only requestedAction forwarded |
| `ReadyForReview` | `task.ready_for_review` | Only allowed evidence refs forwarded |
| `Stop` | — | NEVER infers completion; coordinator determines terminal state |
| `SubagentStop` | — | NEVER infers completion; coordinator determines terminal state |

## Safety Contract
1. **Fail closed**: Unknown hook names are silently ignored.
2. **Redaction**: prompt, session, path, command, tool payload, and credentials are always redacted.
3. **Rate limiting**: PostToolUse is limited to 1 emission per 5000ms per tool name.
4. **Test signal**: PostToolUse with test commands (npm test, vitest, jest, node --test, etc.) maps to `task.testing`.
5. **Evidence validation**: Only evidence refs matching allowed patterns (ARTIFACT-*, RUN-*, ./relative, src/, lib/, tests/, docs/) are forwarded.
6. **No completion inference**: Stop and SubagentStop never emit `task.completed` or `task.failed`.

## Integration
The adapter is available at `lib/coordination/claude-hook-adapter.js`. Create an instance with `createClaudeHookAdapter({ rateLimitMs })` and dispatch hook payloads via `adapter.dispatch(hookName, payload)`. Each handler returns a structured result with `ok`, `code`, and `eventType` fields.

## Hook Executable
The governed hook executable is at `bin/cortex-claude-hook`. It accepts a hook name as the first argument and bounded JSON from stdin. Identity is derived exclusively from `CORTEX_LAUNCH_CONTEXT`. Governance fields in stdin are rejected.

### Claude Code Settings
To wire the governed hooks into Claude Code, add the hooks from `.agent/hooks/claude-governed-hooks.json` to your `~/.claude/settings.json` or project `.claude/settings.json`:

```bash
# Install the hook executable (or link locally)
cortex-agent bin/cortex-claude-hook is available in the package bin directory.
```

The settings use `npx --yes cortex-claude-hook` to invoke the executable without hard-coded absolute paths. Each hook is routed to the corresponding handler, with identity derived from `CORTEX_LAUNCH_CONTEXT`.
