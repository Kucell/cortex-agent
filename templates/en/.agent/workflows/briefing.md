---
name: briefing
description: Produce a read-only project briefing covering progress, active work, Decisions, Waitpoints, Inbox, and recommended next actions.
---

# Project Briefing Workflow (/briefing)

Use this workflow to regain project context without changing coordinator state.

## 1. Progress Scan

- Read `.agent/plans/task-progress.md`, active Mission plans, milestones, and Task state.
- Summarize recent accomplishments and the distance to the next milestone.
- When available, inspect recent Git history and working-tree status without modifying them.

## 2. Active Scene

- Identify the highest-priority active Task and Mission milestone.
- Read the relevant plan, Run, Queue, Session, lock, and handoff records.
- Report the exact stopping point, owner, evidence, and one recommended next action.

## 3. Communication and Approval State

Run only these read-only queries:

```bash
node .agent/skills/management-api/scripts/index.js query decisions
node .agent/skills/management-api/scripts/index.js query waitpoints
node .agent/skills/management-api/scripts/index.js query inbox
```

Report:

- Open Decisions: ID, prompt, action, exact `resource_ref`, requester, and `/approve decision <decision-id>` as the explicit command; for one unambiguous current Decision, the user may instead reply `approve`, `reject`, or `revise`, which the main agent routes through `/approve` for persistence.
- Pending or blocked Waitpoints: ID, owner workflow, reason, Decision ID, protected resource, and release condition.
- Unread Inbox messages: ID, sender, subject, type, related resources, and intended recipient.

Prioritize the open Decision attached to a blocking Waitpoint, then other open Decisions, unread Inbox, and ordinary tasks. Dashboard and `/briefing` are read-only: they must never resolve a Decision, release a Waitpoint, or acknowledge Inbox messages.

## 4. Risk and Knowledge Health

Summarize blocked or pending work, stale sessions, held locks, validation failures, and unresolved handoffs. When present, read entropy, component health, knowledge health, doc-gardening, and coordinator-health reports. If a report is absent, state that it has not been generated instead of inventing a score.

## 5. Briefing Output

Produce a concise report containing:

- **Overall position**: current phase and distance to the next milestone.
- **Recent progress**: material work completed in the last day.
- **Active focus**: Task/Mission IDs and exact work point.
- **Recommended entry point**: the first file, command, or workflow to open.
- **Risks**: validation, coordination, knowledge, or release concerns.
- **User Decisions**: open Decisions with exact resource refs and `/approve decision D-...`.
- **Blockers**: blocking Waitpoints, owner workflow, and release conditions.
- **Unread messages**: concise Inbox summary without acknowledging it.

## Safety Boundary

- This workflow is read-only. It does not run `decisions resolve`, `waitpoints release`, or Inbox transitions.
- A Dashboard request, `--gate approve`, prior choice, or silence is never approval.
- Destructive, credential, and external-side-effect operations require resource-bound Decision/Waitpoint records created and consumed by the owning workflow.
- Never automatically run `reset`, `revert`, `push`, `deploy`, `publish`, or another external side effect.
