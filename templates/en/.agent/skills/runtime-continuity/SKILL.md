---
name: runtime-continuity
description: session-manager 5-mode protocol implemented as a CLI: assess / archive / restore / status / warm. Reads .agent/sub-agents/session-manager.md as source of truth. Archive path is ~/.agent/contexts/<project>/, same as session-manager.
---

# runtime-continuity (L1 — session-manager CLI shell)

Hosts (Claude Code / Cursor / Codex) can't easily spawn a sub-agent
definition like `sub-agents/session-manager.md` and wait for output.
This skill wraps that sub-agent's 5-mode protocol in a CLI surface so
any host can invoke the same time-management discipline.

> The authoritative protocol lives at `.agent/sub-agents/session-manager.md`.
> This file does NOT redefine it.  Only implementational details differ
> (CLI args vs Sub-Agent triggering), and only when CLI mechanics require.

## When to Use

- Hit the 5-hour session time limit → run `warm` first to start the
  timer; on every 4-hour mark, run `archive` to make a checkpoint.
- Switching host agent mid-task (Claude Code → Codex, etc.) → run
  `archive` then `host-switch` on the new host (Phase 2).
- Resume work next day / next session / new agent → run `restore`.
- Checking "how stale is this session" → run `status`.

## Commands

```bash
# 0. assess — evaluate time budget for a task description
node .agent/skills/runtime-continuity/scripts/index.js assess \
  --task-description "..." --gate user

# 1. archive — write a snapshot to ~/.agent/contexts/<project>/
node .agent/skills/runtime-continuity/scripts/index.js archive \
  --project <project> --gate user [--note "已完成 X / 进行 Y / 卡点 Z"]

# 2. restore — load latest snapshot for a project
node .agent/skills/runtime-continuity/scripts/index.js restore \
  --project <project> --gate user [--list | --load latest]

# 3. status — show last archive timing
node .agent/skills/runtime-continuity/scripts/index.js status \
  --project <project>

# 4. warm — output the "5-hour timer starting" prompt for the host
node .agent/skills/runtime-continuity/scripts/index.js warm
```

## Guarantees

- **Reuses session-manager path & protocol**: archive writes to the same
  `~/.agent/contexts/<project>/` directory that session-manager
  sub-agent uses.  No parallel paths, no divergence.
- **Audit-friendly**: every archive / restore / status call writes
  one `session_archived` / `session_restored` / `session_status_queried`
  event into `runs/<active-run>.json#events[]` so the audit-trail
  can correlate.
- **Zero dependency**: pure stdlib + existing management-api events
  writer.  No npm install.

## Non-Goals

- Does NOT modify `.agent/sub-agents/session-manager.md`.
- Does NOT crawl host private state (Claude Code transcripts, etc.).
- Does NOT block host switch unless explicitly invoked via
  `host-switch` (Phase 2 / 3, draft).

## Source of Truth

- `.agent/sub-agents/session-manager.md` — the canonical 5-mode protocol.
  When in doubt about *what to say*, read that file.
- This `SKILL.md` — when in doubt about *how to invoke it as a CLI*,
  read this file.

For more on the spec (helpers, return-shape, edge cases), read
`scripts/index.js` directly — it is single-file and well-commented.
