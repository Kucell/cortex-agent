---
name: agent-dashboard
description: Generate a local HTML dashboard for task progress, worktree collaboration, active agents, locks, handoffs, and recommended next actions.
---

# Agent Dashboard Skill

## Purpose

Generate a human-readable local HTML dashboard from `.agent/` coordination state. This is for people to understand progress quickly; machine coordination remains in registry, locks, artifacts, handoffs, and workflows.

## Command

```bash
node .agent/skills/agent-dashboard/scripts/generate.js
```

Default output:

```text
.agent/metrics/agent-dashboard.html
```

Optional output:

```bash
node .agent/skills/agent-dashboard/scripts/generate.js --out .agent/metrics/my-dashboard.html
```

Serve with live updates:

```bash
node .agent/skills/agent-dashboard/scripts/serve.js --port 8787 --interval-ms 3000
```

The server regenerates the HTML periodically and uses browser auto-refresh over SSE.

## Data Sources

Read these when available:

- `.agent/plans/task-progress.md`
- `.agent/registry/agents.json`
- `.agent/locks/lock-events.json`
- `.agent/handoffs/*.md` and `.agent/handoffs/*.json`
- `.agent/artifacts/*/state.json`
- `git status --short --branch`
- `git worktree list --porcelain`

## Rules

- Do not copy source code or large diffs into the dashboard.
- Show paths, task IDs, branches, lock scopes, handoff files, and validation state.
- Always include a `Worktree State` and `Recommended Next Action`.
- If data is missing, show an empty state instead of failing.
- The dashboard is local operational state and should stay under `.agent/metrics/`.
