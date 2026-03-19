---
name: ship
description: One-command task delivery: code review → commit → mark done → sync plans. Chains /code-review + /commit + /done + /sync-plans into a single flow.
---

# Task Delivery Workflow (/ship)

After completing coding for a task, run this workflow to close the delivery loop.

## Usage

```
/ship T-001
/ship T-001 T-002        (deliver multiple tasks at once)
/ship T-001 --no-review  (skip code review, commit directly)
```

## Steps

### Step 1: Load Task Context

Read `.agent/plans/task-progress.md` and locate the specified task ID:
- Confirm task description and acceptance criteria
- Check for incomplete dependency tasks (prompt user to confirm if any exist)

### Step 2: Code Review (skippable)

Unless `--no-review` is specified, automatically trigger a code review:

```bash
git diff HEAD        # Review all uncommitted changes
git diff --staged    # Prefer staged changes if present
```

Focus on:
- Whether acceptance criteria are met
- Compliance with `.agent/rules/code-standards.md`
- Missing edge case handling or tests

If issues are found, list them and ask: **fix now, or deliver and track as a new task?**

### Step 3: Commit Code

Invoke the `/commit` workflow:
- AI analyzes changes and generates a Conventional Commits message
- Show to user for confirmation, then execute `git commit`
- Follows `.agent/rules/commit-standards.md` (no AI attribution)

### Step 4: Mark Task Complete

Invoke `/done <task-id>` logic:
- Roadmap `[ ]` → `[x]`
- Remove from active tasks table
- Append to "Recently Completed"
- Recalculate overall progress percentage

### Step 5: Sync Related Tasks

Check `.agent/plans/task-progress.md` for tasks depending on the completed one:
- If found, update their status from "blocked" to "ready"
- If parallel tasks are affected, notify the user

### Step 6: Delivery Report

Output a summary:

```
🚢 Delivered: T-001 (Implement JWT token generation and validation)

  ✅ Code reviewed
  ✅ Committed: abc1234 feat(auth): implement JWT token generation
  ✅ Task marked complete
  📊 Overall progress: 72% → 78%

  🔓 Unlocked: T-007 (Implement login endpoint /auth/login)
  📌 Suggested next step: /start-task T-007
```

---

## 💡 Use Cases

| Scenario | Command |
|----------|---------|
| Normal task completion | `/ship T-001` |
| Quick commit, skip review | `/ship T-001 --no-review` |
| Deliver multiple small tasks | `/ship T-001 T-002 T-003` |
| Only commit, don't update plan | `/commit` (use commit workflow directly) |
