---
description: Used to add, modify, or maintain AI instructions (rules, workflows, skills) and synchronize documentation.
---

# AI Instruction Maintenance Workflow (/agent-update)

When you need to adjust the AI's "brain" configuration (such as adding rules or optimizing processes), execute:

## 1. Requirement Analysis and Localization

- **Determine Category**: Decide whether it's adding a `Rule` (guidelines), `Workflow` (process), or `Skill` (capability).
- **🆕 Experience Recall**: Before impact assessment, call `experience-recall` to retrieve relevant historical lessons:
  ```bash
  node .agent/skills/experience-recall/scripts/index.js \
    --tags "<relevant-tags>" \
    --files "<files-to-be-modified>"
  ```
  If matches are found, **explicitly reference the relevant experience IDs** in the content draft and confirm the "防复发检查" items are satisfied.
- **L1/L2/L3 Classification**: Per `rules/agent-scope.md`, confirm the layer of the new capability before writing any file.
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

## 4. 🆕 Experience Capture

Before final commit, determine if this update triggers an experience record:

| Condition | Action |
|-----------|--------|
| This is a `fix:` / `revert:` / `rollback` change | Create `EXP-*.md` + update `index.json` |
| A new rule file is created for the first time | Create `RULE-EXP` type record |
| Explicit `/experience-capture` request | Create experience record |
| Routine update with no lessons learned | Skip (no record needed) |

If triggered, create `.agent/experiences/EXP-NNN.md` using the template at `.agent/experiences/TEMPLATE.md`, then add entry to `experiences/index.json`.

## 4.5 🆕 Memory Feedback Capture（轻量观察笔记）

Experiences 记录的是 **commit-anchored 教训**（有 trigger + 防复发检查）。如果本次 `agent-update` 中观察到**轻量的、可复用的 session 行为反馈**（如"该类问题被反复问 3 次"、"某种命令的输出总是让 agent 走错分支"），可写入 `.agent/memory/feedback/`，**不**走 experiences。

判断标准：
- 是**单一 session 观察**、**无 commit 锚定**、**无需防复发检查** → 走 `memory/feedback/`
- 是**跨 commit 的教训**、**有 trigger 和防复发** → 走 `experiences/`
- 是**用户偏好**（"用户喜欢 X"）→ 走 `memory/user/`
- 是**项目级事实**（"该项目用 Y"）→ 走 `memory/project/`

写入步骤：
1. 草拟 YAML frontmatter（`name` / `description` / `type: feedback` / `created` / `tags`，可选 `expires` 默认 `created + 90 天`）
2. 用 `memory.schema.json` 校验（Phase 2 提供 `/memory-validate` skill；当前可用 `node -e` 简单检查）
3. Write 到 `.agent/memory/feedback/<name>.md`
4. 在 `MEMORY.md` 的 `## feedback (n/30)` 段追加索引行

每项目 ≤30 条 feedback；超限时**自动归档**最早 5 条到 `feedback/_archive/<date>-<name>.md`。

## 5. Verification and Summary

- **Verify Links**: If it's a global update, confirm that the symlinks in the local project are effective.
- **Submit Report**: Explain the adjustments made, confirm the synchronization status, and report whether an experience record was created.
