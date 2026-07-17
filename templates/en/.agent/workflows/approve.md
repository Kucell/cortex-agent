---
name: approve
description: Approve and schedule architecture proposals, or resolve a resource-bound Decision after an explicit user choice.
---

# Proposal Approval, Scheduling, and Decision Resolution (/approve)

This workflow has two mutually exclusive modes:

- **Proposal mode** advances a reviewed architecture proposal from `draft` into `/plan` or `/mission` execution.
- **Decision mode** records an explicit user choice for one resource-bound Decision. It never performs the protected action or releases a Waitpoint.

## Usage

```text
/approve <proposal-path>
/approve .agent/plans/proposals/example-proposal.md
/approve .agent/plans/proposals/projects/<project-slug>/index.md
/approve decision D-<id> --choice approve|reject|revise
```

Input beginning with `decision` selects Decision mode. All other input selects Proposal mode. Never infer approval from a Dashboard action, message, prior preference, silence, or a caller-provided `--gate approve` string.

## Decision Mode

1. Query and read the target Decision without mutating it:

   ```bash
   node .agent/skills/management-api/scripts/index.js query decisions
   ```

2. Verify `.agent/decisions/D-<id>.json` exists and has `status=open`.
3. Show the user its `prompt`, every option, `gate.action`, `gate.resource_ref`, requesting workflow, and related blocking Waitpoint.
4. Require an explicit `approve`, `reject`, or `revise` choice in the current interaction.
5. Map the choice to `approved/approve`, `rejected/reject`, or `revision_requested/revise`, collect a user identity and non-empty rationale, then run:

   ```bash
   node .agent/skills/management-api/scripts/index.js decisions resolve \
     --decision-id D-<id> \
     --gate user \
     --status <approved|rejected|revision_requested> \
     --selected-option <approve|reject|revise> \
     --resolved-by <user-id> \
     --rationale "<user rationale>"
   ```

6. Read the Decision again and report the result. `/approve` must not call `waitpoints release` or perform merge, release, destructive, credential, or external-side-effect operations. The owning workflow must validate the exact action and resource before consuming the approval.

## Proposal Mode

### Preconditions

- The input is a proposal, project `index.md`, or project subproposal under `.agent/plans/proposals/`.
- The selected scope is `draft` and contains implementation phases or milestones.
- Architecture proposals carrying a Decision/Waitpoint must already have an explicitly approved `action=architecture` Decision and a Waitpoint released by `/arch-design`. Scheduling confirmation is not a substitute.

### Procedure

1. Read the complete proposal scope. For project proposals, read the index and the selected milestone's subproposals. Never approve an entire project by default.
2. Extract the objective, phase count, milestone mapping, and cross-session indicators.
3. Recommend `/plan` for at most two phases without cross-session work; recommend `/mission` for three or more phases, multi-day work, or milestone validation. Let the user override the recommendation.
4. After confirmation, update only the selected scope from `draft` to `approved`.
5. Dispatch exactly one path:
   - `/plan --from-proposal <path>` and record the Task IDs, or
   - `/mission create --from-proposal <path>` and record the Mission ID.
6. Change the dispatched scope to `in-progress`, maintain links in the project index, and report the next command.

Standard lifecycle:

```text
draft -> approved -> in-progress -> done | superseded
```

## Safety Boundary

- A Decision Gate is valid only for its exact `gate.action` and `gate.resource_ref`; an ID or `--gate approve` string is not authorization.
- `architecture`, `destructive`, `credential`, and `external_side_effect` operations require Decisions and Waitpoints created by the owning workflow.
- Architecture approval never grants destructive or external-side-effect permission.
- Never automatically run `reset`, `revert`, `push`, `deploy`, or another external side effect.
