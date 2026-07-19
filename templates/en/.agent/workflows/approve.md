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

## Natural-Language Entry

The user does not need to type a slash command. When the current interaction contains an explicit, unconditional choice, the main agent must route it into Decision mode and persist it instead of treating chat text itself as approval evidence.

- Explicit approval: `approve`, `approved`, `yes, approve`, `批准`, `同意`, or `批准并继续`.
- Explicit rejection: `reject`, `do not approve`, `拒绝`, or `不同意`.
- Explicit revision request: `revise`, `needs changes`, `需要修改`, or `退回修改`.
- Not a choice: `looks good`, `maybe`, `seems fine`, `let's see`, silence, reactions, or prior preferences.

Routing constraints:

1. If the user names a Decision ID, resolve that ID only.
2. Without an ID, resolve only when the current prompt presented exactly one Decision or exactly one open Decision is attached to the current blocking Waitpoint.
3. If multiple candidates exist, the choice is conditional, the resource drifted, or the meaning is ambiguous, show the IDs, actions, and resources and ask for an explicit choice. Never guess.
4. Store the original choice or a faithful summary as the non-empty `rationale`; use `interactive-user` or a stable platform user identifier as `resolved-by`.
5. After resolution, return control to the Decision's owning workflow. The owner recomputes the resource, validates the Decision, releases its own Waitpoint, and may automatically continue ordinary steps inside the approved scope.
6. Pause again for every new architecture, merge, destructive, credential, or external-side-effect Decision. One approval never authorizes a later resource.

## Decision Mode

1. Query and read the target Decision without mutating it:

   ```bash
   node .agent/skills/management-api/scripts/index.js query decisions
   ```

2. Verify `.agent/decisions/D-<id>.json` exists and has `status=open`.
3. Show the user its `prompt`, every option, `gate.action`, `gate.resource_ref`, requesting workflow, and related blocking Waitpoint.
4. Require an explicit `approve`, `reject`, or `revise` choice through the slash command or a phrase accepted by Natural-Language Entry in the current interaction.
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
