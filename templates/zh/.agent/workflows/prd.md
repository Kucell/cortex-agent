---
name: prd
description: 在架构、原型、计划或实现之前，创建、评审和更新 `.agent/prd/` 下的本地 PRD 资产。
---

# PRD 工作流 (/prd)

## 使用方式

```text
/prd create <prd-id> "<title>"
/prd status [prd-id]
/prd review <prd-id>
/prd link-task <prd-id> <task-id>
/prd design <prd-id> --tool openpencil|figma|penpot|markdown --status draft|reviewed|ready
```

## 目标

把用户需求转化为本地、可评审、可追踪的 PRD 资产，供 Dashboard、`/arch-design`、`/prototype`、`/plan` 和 `/publish-docs` 消费。

## 数据结构

```text
.agent/prd/
├── index.json
├── prd.schema.json
└── PRD-001/
    ├── state.json
    ├── prd.md
    ├── user-stories.md
    ├── flows.md
    ├── screens.md
    ├── acceptance-criteria.md
    ├── decisions.md
    └── links.json
```

## 状态机

```text
idea -> draft -> review -> approved -> designed -> implemented -> validated -> published
```

当缺少关键决策或外部依赖导致无法推进时，使用 `blocked`。

## CREATE

1. 读取用户需求和已有 `.agent/prd/index.json`。
2. 选择稳定 PRD ID，例如 `PRD-001` 或 `PRD-<task-id>`。
3. 使用 `.agent/resources/templates/` 中的模板创建 PRD 目录。
4. 在 `state.json` 中填写标题、状态、负责人、关联任务、设计状态、评审状态和 `updated_at`。
5. 将 PRD 写入 `.agent/prd/index.json`。
6. 运行 `/agent-dashboard`，确认 PRD 出现在 PRD 工作台。

## STATUS

读取 `state.json` 和必需 PRD 文件，并报告：

- PRD 状态
- 设计状态
- 评审状态
- 完整度缺口
- 关联任务
- 推荐下一步命令

## REVIEW

检查这些必需部分：

- 背景
- 目标
- 非目标
- 用户
- 需求
- 用户故事
- 流程
- 页面
- 验收标准
- 未决决策

如果已经足够进入实现，将状态推进到 `approved`。如果还需要视觉设计，先推荐 `/prototype` 或关联 OpenPencil/Figma/Penpot，再进入 `/plan`。

## 集成规则

- `/arch-design` 在写架构提案前，应读取最新 `approved` 或 `review` 状态的 PRD。
- `/prototype` 应优先使用 PRD 的 `flows.md`、`screens.md` 和验收标准。
- `/plan` 应把拆出的任务回写或关联到 `state.json.related_tasks`。
- Dashboard 只读展示 PRD 状态，不直接修改 PRD 文件。

