---
description: Used for plan alignment, progress synchronization, and conflict detection during multi-task parallel development.
---

# Plan Synchronization and Alignment Workflow (/sync-plans)

When multiple tasks are running in parallel or you need to synchronize overall progress, follow this process:

## 1. Global State Scanning

- **Read Master Table**: Thoroughly read `.agent/plans/task-progress.md` to understand the current Roadmap phase and P0 tasks.
- **Sub-plan Detection**: Scan active task files in the `.agent/plans/` directory and extract their latest progress using `view_file`.

## 2. Parallel Task Analysis

- **Call Dependency Analysis Skill**: **Call the `dependency-analysis` skill** to perform the following analysis:
  - **Conflict Detection**: Check if different tasks are modifying the same set of source files.
  - **Interface Dependencies**: Check if multiple solutions share unimplemented low-level interfaces.
  - **Dependency Alignment**: Identify "Blockers" between tasks.
  - **Duplicate Work Identification**: Determine if two tasks are implementing similar functionalities.

## 3. Architectural Design Correlation

- **Design Change Sync**: If `/arch-design` was recently executed, check if those architectural changes have been reflected in all active task plans.
- **Audit Feedback Integration**: Convert issues found during architectural audits into TODO items in the plans.

## 4. Comprehensive Alignment and Update

// turbo

- **Update `task-progress.md`**: Reflect the latest percentage progress, completed items, and current highest priority tasks.
- **Update Sub-plans**: Ensure the "Context" or "Next Steps" of each active plan file are up-to-date and do not conflict with other tasks.

## 5. Output Alignment Report

- Produce a concise alignment summary:
  - **Active Task Status**: [List of Task Status]
  - **Risk Alerts**: [List of Conflicts/Blockers]
  - **Today's Recommended Actions**: [Most critical items to handle]
