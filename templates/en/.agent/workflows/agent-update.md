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

## 4.5 🆕 Memory Feedback Capture (lightweight session observations)

Experiences record **commit-anchored lessons** (with trigger + relapse prevention). If this `agent-update` observes **lightweight, reusable session behavior feedback** (e.g., "this kind of question is asked repeatedly", "a certain command's output always leads the agent down the wrong branch"), you may write to `.agent/memory/feedback/` — **not** experiences.

Decision criteria:
- **Single-session observation**, **no commit anchor**, **no relapse prevention** → goes to `memory/feedback/`
- **Cross-commit lesson**, **has trigger and relapse prevention** → goes to `experiences/`
- **User preference** ("user likes X") → goes to `memory/user/`
- **Project-level fact** ("this project uses Y") → goes to `memory/project/`

Write steps:
1. Draft YAML frontmatter (`name` / `description` / `type: feedback` / `created` / `tags`, optional `expires` defaulting to `created + 90 days`)
2. Validate against `memory.schema.json` (Phase 2 will provide a `/memory-validate` skill; for now use a simple `node -e` check)
3. Write to `.agent/memory/feedback/<name>.md`
4. Append an index line under `## feedback (n/30)` in `MEMORY.md`

Per project ≤30 feedback entries; on overflow **auto-archive** the earliest 5 entries to `feedback/_archive/<date>-<name>.md`.

## 5. Verification and Summary

- **Bootstrap First**: If this `/agent-update` promotes a new capability from a framework or capability provider into reusable templates, verify it in the provider's own `.agent/` first. Follow `.agent/rules/agent-scope.md` "New Capability Bootstrap Verification Order".
- **Evidence Required**: Record concrete self-use evidence: command, exit code, generated report/artifact path, or workflow dry-run result. Do not claim template or downstream-project readiness before provider-side `.agent` verification passes.
- **Verify Links**: If it's a global update, confirm that the symlinks in the local project are effective.
- **Submit Report**: Explain the adjustments made, confirm the synchronization status, and report whether an experience record was created.
