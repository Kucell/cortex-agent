---
name: bug-fix
description: Workflow for fixing bugs and handling errors.
---

# Bug Fix Workflow (/bug-fix)

1.  **Bug Confirmation & Triage**:
    -   **Categorize**: Type error, runtime error, logic error, or architectural issue.
    -   **Context Gathering**: Read the error stack, use code search (grep/rg) to locate relevant code blocks.
2.  **Root Cause Analysis**:
    -   Trace data flow or control flow to find the source of the error.
    -   Use the `code-evaluation` skill to assess for lifecycle, timing, or responsibility issues.
    -   Check for violations of the project's defined `architecture-design.md` rules.
3.  **Reproduction & Testing**:
    -   **Automated Reproduction**: Prioritize writing a failing test case that triggers the bug.
    -   **Manual Reproduction**: Replicate the issue in a local environment to observe side effects.
4.  **Fix Implementation**:
    -   **Find the Best Fix Location**: Prefer fixing systemic issues at a common level rather than patching leaf nodes.
    -   **Code with Standards**: Ensure type safety, add necessary robustness checks, and follow `.agent/rules/code-standards.md`.
5.  **Verification**:
    -   Run the specific test case for the bug to ensure it passes.
    -   Run the full test suite and type checker to ensure no regressions were introduced.
6.  **Summary & Prevention**:
    -   Confirm that a regression test is included in the commit.
    -   If the bug revealed a common problem, consider updating a relevant Rule or document to prevent recurrence.
