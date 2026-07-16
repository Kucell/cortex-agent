# Task Decomposition and Multi-Agent Collaboration Rules

When the user gives a large requirement, project-level goal, or ambiguous idea, AI must first decide whether the work should be decomposed instead of jumping straight into implementation.

## 1. Entry Selection

Choose the workflow in this order:

| Scenario | Recommended entry |
| :--- | :--- |
| Architecture is unclear or there are multiple viable approaches | `/arch-design` |
| Requirement is clear but too large for one task | `/plan` |
| Work spans multiple milestones, days, or resumptions | `/mission` |
| Multiple independent tasks already exist | `/parallel` |
| One small, clear task | `/start-task` |
| Implementation is done and needs closure | `/ship` |

If the user gives only a large goal, such as "implement memberships", "refactor the editor", or "integrate OpenPencil PRD capability", AI should first output its decomposition judgment and then choose the entry.

## 2. Decomposition Principles

- Each task must fit in one isolated context.
- Each task must have clear inputs, outputs, and acceptance criteria.
- Prefer splitting by module boundary, API boundary, data-flow phase, and risk level.
- Architecture decisions, data models, public interfaces, and migration plans should come before UI or business implementation.
- Tests, validation, and docs publishing must not be omitted; make them explicit tasks or acceptance criteria.
- A task should be small enough to complete through one `/start-task` to `/ship` loop; split further if needed.

## 3. Parallelization Judgment

Tasks may run in parallel when:

- They edit different modules or directories and have no shared write targets.
- Read-only research, validation, or documentation can run alongside implementation.
- The upstream interface contract is already clear and multiple workers only consume it.
- Each task has isolated context and independent acceptance criteria.

Tasks are serial by default when:

- They edit the same file, config, database migration, or shared type.
- One task depends on another task's code output, API signature, or data structure.
- The architecture decision is not confirmed.
- They need the same exclusive runtime resource, such as a device, remote machine, or migration window.
- Failure would affect several downstream P0/P1 foundations.

## 4. Sub-Agent Roles

| Task type | Recommended agent |
| :--- | :--- |
| Requirement clarification, breakdown, dependency graph | `planner` |
| Research, library evaluation, unfamiliar code exploration | `researcher` |
| Implementation, tests, fixes | `implementer` |
| Architecture, quality, security review | `code-reviewer` |
| Docs, release notes, developer guides | `documenter` |
| Long-running orchestration, resume, milestone state | `coordinator` |

The main agent owns orchestration: task boundaries, context packages, result collection, conflict handling, and unified `/ship`.

## 5. Required Breakdown Output

Use `.agent/resources/templates/task-breakdown.md` for the preview. Each task must include:

- Task ID
- Priority
- Goal
- Modules / file scope
- Input context
- Expected output
- Acceptance criteria
- Dependencies
- Parallelizable or not
- Recommended agent
- Risks and blocking conditions

## 6. Conflicts and Closure

- Before parallel execution, list batches and the reason for each batch.
- After parallel execution, check file conflicts, interface drift, and duplicate implementation.
- Sub-agent output is not automatically done; close through `/ship` or the relevant validation workflow.
- If the task creates new project knowledge, run `/update-refs`; if developer docs are affected, run `/publish-docs`.
