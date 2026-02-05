---
description: Used to add, modify, or maintain AI instructions (Rules, Workflows, Skills, Hooks, Plans, Sub-agents) and sync documentation.
---

# AI Instruction Maintenance Workflow (/agent-update)

When you need to adjust the AI's "brain" configuration (e.g., adding rules or optimizing processes), follow these steps:

## 1. Requirement Analysis & Scope Targeting

- **Categorization**: Determine if you are adding or modifying `Rules`, `Workflows`, `Skills`, `Hooks`, `Plans`, or `Sub-agents`.
- **Storage Selection**:
  - **Local (Project Specific)**: Default to the `.agent/` directory in the current project. Suitable for project-specific business logic and architectural requirements.
  - **Global (General Capability)**: If the instruction is general-purpose, store it in the global directory `~/.agent/`. Suitable for general code styles, Git standards, or common automation tools.
- **Impact Assessment**: Check if the new instruction conflicts with existing ones.

## 2. Drafting Content

- **Reference Standards**: Before writing any content, consult relevant standard documents (e.g., `.agent/rules/code-standards.md`) to ensure the definition is logical.
- **Follow Standard Templates**:
  - **Workflows**: Must include YAML frontmatter and step-by-step guides.
  - **Rules**: Must be well-structured and actionable.
  - **Skills**: Must include `SKILL.md` (metadata + instructions) and optional `scripts/`.
  - **Hooks**: Must define trigger timing and execution scripts.

## 3. File Operation (Action)

// turbo

- **Write to File**:
  - If **Local**: Operate on files under `[Project Root]/.agent/`.
  - If **Global**: Operate on files under `~/.agent/`.
- **Sync Documentation**: **MUST update the `README.md`** in the corresponding directory (local or global) to keep the index up to date.

## 4. Verification & Summary

- **Self-Test**: Try to simulate running the new instruction.
- **Submit Report**: Tell the user what adjustments were made, along with a snapshot of the updated `README.md`.
