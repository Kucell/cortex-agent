---
description: Governed Agent L1 composition workflow for read-only preflight, owner-bound launch gates, and settlement evidence.
---

# Governed Agent Orchestration (`/agent-orchestration`)

This L1 workflow composes existing `/start-task`, `/plan`, `/mission`, `/parallel`, `/worktree`, `/dispatch`, and `/launch-governed-agent` owners. It produces only a read-only `OrchestrationPlan` and `AttemptSettlement` summary. It must not become a second owner of Task, Lease, Operation, Run, Decision, Waitpoint, or host state.

## Scope

- Use only for governed multi-host launch, recovery, or settlement; single-session work keeps its existing entry.
- L1 defines evidence, ownership, and fail-closed order only. Model, provider, operating-system, package-manager, absolute-path, and branch-policy details are L2 and must not appear here.
- This workflow must not create a worktree, Task, Lease, Queue, Run, or child process. Existing owners perform writes through their public commands.

## Read-only OrchestrationPlan

`--dry-run` returns an `OrchestrationPlan` containing `taskId`, entry, `ownedFiles`, resources, dependencies, host requirements, Decision/Waitpoint gates, result, and blockers. Every blocker names its owning workflow and a safe next action.

If `result=blocked`, stop. Do not bypass through an independent process, handwritten runtime state, or an alternative Lease.

## Launch readiness gate

Call the existing `/launch-governed-agent` owner only after all gates pass in order:

1. The exact resource-bound Decision is approved and its Waitpoint is released.
2. After Task create, a new CLI process reads the same Task through both `task status` and `task list`; failed cross-process readback must not acquire a Lease or launch.
3. The existing Lease owner confirms `task:<id>`, fencing token, worktree identity, and `ownedFiles` match.
4. The existing `/dispatch dry-run` reports no idempotency, lock, Lease, capability, or isolation conflict.
5. The existing host capability owner provides evidence for acceptance and terminal receipts.

This workflow does not create a Task or Lease and does not interpret or modify their runtime namespace.

## AttemptSettlement gate

`assigned` means coordination assigned work; it does not mean a host ran. The existing projection owner may report `settled` only with all of these evidence classes:

| Stage | Required evidence | Owner |
| :--- | :--- | :--- |
| accepted | `task.accepted` and host receipt | launch / host adapter |
| progressing | active, productive, verified evidence, or explicit blocked state | supervision / task owner |
| validating | validation receipt and independent validation result | validator |
| settled | `agent_settled` or structured failed/cancelled receipt, with Task, Lease, and Operation reconciliation | host monitor / coordination owner |

Without the settlement evidence, `assigned`, a worktree-only diff, or `FAILED` with a live Lease must be `unsettled`. The orchestrator only reports owner, expiry, and an allowed recovery path. It must not automatically release, retry, take over, clean, commit, or launch.

## Validation

Validators independently inspect the diff, run contract commands, and read owner projections. Worker claims, process start, and worktree changes are not settlement proof. A downstream pilot that starts a host or affects another project requires a new exact Decision and Waitpoint.
