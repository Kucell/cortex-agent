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
/plan --from arch-proposal   (load proposal from .agent/resources/templates/arch-proposal.md)
```

## Steps

### Step 1: Load Context

Read these files in order (if they exist):

1. `.agent/plans/task-progress.md` — understand current progress and existing task IDs
2. `.agent/resources/templates/arch-proposal.md` — if `--from arch-proposal`, load the proposal
3. `.agent/rules/architecture-design.md` — confirm architectural constraints

If the user described requirements directly (no proposal file), decompose based on conversation context.

### Step 2: Task Decomposition

Break the proposal into independent, verifiable task units. Each task must include:

- **Task ID**: Increment from the current highest ID (e.g. if max is T-005, new tasks start at T-006)
- **Priority**: P0 (blocking) / P1 (core) / P2 (enhancement) / P3 (optional)
- **Description**: One sentence describing what to do
- **Acceptance Criteria**: At least 1 verifiable done condition
- **Dependencies**: Whether it depends on other tasks completing first

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
2. Append new task rows to the **Active Tasks** table (default progress: 0%)
3. Update the `Last Updated` date in the file header

### Step 4: Output Action Suggestion

```
✅ Written 3 tasks (T-006 ~ T-008)
📌 Suggested next step: /start-task T-006
```
