---
name: runtime-continuity
description: session-manager protocol plus Runtime Continuity v2 as a CLI: assess / log / checkpoint / archive / restore / status / warm / host-switch / resume-bundle / list-contexts. Writes transferable work state to .agent/runtime-continuity/ and readable archives to ~/.agent/contexts/<project>/.
---

# runtime-continuity (L1 — session-manager CLI shell + Runtime Continuity v2)

Hosts (Claude Code / Cursor / Codex) can't easily spawn a sub-agent
definition like `sub-agents/session-manager.md` and wait for output.
This skill wraps that sub-agent's time-management protocol in a CLI surface so
any host can invoke the same continuity discipline. Runtime Continuity v2 adds
standard work-log events, structured archives, and resume bundles under
`.agent/runtime-continuity/`.

> The authoritative protocol lives at `.agent/sub-agents/session-manager.md`.
> This file does NOT redefine it.  Only implementational details differ
> (CLI args vs Sub-Agent triggering), and only when CLI mechanics require.

## When to Use

- Hit the 5-hour session time limit → run `warm` first to start the
  timer; on every 4-hour mark, run `archive` to make a checkpoint.
- Switching host agent mid-task (Claude Code → Codex, etc.) → run
  `host-switch` before leaving the old host.
- Resume work next day / next session / new agent → run `resume-bundle`
  first, then `restore --auto` if the Markdown body is needed.
- Checking "how stale is this session" → run `status`.
- Recording transferable work state → run `log` or `checkpoint` during work.

## Commands

```bash
# 0. assess — evaluate time budget for a task description
node .agent/skills/runtime-continuity/scripts/index.js assess \
  --task-description "..." --gate user

# 1. log — append transferable work log to .agent/runtime-continuity/events/
node .agent/skills/runtime-continuity/scripts/index.js log \
  --project <project> --gate agent --host codex --message "..." \
  --done "..." --in-progress "..." --next "..." --files a,b

# 2. checkpoint — append a stronger phase boundary event
node .agent/skills/runtime-continuity/scripts/index.js checkpoint \
  --project <project> --gate agent --host codex --phase validating \
  --message "..." --command "node tests/foo.test.js" --exit-code 0

# 3. archive — write Markdown + structured JSON snapshot
node .agent/skills/runtime-continuity/scripts/index.js archive \
  --project <project> --gate user --full \
  --note-json '{"done":["X"],"in_progress":"Y","next":["Z"]}'

# 4. restore — load latest snapshot for a project
node .agent/skills/runtime-continuity/scripts/index.js restore \
  --project <project> [--list | --auto | --gate user]

# 5. resume-bundle — default new-agent entrypoint
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle \
  --project <project>

# 6. status — show last archive timing
node .agent/skills/runtime-continuity/scripts/index.js status \
  --project <project>

# 7. warm — output the "5-hour timer starting" prompt for the host
node .agent/skills/runtime-continuity/scripts/index.js warm
node .agent/skills/runtime-continuity/scripts/index.js warm \
  --auto --project <project>

# 8. host-switch — cross-host migration
node .agent/skills/runtime-continuity/scripts/index.js host-switch \
  --project <project> \
  --from-host claude-code --to-host codex \
  --reason "user wants codex now" \
  --gate user \
  --note-json '{"done":["X"],"in_progress":"Y","next":["Z"]}'

# 9. list-contexts — cross-project aggregation
#    Lists every project under ~/.agent/contexts/ with archive counts and
#    most-recent timestamps.  No --gate required (read-only).
node .agent/skills/runtime-continuity/scripts/index.js list-contexts \
  [--since 2026-07-01] [--format json|table]
```

## Guarantees

- **Reuses session-manager path & protocol**: archive writes to the same
  `~/.agent/contexts/<project>/` directory that session-manager
  sub-agent uses.  No parallel paths, no divergence.
- **Project-local resume state**: archive also writes
  `.agent/runtime-continuity/archives/RC-*.json` and
  `.agent/runtime-continuity/archives/latest.json`.
- **New-agent entrypoint**: `resume-bundle` summarizes latest archive,
  handoffs, runs, sessions, artifacts, runtime events, and git state.
- **Audit-friendly**: every archive / restore / status call writes
  one `session_archived` / `session_restored` / `session_status_queried`
  event into `runs/<active-run>.json#events[]` so the audit-trail
  can correlate.
- **Zero dependency**: pure stdlib + existing management-api events
  writer.  No npm install.

## Non-Goals

- Does NOT modify `.agent/sub-agents/session-manager.md`.
- Does NOT crawl host private state (Claude Code transcripts, Codex
  conversation history, browser cookies, etc.).
- Does NOT store secrets or full diffs; store paths, commands, summaries, and
  artifact references instead.

## Source of Truth

- `.agent/sub-agents/session-manager.md` — the canonical 5-mode protocol.
  When in doubt about *what to say*, read that file.
- This `SKILL.md` — when in doubt about *how to invoke it as a CLI*,
  read this file.

For more on the spec (helpers, return-shape, edge cases), read
`scripts/index.js` directly — it is single-file and well-commented.
