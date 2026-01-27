---
name: architecture-audit
description: Audits the project's architecture against predefined rules. Use to ensure code changes align with the established architectural design.
context: fork
agent: code-reviewer
---
# Architecture Audit Skill

## Goal
This skill is designed to analyze the project's codebase and identify potential deviations from the established architectural principles defined in `.agent/rules/architecture-design.md`.

## When to Use
Activate this skill when:
- You are about to implement a new feature and need to understand its architectural impact.
- You are performing a code review and want to check for architectural consistency.
- You are refactoring a core part of the application.

## How to Use
This skill includes an executable script to automate the audit process.

1.  **Understand the Goal**: Your primary goal is to run the audit and interpret its results for the user.
2.  **Execute the Script**: Use the `run_shell_command` tool to execute the audit script located at `.agent/skills/architecture-audit/scripts/index.js`. It's a Node.js script.
    ```bash
    node .agent/skills/architecture-audit/scripts/index.js
    ```
3.  **Analyze Output**: The script will output a list of potential architectural violations.
4.  **Report to User**: Present the findings to the user in a clear, structured format. For each violation, explain why it might be a problem and suggest potential solutions.
