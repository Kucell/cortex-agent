---
name: management-api
description: Local management query and controlled runtime-state writer for Cortex Agent dashboard, runs, queues, sessions, inbox, decisions, and waitpoints.
---

# Management API Skill

## Purpose

Provide a stable local JSON query contract over `.agent/` runtime state. Dashboard, briefing, worktree, mission, and future CLI commands should read this layer instead of each parsing the same Markdown and JSON files differently.

Runtime writers are intentionally narrow: write run state and run events through this skill so dashboard status reflects what agents are actually doing.

## Commands

Agents must discover and use the public CLI contract first:

```bash
cortex-agent help --json
cortex-agent help query --json --project .
cortex-agent query dashboard-state --project .
cortex-agent query runs --project .
cortex-agent query activity --project . --since 2026-07-13 --until 2026-07-19
cortex-agent runs checkpoint --project . --run-id R-T005 --task-id T-005 --type validation_started --phase validating --activity "Running focused tests"
cortex-agent queues upsert --project . --queue-id Q-batch-1 --gate parallel --name "Batch 1" --concurrency-limit 2
cortex-agent sessions heartbeat --project . --session-id S-dashboard --agent-id dashboard-manager --activity "Refreshing dashboard"
cortex-agent decisions resolve --project . --decision-id D-merge --gate user --status approved --selected-option approve --resolved-by maintainer --rationale "Validation passed"
cortex-agent waitpoints release --project . --waitpoint-id WP-merge --gate owner --owner-workflow /checkpoint-merge --decision-id D-merge --released-by coordinator
```

`cortex-agent help --json` is the machine-readable source for CLI grammar and writer actions. `cortex-agent help query --json --project <path>` adds the target project's real projection capabilities. Internal `.agent/skills/management-api/scripts/index.js` commands are implementation/debug entry points and may be used only when an older installed CLI cannot expose the required capability; record that fallback explicitly.

## Output Contract

Public `cortex-agent query` returns a stable envelope:

```json
{
  "ok": true,
  "command": "query",
  "projection": "dashboard-state",
  "project": {
    "root": "/path/to/project",
    "agent_root": "/path/to/project/.agent"
  },
  "filters": {},
  "data": {},
  "summary": {},
  "warnings": []
}
```

All public queries are read-only. `activity` places records without valid structured timestamps in `data.unknown_time`; it never infers completion from file mtime or plan text. Failures write structured JSON to stdout and diagnostics to stderr, with stable exit classes documented by the CLI contract.

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

- Use `cortex-agent help --json` before relying on remembered CLI syntax; use target capability discovery before cross-project automation.
- Standard Agent workflows must call `cortex-agent`, not the internal Management API script path.
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
