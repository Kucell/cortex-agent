---
description: Procedures for starting a new development task
globs: *
---
# Workflow: Start Task (/start-task)

When the user triggers `/start-task`:

1. **Context Check**: Read `.cursor/plans/task-progress.md` (if exists) or `.agent/plans/task-progress.md`.
2. **Analysis**:
   - Understand the requirements.
   - Check against `101-architecture.mdc`.
3. **Plan**:
   - Create a implementation plan.
   - Propose file changes.
4. **Environment**:
   - Verify local environment state.
