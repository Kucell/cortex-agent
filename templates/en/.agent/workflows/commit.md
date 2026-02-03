---
description: Workflow for committing code
---

# Commit Workflow (/commit)

1. **Status Check**:
    - Run `git status` to see pending changes.
2. **Self-Review**:
    - Perform a final review of changes to ensure no debug code or non-compliant changes.
3. **Quality Validation**:
    - Run project-configured type checking.
    - Run relevant unit tests.
4. **Generate Commit Message**:
    - **Read Task Plan**: **MUST read** `.agent/plans/task-progress.md` to find the current `in-progress` task.
    - **Follow Standards**: Refer to `.agent/rules/commit-standards.md`.
    - **Generate Message**:
        - Determine `type` and `scope`.
        - Write `subject` in English.
        - **Automatically reference** relevant task IDs in body or footer (e.g., `[refs #123]`).

5. **Execute Commit**:
    - Verify generated message.
    - Run `git commit -m "[commit message]"` (ensure message is in English).

6. **Post-Commit**:
    - Determine if `git push` is needed.
