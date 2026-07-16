---
name: management-api
description: Read-only local management query layer for Cortex Agent runtime state, starting with dashboard-state.
---

# Management API Skill

## Purpose

Provide a stable local JSON query contract over `.agent/` runtime state. Dashboard, briefing, worktree, mission, and future CLI commands should read this layer instead of each parsing the same Markdown and JSON files differently.

Phase 1 is read-only. It does not mutate tasks, locks, worktrees, sessions, queues, or runs.

## Commands

```bash
node .agent/skills/management-api/scripts/index.js query dashboard-state
```

## Output Contract

`query dashboard-state` returns JSON:

```json
{
  "ok": true,
  "query": "dashboard-state",
  "project": {
    "name": "project-name",
    "root": "/path/to/project"
  },
  "tasks": [],
  "worktrees": [],
  "agents": [],
  "locks": [],
  "handoffs": [],
  "artifacts": [],
  "git_status": "",
  "derived": {
    "state": "idle",
    "next": "...",
    "nextEn": "...",
    "why": "...",
    "whyEn": "..."
  },
  "summary": {
    "active_tasks": 0,
    "held_locks": 0,
    "non_main_worktrees": 0
  }
}
```

## Rules

- Keep this skill zero dependency.
- Read from `.agent/` and Git only.
- Do not write state in Phase 1.
- Preserve compatibility with older projects by tolerating missing files.
- If a caller needs HTML, it should render JSON itself; this skill only returns data.
