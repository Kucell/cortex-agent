---
name: done
description: Quickly mark tasks as complete and update the progress percentage in task-progress.md.
---

# Task Completion Workflow (/done)

Use this to mark one or more tasks as complete and sync the progress document.

## Usage

```
/done T-001
/done T-001 T-002
/done T-001 T-002 --progress 95
```

## Steps

### Step 1: Read Current Progress

Read `.agent/plans/task-progress.md` and locate the specified task IDs.

### Step 2: Update Task Status

- Remove completed tasks from the **Active Tasks** table.
- Change `[ ]` to `[x]` in the **Roadmap** section.
- Append a summary of completed tasks to the **Recently Completed** block:

```
- <task description> (completed YYYY-MM-DD)
```

### Step 3: Recalculate Overall Progress

Re-estimate the `Overall Progress` percentage based on completed items in the roadmap:
- If the user specified `--progress <value>`, use that value directly.
- Otherwise estimate: `completed items / total items × 100%`

Update the `> **Overall Progress**` and `> **Last Updated**` fields at the top of the file.

### Step 4: Output Confirmation

Display an update summary:

```
✅ Marked complete: T-001 (Enhance pre-commit-check.sh multi-language support)
📊 Overall progress: 82% → 87%
📅 Last updated: 2026-03-19
```

Then ask if the user wants to `/commit` the updated progress file.
