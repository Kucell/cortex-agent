---
description: Used to propose, evaluate, and integrate new architectural ideas or solutions during the development process.
---

# Architectural Evolution and Design Workflow (/arch-design)

When you have new architectural ideas or need to refactor existing modules, follow this process to ensure design rigor and consistency:

## 1. Solution Conception and Current State Analysis

- **Read Core Principles**: **You must first read** the `.agent/rules/architecture-design.md` file, treating the core principles of the project architecture as the highest priority.
- **Read Proposal Structure**: **You must also read** `.agent/rules/proposal-structure.md` before deciding where the proposal should be stored.
- **Understand Context**: Deeply explore the requirements proposed by the user or the technical bottlenecks encountered by the existing system.
- **Research referenced repositories**: When a candidate design references a public GitHub repository, invoke `github-repo-research`. Use DeepWiki to locate architecture and implementation evidence, then verify decisions against the repository source before comparing solutions.
- **Read PRD Assets First**: If `.agent/prd/` or `.agent/prds/` contains a PRD in `review`, `approved`, or `designed` status, read its `state.json`, `prd.md`, `flows.md`, `screens.md`, and `acceptance-criteria.md` before writing architecture proposals.
- **Current State Review**: Search for relevant implementation logic in the current codebase.
- **Conflict Detection**: Analyze whether the new solution conflicts with the loaded architectural principles.

## 2. Design Output

- **Determine proposal scope and path**: Before writing the file, decide whether this is a standalone proposal or a project-level proposal group.

  Standalone proposal:
  ```
  .agent/plans/proposals/<topic>/<short-name>-proposal.md
  ```
  - `topic` is the core module or business domain in kebab-case (e.g. `auth`, `device-template`, `state-management`)
  - Reuse an existing subfolder if one matches; create a new one if not

  Project-level proposal group:
  ```
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<short-name>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - Use a project folder when the proposal spans multiple phases, multiple workflows/skills/CLI capabilities, multiple real projects, or multiple related sub-proposals.
  - Create or update `index.md` using `.agent/resources/templates/proposal-project-index.md`.
  - Record related projects and dependencies in `relations.md`.
  - **Never place a proposal directly under `.agent/plans/proposals/`**

- **Write Proposal**: Provide clear design descriptions, recommended to include:
  - Description of structural changes.
  - Core flowcharts or class diagrams (Mermaid).
  - API change list.
  - Impact on existing data flows.

## 3. Architectural Comparison and Evaluation

- **Call Audit Skill**: Use the `.agent/skills/architecture-audit` skill to audit the new proposal.
- **In-depth Comparison**: Produce a solution comparison table, comparing the Status Quo with the Proposal across these dimensions:
  - Architectural compliance
  - Scalability and maintenance cost
  - Runtime performance and system complexity
  - Implementation difficulty and migration cost
- **Risk Identification**: Clearly point out potential side effects introduced by the new solution (e.g., breaking backward compatibility, increasing system overhead).

## 4. Review and Decision

- **Present Conclusions**: Show the comparison analysis results to the user and provide the AI's recommendation.
- **Create durable approval records**: Before finalizing an architecture baseline, bind the exact proposal or Artifact Bus revision as `architecture:<path-or-artifact-ref>#<revision-digest>`. Use the first 8-12 digest characters in both IDs so a revised proposal creates new records instead of colliding with a terminal Decision:

  ```bash
  node .agent/skills/management-api/scripts/index.js decisions request \
    --decision-id D-arch-<topic>-<revision-digest8> \
    --gate arch-design \
    --type architecture \
    --requested-by architecture-coordinator \
    --prompt "Approve this exact architecture revision?" \
    --action architecture \
    --resource-ref "<architecture-resource-ref>"

  node .agent/skills/management-api/scripts/index.js waitpoints create \
    --waitpoint-id WP-arch-<topic>-<revision-digest8> \
    --gate arch-design \
    --owner-workflow /arch-design \
    --reason "Architecture baseline cannot change without an explicit user choice" \
    --action architecture \
    --resource-ref "<architecture-resource-ref>" \
    --decision-id D-arch-<topic>-<revision-digest8>
  ```

- **Wait for explicit choice**: Direct the user to `/approve decision D-arch-<topic>-<revision-digest8>` or ask for an explicit natural-language approve/reject/revise choice that the main Agent routes through `/approve`. Dashboard requests, prior conversation approval, chat text without a persisted Decision, and `--gate approve` are not approval evidence.
- **Consume only a matching approval**: Recompute the proposal/artifact revision. If it is unchanged and the Decision is explicitly approved, `/arch-design` releases its own Waitpoint:

  ```bash
  node .agent/skills/management-api/scripts/index.js waitpoints release \
    --waitpoint-id WP-arch-<topic>-<revision-digest8> \
    --gate owner \
    --owner-workflow /arch-design \
    --decision-id D-arch-<topic>-<revision-digest8> \
    --released-by architecture-coordinator
  ```

- **Handle risk and effects separately**: Architecture approval uses `type=architecture` and `action=architecture`; it is not destructive approval. Replacing files, removing compatibility, credentials, and external side effects require separate Decisions with their own actions and resource digests. Rejected or revision-requested Decisions keep the Waitpoint blocked and return the proposal to refinement.

## 5. Task Pipeline And Architecture Artifact

- **Resolve task context**: If the design belongs to an existing task, read `.agent/tasks/<task-id>.json`. Otherwise create a `draft` task record only after the scope and acceptance criteria are known, and synchronize `.agent/tasks/index.json`.
- **Append the artifact**: Store the proposal in its normal proposal path, then append an Artifact Bus entry using envelope `kind: plan` and `payload.artifact_kind: architecture`. Add the resulting path to the task as canonical `kind: architecture`, initially with `status: draft`.
- **Approval gate**: User confirmation is required before changing the task artifact to `status: final`. Record the approval evidence in the artifact summary or refs; do not change proposal status as an implicit side effect.
- **Approval evidence**: The final artifact must reference the resolved Decision and released Waitpoint. A chat acknowledgement alone is not sufficient.
- **Advance deliberately**: `/arch-design` may pass `draft -> spec` when the task contract is complete. It must not pass `spec -> plan`; `/plan` owns that gate and must verify the final architecture artifact when `architecture_required = true`.
- **Handle revision**: A rejected or replaced design remains referenced as `superseded`. Do not delete or overwrite prior artifacts, regress the task stage, or advance a blocked gate.

## 6. Integration and Implementation

- **Update Documentation**: Archive approved designs to the project's documentation library (e.g., `docs/architecture/`).
- **Publish Developer Docs**: If the approved proposal changes developer-facing architecture, run `/publish-docs --architecture` after the proposal is finalized so `docs/` receives a sanitized, standalone version.
- **Task Decomposition**: Convert the design solution into a specific task list and update the implementation plans under `.agent/plans/`.
- **PRD Traceability**: When the proposal implements or changes a PRD, record the PRD id and related tasks in the proposal frontmatter or first section.

## 7. Safety Boundary

- Do not automatically reset, revert, push, deploy, publish, access credentials, or perform external side effects.
- Every destructive, credential, or external-side-effect action requires its own resource-bound Decision/Waitpoint and must be consumed by the workflow that owns that action.
- Project-level Checkpoint integration remains a future route pending approval. Do not reference or invoke a workflow that is not installed and approved.
