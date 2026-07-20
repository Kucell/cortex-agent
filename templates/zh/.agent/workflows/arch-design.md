---
description: Used to propose, evaluate, and integrate new architectural ideas or solutions during the development process.
---

# Architectural Evolution and Design Workflow (/arch-design)

When you have new architectural ideas or need to refactor existing modules, follow this process to ensure design rigor and consistency:

## 1. Solution Conception and Current State Analysis

- **Read Core Principles**: **You must first read** the `.agent/rules/architecture-design.md` file, treating the core principles of the project architecture as the highest priority.
- **Read Proposal Structure**: **You must also read** `.agent/rules/proposal-structure.md` before deciding where the proposal should be stored.
- **Understand Context**: Deeply explore the requirements proposed by the user or the technical bottlenecks encountered by the existing system.
- **Research referenced repositories**: When a candidate design references a public GitHub repository, invoke `github-repo-research`. Use DeepWiki to locate architecture and implementation evidence, then verify decisions against the repository source before comparing solutions.
- **Read PRD Assets First**: If `.agent/prd/` or `.agent/prds/` contains a PRD in `review`, `approved`, or `designed` status, read its `state.json`, `prd.md`, `flows.md`, `screens.md`, and `acceptance-criteria.md` before writing architecture proposals.
- **Current State Review**: Search for relevant implementation logic in the current codebase.
- **Conflict Detection**: Analyze whether the new solution conflicts with the loaded architectural principles.

## 2. Design Output

- **Determine proposal scope and path**: Before writing the file, decide whether this is a standalone proposal or a project-level proposal group.

  Standalone proposal:
  ```
  .agent/plans/proposals/<topic>/<short-name>-proposal.md
  ```
  - `topic` is the core module or business domain in kebab-case (e.g. `auth`, `device-template`, `state-management`)
  - Reuse an existing subfolder if one matches; create a new one if not

  Project-level proposal group:
  ```
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<short-name>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - Use a project folder when the proposal spans multiple phases, multiple workflows/skills/CLI capabilities, multiple real projects, or multiple related sub-proposals.
  - Create or update `index.md` using `.agent/resources/templates/proposal-project-index.md`.
  - Record related projects and dependencies in `relations.md`.
  - **Never place a proposal directly under `.agent/plans/proposals/`**

- **Write Proposal**: Provide clear design descriptions, recommended to include:
  - Description of structural changes.
  - Core flowcharts or class diagrams (Mermaid).
  - API change list.
  - Impact on existing data flows.

## 3. Architectural Comparison and Evaluation

- **Call Audit Skill**: Use the `.agent/skills/architecture-audit` skill to audit the new proposal.
- **In-depth Comparison**: Produce a solution comparison table, comparing the Status Quo with the Proposal across these dimensions:
  - Architectural compliance
  - Scalability and maintenance cost
  - Runtime performance and system complexity
  - Implementation difficulty and migration cost
- **Risk Identification**: Clearly point out potential side effects introduced by the new solution (e.g., breaking backward compatibility, increasing system overhead).

## 4. Review and Decision

- **Present Conclusions**: Show the comparison analysis results to the user and provide the AI's recommendation.
- **Wait for Confirmation**: Fine-tune or confirm the solution based on user feedback.

## 5. Task Pipeline And Architecture Artifact

- **Resolve task context**: If the design belongs to an existing task, read `.agent/tasks/<task-id>.json`. Otherwise create a `draft` task record only after the scope and acceptance criteria are known, and synchronize `.agent/tasks/index.json`.
- **Append the artifact**: Store the proposal in its normal proposal path, then append an Artifact Bus entry using envelope `kind: plan` and `payload.artifact_kind: architecture`. Add the resulting path to the task as canonical `kind: architecture`, initially with `status: draft`.
- **Approval gate**: User confirmation is required before changing the task artifact to `status: final`. Record the approval evidence in the artifact summary or refs; do not change proposal status as an implicit side effect.
- **Advance deliberately**: `/arch-design` may pass `draft -> spec` when the task contract is complete. It must not pass `spec -> plan`; `/plan` owns that gate and must verify the final architecture artifact when `architecture_required = true`.
- **Handle revision**: A rejected or replaced design remains referenced as `superseded`. Do not delete or overwrite prior artifacts, regress the task stage, or advance a blocked gate.

## 6. Integration and Implementation

- **Update Documentation**: Archive approved designs to the project's documentation library (e.g., `docs/architecture/`).
- **Publish Developer Docs**: If the approved proposal changes developer-facing architecture, run `/publish-docs --architecture` after the proposal is finalized so `docs/` receives a sanitized, standalone version.
- **Task Decomposition**: Convert the design solution into a specific task list and update the implementation plans under `.agent/plans/`.
- **PRD Traceability**: When the proposal implements or changes a PRD, record the PRD id and related tasks in the proposal frontmatter or first section.
- **确定提案路径**：在写文件前，先从提案主题推导出所属分类（topic），按以下规则保存：
  ```
  .agent/plans/proposals/<topic>/<简短名称>-proposal.md
  ```
  - `topic` 取提案的核心模块或业务域，使用 kebab-case（如 `auth`、`device-template`、`state-management`）
  - 若同主题下已有子文件夹，直接复用；若无，创建新文件夹
  - **禁止将提案直接放在 `.agent/plans/proposals/` 根目录下**
- **项目级提案目录**：创建提案前读取 `.agent/rules/proposal-structure.md`，并判断提案属于单点提案还是项目级提案组。

  单点提案继续使用：
  ```text
  .agent/plans/proposals/<topic>/<简短名称>-proposal.md
  ```

  大项目、关联项目、跨多个 workflow/skill/CLI 能力、跨多个实战项目验证，或需要多个子提案时，必须使用项目文件夹：
  ```text
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<简短名称>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - 使用 `.agent/resources/templates/proposal-project-index.md` 创建或更新 `index.md`
  - 在 `relations.md` 记录关联项目、上下游依赖、同步范围和验证状态
  - 禁止将提案直接放在 `.agent/plans/proposals/` 根目录
  - 禁止提交 `.DS_Store`、临时文件或导出缓存

## Communication Runtime Integration

`/arch-design` 必须使用 decisions / waitpoints gate 工作流：

- 资源绑定：每个 architecture 提案使用 `decisions request --gate mission --type approval --gate-action architecture --resource-ref architecture:<proposal-id>` 创建 open Decision。
- 提案关联：Decision 记录绑定 `revision-digest`（提案 hash）与 `relations.mission_ids / task_ids`，确保后续 supersede / resolve 可追溯。
- Waitpoint gate：创建 `waitpoints create --owner-workflow /arch-design --reason "Architecture approval required" --action architecture --resource-ref architecture:<proposal-id>`，由用户批准后释放。
- 用户批准使用 `decisions resolve --gate user`，`waitpoints release` 由 owning workflow 调用以消费 approved Decision。
- Checkpoint 状态可挂在 Decision 与 Waitpoint 的 relations 上，pending approval 状态标记为 `Checkpoint`，用户批准后才进入下一步。

## Owner Gate 引用

- `decisions request` / `waitpoints create` 必须使用 `--gate owner` 作为 owner 端 gate。
- Decision 与 Waitpoint 必须显式标注 `type=architecture` 或 `type=architecture`。

- Decision gate 显式使用 `action=architecture`（或 `\`action=architecture\``）标识 gate 类型，与 Decision schema 枚举对齐。
