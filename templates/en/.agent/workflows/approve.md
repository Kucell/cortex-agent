---
name: approve
description: Approve an architecture proposal and dispatch it to /plan (small) or /mission (large), establishing bidirectional links.
---

# Proposal Approval and Dispatch Workflow (/approve)

Advances a confirmed architecture design proposal from `draft` to execution.
This command is the single handoff point between `/arch-design` and `/plan` / `/mission`.

## Usage

```
/approve <proposal-file-path>
/approve .agent/plans/proposals/xxx-proposal.md
/approve .agent/plans/proposals/projects/<project-slug>/index.md
```

## Prerequisites

- The input is a standalone proposal, project-level `index.md`, or project child proposal under `.agent/plans/proposals/`.
- The selected approval scope has `draft` status (if already `approved` or higher, a notice is shown and the command stops).
- The selected scope contains an `Implementation Plan`, `Phase`, or milestone suitable for scale assessment.

---

## Steps

### Step 1: Read and validate the proposal

1. Read the specified proposal file. For a project-level `index.md`, read the entry first and then the child proposals associated with the selected milestone; for a child proposal, also read its project's `index.md`.
2. Determine the approval scope: standalone proposal, entire project, milestone, or child proposal. If a project-level input does not state the scope, ask the user to select it; never approve the whole project by default.
3. Confirm the selected scope's `> **Status**:` field or index status exists and is `draft`.
   - If already `approved` or higher: show "Proposal already approved — no action needed." and stop.
   - If the status field is missing: ask the user to add the standard status fields to the proposal header, then stop.
4. Extract details for the selected scope:
   - Core objective (one sentence)
   - Number of Phases (count `### Phase` headings)
   - Milestones and child proposals included in a project-level scope
   - Any mention of cross-session or multi-day scope

### Step 2: Scale assessment

Apply the following rules to the selected approval scope and present a routing suggestion (user confirms; not enforced):

| Condition | Suggested route |
| :-------- | :-------------- |
| ≤ 2 Phases and no cross-session mention | `/plan` (small task) |
| ≥ 3 Phases, or multi-day/cross-session, or milestone validation required | `/mission` (large task) |

Output suggestion format:

```
📋 Proposal: xxx-proposal.md
🎯 Core Objective: [one-sentence goal]
📊 Scale Assessment: [N] Phases → Recommended: [/plan | /mission]

Reason: [Phase count / cross-session scope / validation requirements]

Confirm dispatch? (plan / mission / cancel)
```

Wait for user confirmation. Users may override the suggestion (e.g., choose `plan` even if `mission` is recommended).

### Step 3: Update proposal status

After confirmation, update only the selected approval scope:

- Standalone or child proposal: change its header status from `draft` to `approved`; for a child proposal, also update its row in `index.md`.
- Entire project: update the project status in `index.md` without automatically approving child proposals that require separate review.
- Milestone: update that milestone in `index.md` and only the child proposals explicitly included in this approval.

Proposal file status format:

```markdown
> **Status**: approved
```

### Step 4: Dispatch to execution

**Route A: /plan (small task)**

Run `/plan --from-proposal <proposal-file-path>`:
- For a project-level scope, pass `index.md`; `/plan` then reads the selected milestone and related child proposals from the entry
- For a standalone or child proposal, use its Phase list as task decomposition input
- Back-fill the resulting Task IDs into the proposal's `Execution Vehicle` field
- Change proposal status from `approved` to `in-progress`

**Route B: /mission (large task)**

Run `/mission create --from-proposal <proposal-file-path>`:
- For a project-level scope, pass `index.md` and build execution milestones from the selected milestone and related child proposals
- For a standalone or child proposal, map each Phase to a milestone
- Back-fill the Mission ID into the proposal's `Execution Vehicle` field
- Change proposal status from `approved` to `in-progress`

### Step 5: Output confirmation

```
✅ Proposal approved: xxx-proposal.md
📌 Execution Vehicle: [T-006~T-008 | M-002]
🔗 Bidirectional links established

Suggested next step:
  Small task → /start-task T-006
  Large task → /mission status M-002
```

---

## Proposal Header Standard Fields Reference

```markdown
> **Status**: draft → approved → in-progress → done | superseded
> **Execution Vehicle**: pending approval (auto-filled by /approve)
> **Archived Doc**: — (auto-filled when done)
> **Created**: YYYY-MM-DD
```

After all execution vehicles complete, run `/done T-xxx` or reach `mission COMPLETE` to trigger
the archiving step — refine the architecture output and write it to `docs/architecture/`;
the proposal status then becomes `done`.
