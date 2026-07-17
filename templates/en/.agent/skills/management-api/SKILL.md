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
node .agent/skills/management-api/scripts/index.js queues item --queue-id Q-batch-1 --gate parallel --task-id T-005 --state running --run-id R-T005
node .agent/skills/management-api/scripts/index.js sessions open --session-id S-dashboard --agent-id dashboard-manager --role dashboard-manager
node .agent/skills/management-api/scripts/index.js sessions heartbeat --session-id S-dashboard --agent-id dashboard-manager --activity "Refreshing dashboard"
node .agent/skills/management-api/scripts/index.js sessions close --session-id S-dashboard --agent-id dashboard-manager --gate owner
node .agent/skills/management-api/scripts/index.js decisions request --decision-id D-merge --gate mission --type merge --requested-by coordinator --prompt "Approve merge?" --action merge --resource-ref branch:integration
node .agent/skills/management-api/scripts/index.js decisions resolve --decision-id D-merge --gate user --status approved --selected-option approve --resolved-by maintainer --rationale "Validation passed"
node .agent/skills/management-api/scripts/index.js decisions supersede --decision-id D-old --gate requester --superseded-by-decision-id D-new --superseded-by coordinator --rationale "A new revision replaced the old one"
node .agent/skills/management-api/scripts/index.js waitpoints create --waitpoint-id WP-merge --gate mission --owner-workflow /checkpoint-merge --reason "Merge approval required" --action merge --resource-ref branch:integration --decision-id D-merge
node .agent/skills/management-api/scripts/index.js waitpoints release --waitpoint-id WP-merge --gate owner --owner-workflow /checkpoint-merge --decision-id D-merge --released-by coordinator
node .agent/skills/management-api/scripts/index.js waitpoints cancel --waitpoint-id WP-merge --gate owner --owner-workflow /checkpoint-merge --reason "Checkpoint scope changed"
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
- `query inbox`: `{ ok, query, generated_at, inbox, summary }`
- `query decisions`: `{ ok, query, generated_at, decisions, summary }`
- `query waitpoints`: `{ ok, query, generated_at, waitpoints, summary }`

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
- Decision requests require an owning workflow gate. Approval, rejection, or revision requires `decisions resolve --gate user`, a resolver, and rationale; callers cannot resolve an already terminal Decision. Superseding an open Decision requires `decisions supersede --gate requester`, the same requester on a compatible open replacement, and rationale.
- Waitpoint release requires its owning workflow plus an approved Decision whose action and resource exactly match the Waitpoint. The Decision file is recorded in `evidence_refs`; an elapsed or invalid `expires_at` fails closed.
- Waitpoint cancel requires its owner, Mission, or explicit user gate. Expiry requires owner/Mission authority and an elapsed `expires_at`; read-time expiry remains non-mutating.
- Caller-provided date-time values must be valid RFC 3339 values before any record is written.
- Inbox transitions enforce recipient or originating-workflow ownership. Acknowledging a message never approves a Decision or releases a Waitpoint.
- Dashboard and all `query` commands are read-only; they cannot resolve Decisions or release Waitpoints.
- Runtime JSON writes use a temporary sibling file followed by atomic rename; read-only queries never write derived stale state.
- Runtime and coordination objects live under `.agent/runs/`, `.agent/queues/`, `.agent/sessions/`, `.agent/inbox/`, `.agent/decisions/`, and `.agent/waitpoints/`.
- PRD objects live under `.agent/prd/` or `.agent/prds/`; dashboard-state exposes `prds` and `prd_summary`.
- Running or paused sessions whose `last_heartbeat_at` is older than five minutes are reported as `stale`.
- Preserve compatibility with older projects by tolerating missing files.
- If a caller needs HTML, it should render JSON itself; this skill only returns data.
