---
description: 用于开发过程中提出、评估和整合新的架构思路或方案
---

# 架构演进与设计工作流 (/arch-design)

当你有了新的架构想法或需要重构现有模块时，遵循此流程以确保设计的严谨性和一致性：

## 1. 方案构思与现状分析
- **读取核心原则**: **必须首先读取** `.agent/rules/architecture-design.md` 文件，将项目架构的核心原则作为最高优先级。
- **读取提案目录规范**: **必须同时读取** `.agent/rules/proposal-structure.md`，再决定提案应该保存到哪个目录。
- **理解背景**: 深入探讨用户提出的需求或现有系统遇到的技术瓶颈。
- **优先读取 PRD 资产**: 如果 `.agent/prd/` 或 `.agent/prds/` 中存在 `review`、`approved` 或 `designed` 状态的 PRD，必须先读取其 `state.json`、`prd.md`、`flows.md`、`screens.md` 与 `acceptance-criteria.md`，再编写架构提案。
- **现状梳理**: 搜索当前 codebase 中相关的实现逻辑。
- **冲突检测**: 分析新方案与已加载的架构原则是否冲突。

## 2. 设计方案产出

- **确定提案范围与路径**：在写文件前，先判断这是单点提案，还是项目级提案组。

  单点提案：
  ```
  .agent/plans/proposals/<topic>/<简短名称>-proposal.md
  ```
  - `topic` 取提案的核心模块或业务域，使用 kebab-case（如 `auth`、`device-template`、`state-management`）
  - 若同主题下已有子文件夹，直接复用；若无，创建新文件夹

  项目级提案组：
  ```
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<简短名称>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - 当提案跨多个 Phase、多个 workflow/skill/CLI 能力、多个实战项目，或需要多个子提案时，必须使用项目文件夹
  - 使用 `.agent/resources/templates/proposal-project-index.md` 创建或更新 `index.md`
  - 在 `relations.md` 记录关联项目与依赖关系
  - **禁止将提案直接放在 `.agent/plans/proposals/` 根目录下**

- **编写提案**: 提供清晰的设计说明，建议包含：
    - 结构变更说明。
    - 核心流程图或类图 (Mermaid)。
    - 接口 (API) 变动清单。
    - 对既有数据流的影响。

## 3. 架构对比评估
- **调用审计技能**: 结合 `.agent/skills/architecture-audit` 技能对新提案进行审计。
- **深度对比**: 产出方案对比表，对比当前方案 (Status Quo) 与提议方案 (Proposal) 在以下维度的表现：
    - 架构合规性
    - 扩展性与维护成本
    - 运行时性能与系统复杂度
    - 实现难度与迁移成本
- **风险识别**: 明确指出新方案可能引入的副作用（如：破坏向后兼容性、增加系统开销）。

## 4. 评审与决策
- **呈现结论**: 向用户展示对比分析结果，并给出 AI 的推荐建议。
- **等待确认**: 根据用户反馈进行方案微调或确认。

## 5. 任务流水线与架构工件

- **确定任务上下文**：若设计属于已有任务，读取 `.agent/tasks/<task-id>.json`。否则只有在范围和验收标准明确后才创建 `draft` 任务记录，并同步 `.agent/tasks/index.json`。
- **追加工件**：提案仍保存到规范提案路径，再向 Artifact Bus 追加 envelope `kind: plan`、`payload.artifact_kind: architecture` 的工件。把返回路径以规范 `kind: architecture` 加入任务，初始 `status: draft`。
- **审批 Gate**：只有用户确认后才能把任务中的该工件改为 `status: final`。在工件摘要或 refs 中记录批准证据；不得把修改提案状态作为隐式副作用。
- **谨慎推进**：任务契约完整时，`/arch-design` 可以通过 `draft -> spec`；不得通过 `spec -> plan`，该 gate 属于 `/plan`，且 `architecture_required = true` 时必须检查 final 架构工件。
- **处理修订**：被拒绝或替换的设计继续以 `superseded` 保留引用。不得删除或覆盖旧工件、倒退任务阶段或推进 blocked gate。

## 6. 整合与落地
- **更新文档**: 将批准的设计归档至项目文档库（如 `docs/architecture/`）。
- **发布开发者文档**: 若确认后的方案会影响开发者理解架构，方案定稿后运行 `/publish-docs --architecture`，把结论发布为脱敏、可独立阅读的 `docs/` 文档。
- **任务分解**: 将设计方案转化为具体的任务清单，更新 `.agent/plans/` 下的实施计划。
- **PRD 可追溯性**: 当提案实现或改变某个 PRD 时，在提案 frontmatter 或第一节记录 PRD ID 与关联任务。
