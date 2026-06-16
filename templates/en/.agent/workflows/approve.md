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
```

## Prerequisites

- The proposal file exists under `.agent/plans/proposals/`.
- The proposal status field is `draft` (if already `approved` or higher, a notice is shown and the command stops).
- The proposal contains a clear `Implementation Plan` or `Phase` section (used for scale assessment).

---

## Steps

### Step 1: Read and validate the proposal

1. Read the specified proposal file.
2. Confirm `> **Status**:` exists and is `draft`.
   - If already `approved` or higher: show "Proposal already approved — no action needed." and stop.
   - If the status field is missing: ask the user to add the standard status fields to the proposal header, then stop.
3. Extract proposal details:
   - Core objective (one sentence)
   - Number of Phases (count `### Phase` headings)
   - Any mention of cross-session or multi-day scope

### Step 2: Scale assessment

Apply the following rules and present a routing suggestion (user confirms; not enforced):

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

After confirmation, change the proposal header status field from `draft` to `approved`:

```markdown
> **Status**: approved
```

### Step 4: Dispatch to execution

**Route A: /plan (small task)**

Run `/plan --from-proposal <proposal-file-path>`:
- Use the proposal Phase list as task decomposition input
- Back-fill the resulting Task IDs into the proposal's `Execution Vehicle` field
- Change proposal status from `approved` to `in-progress`

**Route B: /mission (large task)**

Run `/mission create --from-proposal <proposal-file-path>`:
- Map each proposal Phase to a milestone
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
