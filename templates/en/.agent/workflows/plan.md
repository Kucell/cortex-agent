---
name: plan
description: Convert a confirmed proposal or requirement into a structured task list and write it into task-progress.md, bridging /arch-design and /start-task.
---

# Plan Breakdown Workflow (/plan)

After confirming a design proposal or requirement with AI, run this workflow to convert it into an executable task plan.

## Usage

```
/plan
/plan "implement user login"
/plan --from-proposal <proposal-path>   (read a standalone proposal, project index.md, or child proposal — recommended)
/plan --from arch-proposal              (read blank template — deprecated)
```

## Steps

### Step 1: Load Context

Read these files in order (if they exist):

1. `.agent/plans/task-progress.md` — understand current progress and existing task IDs
2. If `--from-proposal <path>`: read the specified proposal file
   - Standalone or project child proposal: read that file; for a child proposal, also read its project's `index.md`
   - Project-level `index.md`: read the entry first, then the child proposals associated with the approved scope and milestone; do not expand unapproved child proposals by default
3. If `--from arch-proposal` (deprecated): read `.agent/resources/templates/arch-proposal.md`
4. `.agent/rules/architecture-design.md` — confirm architectural constraints
5. `.agent/rules/task-decomposition.md` — decide task size, dependencies, and parallel opportunities
6. `.agent/resources/templates/task-breakdown.md` — use as the preview format

If the user described requirements directly (no proposal file), decompose based on conversation context.

### Step 2: Task Decomposition

Break the proposal into independent, verifiable task units. Each task must include:

- **Task ID**: Increment from the current highest ID (e.g. if max is T-005, new tasks start at T-006)
- **Priority**: P0 (blocking) / P1 (core) / P2 (enhancement) / P3 (optional)
- **Description**: One sentence describing what to do
- **Acceptance Criteria**: At least 1 verifiable done condition
- **Dependencies**: Whether it depends on other tasks completing first
- **Parallel Judgment**: Whether it can run in the same batch as other tasks, and why
- **Recommended Agent**: planner / researcher / implementer / code-reviewer / documenter / coordinator
- **Proposal Source**: For project-level input, retain the `index.md`, milestone, and child proposal IDs so tasks remain traceable to the approved scope

If the requirement is suitable for multi-agent collaboration, first output the breakdown using `.agent/resources/templates/task-breakdown.md`, then ask whether to write it to the plan.

Show the decomposition for user confirmation:

```
📋 Task breakdown preview (N tasks):

T-006  [P1]  Implement JWT token generation and validation
       AC: POST /auth/token returns valid JWT; unit tests pass

T-007  [P1]  Implement login endpoint /auth/login
       AC: Returns token on valid credentials; 401 on invalid
       Depends on: T-006

T-008  [P2]  Add login rate limiting (5 req/min)
       AC: 6th request within 1 min returns 429

---
Write these tasks to the plan? (y / adjust / cancel)
```

### Step 3: Write to task-progress.md

After user confirmation:

1. Add a new Phase in the **Roadmap** (if it's a new feature module) or append to an existing Phase
2. Append new task rows to the **Active Tasks** table (default progress: 0%); if from a proposal, each row includes `Proposal: <path>`; for a project entry, also record the milestone and child proposal ID
3. Update the `Last Updated` date in the file header

### Step 4: Back-fill the proposal (if --from-proposal was used)

If this `/plan` was dispatched by `/approve` (or the user passed `--from-proposal` directly), update only the approved scope:

- Standalone or child proposal: back-fill its header with the execution vehicle and status; for a child proposal, also update its row in `index.md`
- Entire project or milestone: back-fill the corresponding scope in `index.md` without changing child proposals outside that scope

```markdown
> **Status**: in-progress
> **Execution Vehicle**: T-006~T-008
```

### Step 5: Output Action Suggestion

```
✅ Written 3 tasks (T-006 ~ T-008)
🔗 Proposal execution vehicle back-filled: T-006~T-008
📌 Suggested next step: /start-task T-006
```
