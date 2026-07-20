---
name: management-api
description: Local management query and controlled runtime-state writer for Cortex Agent dashboard, runs, queues, sessions, inbox, decisions, and waitpoints.
---

# Management API Skill

## Purpose

Provide a stable local JSON query contract over `.agent/` runtime state. Dashboard, briefing, worktree, mission, and future CLI commands should read this layer instead of each parsing the same Markdown and JSON files differently.

Runtime writers are intentionally narrow: write run state and run events through this skill so dashboard status reflects what agents are actually doing.

## Commands

```bash
node .agent/skills/management-api/scripts/index.js query dashboard-state
node .agent/skills/management-api/scripts/index.js query runs
node .agent/skills/management-api/scripts/index.js query queues
node .agent/skills/management-api/scripts/index.js query sessions
node .agent/skills/management-api/scripts/index.js query inbox
node .agent/skills/management-api/scripts/index.js query decisions
node .agent/skills/management-api/scripts/index.js query waitpoints
node .agent/skills/management-api/scripts/index.js runs upsert --run-id R-T005 --task-id T-005 --kind implement --status running --phase decomposing --activity "正在拆分 Adapter"
node .agent/skills/management-api/scripts/index.js runs event --run-id R-T005 --type agent_invoked --phase invoking_agent --message "已调用 editor-adapter-agent"
node .agent/skills/management-api/scripts/index.js runs checkpoint --run-id R-T005 --task-id T-005 --type validation_started --phase validating --activity "Running focused tests"
node .agent/skills/management-api/scripts/index.js queues upsert --queue-id Q-batch-1 --gate parallel --name "Batch 1" --concurrency-limit 2
node .agent/skills/management-api/scripts/index.js decisions request --decision-id D-merge --gate mission --requested-by coordinator --prompt "Approve merge?" --options '["approve","reject"]' --action merge --resource-ref branch:integration
node .agent/skills/management-api/scripts/index.js decisions resolve --gate user --decision-id D-merge --status approved --selected-option approve --resolved-by maintainer --rationale "Validation passed."
node .agent/skills/management-api/scripts/index.js inbox send --message-id IM-001 --gate workflow --sender-id coordinator --recipient-ids reviewer --subject "Review ready"
node .agent/skills/management-api/scripts/index.js inbox transition --message-id IM-001 --gate recipient --actor-id reviewer --status acknowledged
node .agent/skills/management-api/scripts/index.js waitpoints create --waitpoint-id WP-merge --gate mission --owner-workflow /checkpoint-merge --reason "Merge approval required" --action merge --resource-ref branch:integration --decision-id D-merge
node .agent/skills/management-api/scripts/index.js waitpoints release --waitpoint-id WP-merge --gate owner --owner-workflow /checkpoint-merge --decision-id D-merge --released-by coordinator
node .agent/skills/management-api/scripts/index.js waitpoints cancel --waitpoint-id WP-cancel --gate owner --owner-workflow /checkpoint-merge --reason "External action removed"
node .agent/skills/management-api/scripts/index.js queues item --queue-id Q-batch-1 --gate parallel --task-id T-005 --state running --run-id R-T005
node .agent/skills/management-api/scripts/index.js sessions open --session-id S-dashboard --agent-id dashboard-manager --role dashboard-manager
node .agent/skills/management-api/scripts/index.js sessions heartbeat --session-id S-dashboard --agent-id dashboard-manager --activity "Refreshing dashboard"
node .agent/skills/management-api/scripts/index.js sessions close --session-id S-dashboard --agent-id dashboard-manager --gate owner
```

These commands feed the Dashboard read-only view: every mutation is gated by an explicit workflow, owner, user, or recipient role.

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
  "runs": [],
  "queues": [],
  "sessions": [],
  "prds": [],
  "prd_summary": {
    "status": "not_started",
    "design": "not_started",
    "review": "open",
    "completeness": 0,
    "missing": [],
    "current_id": null
  },
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

Focused runtime queries are read-only and return smaller payloads:

- `query runs`: `{ ok, query, generated_at, runs, summary }`
- `query queues`: `{ ok, query, generated_at, queues, summary }`
- `query sessions`: `{ ok, query, generated_at, sessions, summary }`

Use focused queries for CLI/status views that do not need the full dashboard payload.

## Runtime State Contract

Use these fields for precise state:

- `status`: lifecycle state, one of `queued`, `running`, `completed`, `failed`, `canceled`.
- `phase`: current execution phase, such as `decomposing`, `creating_worktree`, `acquiring_lock`, `invoking_agent`, `reading`, `editing`, `running_command`, `validating`, `handoff`, `merging`, or `blocked`.
- `activity`: short human-readable text for the current visible activity.
- `events[]`: append-only timeline of important transitions.
- `last_event`: cached latest event for dashboards and summaries.
- `runs checkpoint`: preferred workflow helper that updates run state and appends one event in a single command.

Agents should update state at these minimum checkpoints:

1. task decomposition starts
2. worktree creation starts or completes
3. task/file lock acquisition starts or completes
4. sub-agent invocation starts
5. file reading or editing begins
6. shell command or validation starts and finishes
7. handoff, merge, publish, block, fail, cancel, or complete happens

Prefer these stable `events[].type` values:

- `state_changed`
- `task_decomposed`
- `worktree_created`
- `lock_acquired`
- `agent_invoked`
- `file_read`
- `file_edited`
- `command_started`
- `command_finished`
- `validation_started`
- `validation_passed`
- `validation_failed`
- `handoff_created`
- `merge_started`
- `merge_completed`
- `publish_started`
- `publish_completed`
- `blocked`
- `failed`
- `canceled`
- `completed`

## Rules

- Keep this skill zero dependency.
- Read from `.agent/` and Git only.
- Only mutate `.agent/runs/*.json` through the `runs upsert`, `runs event`, and `runs checkpoint` commands.
- Queue mutations require `--gate parallel|worktree|approve|mission`; session heartbeats require the recorded owner, while pause/close require `--gate owner|handoff|user|mission`.
- Runtime JSON writes use a temporary sibling file followed by atomic rename; read-only queries never write derived stale state.
- Runtime objects live under `.agent/runs/`, `.agent/queues/`, and `.agent/sessions/`.
- PRD objects live under `.agent/prd/` or `.agent/prds/`; dashboard-state exposes `prds` and `prd_summary`.
- Running or paused sessions whose `last_heartbeat_at` is older than five minutes are reported as `stale`.
- Preserve compatibility with older projects by tolerating missing files.
- If a caller needs HTML, it should render JSON itself; this skill only returns data.
