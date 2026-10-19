---
name: agent-team
description: Turn the current goal into verifiable agent work batches, using existing workflows for preflight, delegation, and independent validation.
type: procedure
applicable_to:
  - all
owner: Cortex Agent Runtime / Workflow
status: draft
last_verified: 2026-10-16
---

# Multi-agent task entry (`/agent-team`)

`/agent-team` is a user-facing routing workflow, not a new CLI scheduler or runtime
owner. It selects existing `/start-task`, `/plan`, `/mission`, and `/parallel`
workflows. For governed cross-host launches, `/agent-orchestration` checks launch
and settlement evidence. The existing owners still manage Tasks, Leases,
Operations, Runs, Decisions, Waitpoints, worktrees, and host processes.

This L1 workflow defines only the shared sequence. The current project's L2/L3
rules and verified capabilities determine models, providers, host arguments,
branch names, package managers, devices, and absolute paths.

## Input and routing

Accept a task description, proposal path, Task ID, or handoff. With no argument,
recover the single identifiable goal from the conversation and project state.
Read the project's `AGENTS.md`, active task plan, and relevant Proposal, Mission,
Decision, Waitpoint, and handoff. If the goal is ambiguous or candidates conflict,
report the candidates and missing information without choosing one arbitrarily.

1. Draft requirement or shared contract: use `/arch-design` or `/plan` for review
   and decomposition.
2. One approved, scoped task: use `/start-task`.
3. Independent tasks: batch them under `task-decomposition`, then use `/parallel`.
4. Multiple stages or sessions: use `/mission`; resume from the authoritative
   handoff and owner state.
5. Rule, workflow, or skill maintenance: use `/agent-update` and check layer and
   template ownership first.

Execution authority follows the user's current authorization, existing
Decision/Waitpoint gates, and the selected workflow. With `--dry-run`, output
only the preflight and batches; create no Task, Lease, worktree, Run, or process.

## Work packages and parallel preflight

For each task, state its goal, acceptance assertions, dependencies, `ownedFiles`,
excluded files, shared resources, validation commands, recommended host, and
evidence of host capability. Check file and contract overlap, runtime resources,
and existing Tasks, Leases, Locks, and worktrees. Serialize overlapping ownership
or an unfrozen shared contract.

For sub-agents available directly in the current host, follow `/parallel` for
isolation and acceptance; do not present them as Cortex-governed runs. For
governed cross-host work, run the read-only `/agent-orchestration`
`OrchestrationPlan` preflight. Name each blocker's owner and safe next step.
If that workflow is missing or `result=blocked`, stop the governed launch;
do not bypass it with a bare process or hand-written runtime state.

## Model selection

Choose models only from what the current host actually offers; never from
preference. Probe before selecting, then select.

1. Read `.agent/config/reasoning-config.yml` for the provider, model aliases
   (`fast` / `standard` / `premium`), and role assignments.
2. Read the models the current host actually exposes. For Codex and Claude Code
   that is the set provided by the running session. Do not infer it from the
   configuration, and do not copy model IDs from another project.
3. Follow the existing role bindings in `.agent/sub-agents/*.md`. When those
   bindings conflict with `reasoning-config.yml`, resolve the conflict by this
   section rather than silently preferring one.

Selection rules:

- When an alias does not resolve to a host-available model (for example the
  configuration names `claude-sonnet-4-6` while the host offers `gpt-5`), do
  not use that ID. Mark it `unverified` and report the available models plus a
  suggested mapping in the first output, then wait for the user's confirmation.
- When a project configuration names a retired model ID the host no longer
  provides, point at the exact entry. Do not silently substitute another model.
- With no available-model evidence, stop before selection and report the gap.
  Do not fall back to a default model.

Record the choice in each work package: `model` (the real model ID, not an
alias), `model_evidence` (where the probe came from), and an `unverified` flag
when applicable. A task whose model is unavailable is `blocked`; it must not
degrade into execution on a default model.

## Launch and supervision

For a governed cross-host launch, the existing owners must confirm matching
Decision/Waitpoint, a Task readable from another process, Lease and fencing
token, worktree identity, `ownedFiles`, `/dispatch dry-run`, and host capability
before handing off to an owner workflow that actually supports launch.
`/dispatch` currently performs governed dispatch; it does not prove a host
process started. Obtain the actual launch and receipt from the selected host's
public capability. Read-only research and current-session work follow their
own workflows and must not fabricate a governed Task.

The lead agent collects real progress, failures, and terminal receipts, then
independently reviews the diff, file ownership, validation commands, and
`AttemptSettlement`. Process exit, worker claims, or a worktree diff alone do
not establish completion. On failed acceptance, the original owner defines
the follow-up; do not bypass the owner to retry, take over, or release a Lease.
Commit, push, PR creation, merge, and worktree cleanup follow user authorization
and their respective workflows.

## First output

Report the goal, selected entry, dependency batches, each task's owner, host
capability status, isolation, chosen model with its probe source, gates, and
blockers. Mark unverified fields as "unverified". When a model alias does not
resolve to a host-available model, report the available models and a suggested
mapping and wait for the user's confirmation before continuing. Continue with
owner workflows only when prerequisites hold.
At settlement, distinguish `assigned`, `running`, `ready_for_review`,
`settled`, and `blocked`, citing reviewable evidence.

## Related workflows

- Decomposition and parallel work: `/plan`, `/parallel`, `.agent/rules/task-decomposition.md`
- Instruction maintenance: `/agent-update`
- Long tasks and isolation: `/mission`, `/worktree`, `/handoff`
- Governed preflight and launch: `/agent-orchestration`, `/dispatch`, the actual host launch workflow
- Independent validation and delivery: `/agent-supervise`, `/ship`
