---
name: arch-design
description: Produce implementation-ready architecture proposals and finalize exact revisions through durable approval evidence.
---

# Architecture Design Workflow (/arch-design)

Use this workflow for architecture design before substantial implementation.

## 1. Understand the Problem

Read the complete requirement and relevant repository context. Confirm goals, constraints, non-goals, affected modules, compatibility requirements, and validation expectations. Use existing project conventions and references before introducing new abstractions.

When evaluating a public GitHub project, invoke `github-repo-research`: use DeepWiki as the initial architecture map, then verify every decision-relevant claim against a pinned commit or the current source.

## 2. Design the Solution

Describe the current state, target architecture, module boundaries, data and control flows, failure modes, migration strategy, observability, security, and test approach. Record meaningful alternatives and tradeoffs.

For a large or related-project proposal, use the project proposal structure under `.agent/plans/proposals/projects/<project-slug>/`, maintain `index.md`, and split independently reviewable milestones into subproposals.

## 3. Prepare the Proposal

Write an implementation-ready proposal with status `draft`, explicit phases or milestones, acceptance criteria, risks, rollback guidance, and an execution carrier pending approval. Review the complete document with the user before finalization.

## 4. Review and Decision

Bind the exact proposal or Artifact Bus revision as:

```text
architecture:<path-or-artifact-ref>#<revision-digest>
```

Use the first 8-12 digest characters in both IDs:

```bash
cortex-agent decisions request --project . \
  --decision-id D-arch-<topic>-<revision-digest8> \
  --gate arch-design \
  --payload-json '{"type":"architecture","requested_by":"/arch-design","prompt":"Approve this exact architecture revision?","options":["approve","reject","revise"],"gate":{"action":"architecture","resource_ref":"<architecture-resource-ref>"}}'

cortex-agent waitpoints create --project . \
  --waitpoint-id WP-arch-<topic>-<revision-digest8> \
  --gate arch-design \
  --owner-workflow /arch-design \
  --reason "Architecture baseline requires explicit user approval" \
  --action architecture \
  --resource-ref "<architecture-resource-ref>" \
  --decision-id D-arch-<topic>-<revision-digest8>
```

Direct the user to `/approve decision D-arch-<topic>-<revision-digest8>` or ask for an explicit natural-language approve/reject/revise choice that the main agent routes through `/approve`. Dashboard requests, prior conversation approval, chat text without a persisted Decision, and `--gate approve` are not approval evidence.

On resume, recompute the revision. Only when the resource is unchanged and the Decision is explicitly approved may `/arch-design` release its Waitpoint:

```bash
cortex-agent waitpoints release --project . \
  --waitpoint-id WP-arch-<topic>-<revision-digest8> \
  --gate owner \
  --owner-workflow /arch-design \
  --decision-id D-arch-<topic>-<revision-digest8> \
  --released-by /arch-design \
  --release-note "Approved Decision matches the architecture revision digest"
```

Rejected or revision-requested Decisions keep the Waitpoint blocked and return the proposal to refinement.

## 5. Task Pipeline and Architecture Artifact

- **Resolve task context**: If the design belongs to an existing task, read `.agent/tasks/<task-id>.json`. Otherwise create a `draft` task record only after the scope and acceptance criteria are known, and synchronize `.agent/tasks/index.json`.
- **Append the artifact**: Store the proposal in its normal proposal path, then append an Artifact Bus entry using envelope `kind: plan` and `payload.artifact_kind: architecture`. Add the resulting path to the task as canonical `kind: architecture`, initially with `status: draft`.
- **Approval gate**: The approved Decision and released Waitpoint are required before changing the task artifact to `status: final`. Record those evidence refs without treating proposal status as implicit approval.
- **Advance deliberately**: `/arch-design` may pass `draft -> spec` when the task contract is complete. It must not pass `spec -> plan`; `/plan` owns that gate and must verify the final architecture artifact when `architecture_required = true`.
- **Handle revision**: A rejected or replaced design remains referenced as `superseded`. Do not delete or overwrite prior artifacts, regress the task stage, or advance a blocked gate.

## 6. Handoff

The final architecture artifact references the resolved Decision and released Waitpoint. Then route the proposal through Proposal mode in `/approve` for `/plan` or `/mission` scheduling. Architecture approval does not itself approve execution consequences.

## Safety Boundary

- Architecture uses `type=architecture` and `action=architecture` for the exact revision digest.
- Destructive changes, credentials, and external side effects require separate resource-bound Decisions/Waitpoints consumed by their owning workflows.
- Never infer approval or automatically run `reset`, `revert`, `push`, `deploy`, or publish.
- Project-level Checkpoint integration is only a future route pending approval; report that route without naming or invoking an uninstalled workflow.
