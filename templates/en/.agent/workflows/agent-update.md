---
description: Used to add, modify, or maintain AI instructions (rules, workflows, skills) and synchronize documentation.
---

# AI Instruction Maintenance Workflow (/agent-update)

When you need to adjust the AI's "brain" configuration (such as adding rules or optimizing processes), execute:

## 1. Requirement Analysis and Localization

- **Determine Category**: Decide whether it's adding a `Rule` (guidelines), `Workflow` (process), or `Skill` (capability).
- **Impact Assessment**: Check if new instructions conflict with existing ones.
- **(Optional) Task Decomposition**: If the update requested by the user is very complex (e.g., involves multiple components), **first call the `planner` sub-agent** to decompose the task into smaller steps, then execute them one by one.

## 2. Content Drafting

- **Rules First**: Before writing any content, **you must first consult** `.agent/rules/code-standards.md` and `.agent/rules/architecture-design.md` to ensure new instructions comply with project standards.
- **Follow Standard Templates**:
  - Workflows must include YAML frontmatter and step-by-step guides.
  - Rules must be well-organized and actionable.
  - Skills must define clear `name` and `description` metadata and detailed instructions.

## 3. File Operation (Action)

// turbo

- **Select Storage Location**:
  - **Local (Project-Specific)**: Operate on the current project's `.agent/` directory.
  - **Global (General Capabilities)**: Operate on the `~/.agent/` directory.
- **Execute Write**: Perform operations in the corresponding subdirectories.
- **Automatic Linkage (Global only)**:
  - If **Global** configuration is updated, **you must immediately call the `sync-global` skill** to synchronize the latest global configuration to the current project via symbolic links, ensuring the IDE recognizes them immediately.
- **Documentation Maintenance**: Update the `README.md` in the corresponding directory (local or global).

## 4. Verification and Summary

- **Verify Links**: If it's a global update, confirm that the symlinks in the local project are effective.
- **Submit Report**: Explain the adjustments made and confirm the synchronization status.
