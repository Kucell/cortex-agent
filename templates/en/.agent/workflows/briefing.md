---
name: briefing
description: Produce a read-only project briefing covering progress, active work, Decisions, Waitpoints, Inbox, and recommended next actions.
---

# Project Briefing Workflow (/briefing)

Use this workflow to regain project context without changing coordinator state.

## 0. Runtime Continuity Resume Bundle

Run the read-only resume entrypoint first so a new host agent can recover the
latest transferable work state for the same project:

```bash
PROJECT_NAME=$(basename "$(pwd)")
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project "$PROJECT_NAME"
```

Summarize these fields when present:

- `latest_archive` / `latest_markdown_archive`
- `runtime_events`
- `pending_handoffs`
- `runs` / `sessions`
- `artifact_states`
- `git.status_short`
- `next_action`

If `latest_archive` is absent, say that no Runtime Continuity archive exists
yet, then continue with the rest of the read-only briefing scan.

## 0.5 One-Click Update Status

## One-Click Update: {status}

- Update ID: {update_id}
- Finished: {finished_at}
- Changes: added={summary.added}, updated={summary.updated}, merged={summary.merged}, protected={summary.protected}
- Verification: failed={summary.verification_failed}, skipped={summary.verification_skipped}
- Report: .agent/updates/latest.json
```

If `status` is `failed`, include it in Risks. If it is `partial`, list the
protected items and remind the user to review before considering
`--force-scripts`. If the report is missing, say: "No One-Click Update report
has been generated yet; run `cortex-agent update --verify --report json` to
check the current upgrade state."


## 0.6 cortex-agent update reminder

Read-only probe of the latest published version. Never auto-upgrades.

```bash
# emits a single JSON envelope with the `available_update` field
cortex-agent doctor --json
```

`available_update` field contract (`/Users/xueyq/myworks/cortex-agent/lib/commands/doctor.js`):

- `status`: `"current"` / `"outdated"` / `"unknown"` (registry unreachable)
- `current`: CLI version (mirrors `package.json`)
- `latest`: registry latest version; `null` when unreachable
- `outdated`: `true` / `false` / `null` (1-to-1 with `status`)
- `upgrade_hint`: present only when `outdated === true`
- `checked_at`: ISO timestamp

**Output guidance**:

- `status === "outdated"`: surface `upgrade_hint` (suggest `npm install -g cortex-agent@<latest>`, then `cortex-agent upgrade`) and list it under Risks / Today's actions.
- `status === "unknown"`: note "could not reach npm registry"; do not block the briefing.
- `status === "current"`: stay silent; do not nag.

**Explicit boundary**: this probe does **not** fire on SessionStart, does **not** write `.agent/.cortex-version`, and does **not** invoke `cortex-agent upgrade` / `update`. Version bumps still require explicit owner action.

## 1. Progress Scan

- Read `.agent/plans/task-progress.md`, active Mission plans, milestones, and Task state.
- Summarize recent accomplishments and the distance to the next milestone.
- When available, inspect recent Git history and working-tree status without modifying them.

## 1.5 Module / Subsystem Progress

After the Roadmap / Mission summary, include a separate module or subsystem view that answers: "How far has each major part of the project progressed?"

### Evidence priority

Use these sources in order. Do not invent values just to fill a table:

1. `.agent/references/context-index.json` and the corresponding module references, when available.
2. Structured Mission / Milestone / Task state.
3. `.agent/plans/task-progress.md` and relevant child plans.
4. Git / PR / CI / validation evidence only as implementation evidence; they do not independently mean "complete".

If no module index exists, state "module baseline not established" and recommend `/scan-project`. If the code has changed materially and references are stale, recommend `/update-refs`.

### Required output

Include at least:

| Module / Subsystem | Current Scope | Status | Progress | Evidence / Source | Next Gap |
| :--- | :--- | :--- | :--- | :--- | :--- |
| {module} | {scope} | {PASS / IN PROGRESS / BLOCKED / PLANNED} | {explicit percentage or "unquantified"} | {Mission / Task / Reference / PR / CI} | {next gap} |

Rules:

- **Never calculate completion from file counts, commit counts, PR counts, or subjective impressions.**
- Show a percentage only when structured state or an authoritative project plan explicitly provides one; otherwise use "unquantified".
- Keep Milestone progress and module progress separate: one Milestone may span several modules, and one module may evolve across several Milestones.
- If code is implemented but governance evidence, validation contracts, or merge are still pending, use a layered state such as "Implementation Complete / Governance Pending" instead of PASS.
- Follow **EXP-003**: keep state dimensions structurally separate and use one source of truth for shared state; never interpret free-text words such as "passed" or "complete" as authoritative task state.
- When the user requests "overall project progress", this module table is part of the default output, not an optional appendix.

---

## 2. Active Scene

- Identify the highest-priority active Task and Mission milestone.
- Read the relevant plan, Run, Queue, Session, lock, and handoff records.
- Report the exact stopping point, owner, evidence, and one recommended next action.

## 3. Communication and Approval State

Run only these read-only queries:

```bash
cortex-agent query decisions --project .
cortex-agent query waitpoints --project .
cortex-agent query inbox --project .
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
- **Module progress**: module/subsystem status, explicit progress when available, evidence, and next gaps.
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
