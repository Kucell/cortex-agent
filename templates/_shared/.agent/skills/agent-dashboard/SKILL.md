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

The server regenerates the HTML periodically and uses browser auto-refresh over SSE. Task cards open a read-only Markdown preview drawer. Related task records, proposals, source refs, artifacts, and gate evidence can be opened without leaving the dashboard.

Markdown previews use the vendored `markdown-it` browser build under `vendor/`. It is embedded into generated HTML for offline use, renders CommonMark plus built-in GFM tables and strikethrough, and keeps source HTML disabled. The upstream MIT license is stored in `vendor/LICENSE.markdown-it`.
Links inside previewed Markdown stay navigable: supported project-relative documents open in the same preview dialog, anchors scroll within the document, and external URLs open in a new tab.

The preview drawer reads documents through:

```text
GET /api/preview?path=<project-relative-path>
```

Only `.agent/**`, `docs/**`, and root `README.md`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` files with Markdown, JSON, or text extensions are allowed. Absolute paths, traversal, escaped symlinks, directories, and files over 1 MiB are rejected.

## Data Sources

Read these when available:

- `.agent/plans/task-progress.md`
- `.agent/tasks/*.json` task relations, source refs, artifacts, and gate evidence
- `.agent/plans/proposals/**/*.md` files that explicitly reference a task ID
- `.agent/prd/index.json` and `.agent/prd/*/state.json`
- `.agent/prd/*/prd.md`, `flows.md`, `screens.md`, and `acceptance-criteria.md`
- `.agent/registry/agents.json`
- `.agent/locks/lock-events.json`
- `.agent/handoffs/*.md` and `.agent/handoffs/*.json`
- `.agent/artifacts/*/state.json`
- `git status --short --branch`
- `git worktree list --porcelain`

## Rules

- Do not copy source code or large diffs into the dashboard.
- Keep task and document previews read-only. Never add approval, release, task mutation, or arbitrary filesystem access to the preview surface.
- Show paths, task IDs, branches, lock scopes, handoff files, and validation state.
- Always include a `Worktree State` and `Recommended Next Action`.
- Always include PRD status and completeness when `.agent/prd/` exists.
- If data is missing, show an empty state instead of failing.
- The dashboard is local operational state and should stay under `.agent/metrics/`.
- Do not commit `.agent/metrics/agent-dashboard.html`; commit the source state under `.agent/plans/`, `.agent/registry/`, `.agent/locks/`, `.agent/handoffs/`, and `.agent/artifacts/` instead.
