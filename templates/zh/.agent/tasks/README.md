# 任务流水线

`.agent/tasks/` 保存持久、机器可读的任务契约。它补充而不替代 `.agent/plans/task-progress.md`：计划文件仍是面向人的路线图，每个 `<task-id>.json` 则记录任务阶段、gate 证据、依赖与工件引用。

## 目录结构

```text
.agent/tasks/
├── README.md
├── index.json
├── index.schema.json
├── task.schema.json
└── <task-id>.json
```

`index.json` 是精简发现索引，任务文件是流水线状态的权威来源。创建或更新任务的工作流应尽可能原子地同步两个文件；任务文件缺失不能被推断为路线图任务已完成。

## 阶段与 Gates

唯一正向阶段顺序为：

```text
draft -> spec -> plan -> implement -> validate -> review -> done
```

| 流转 | 所属工作流 | Gate 要求 |
| :--- | :--- | :--- |
| `draft -> spec` | `/plan` 或 `/arch-design` | 已记录标题、描述、验收标准、优先级、依赖和来源引用。 |
| `spec -> plan` | `/plan` | 存在 final `spec` 与 final `plan` 工件；影响架构的任务还必须有用户批准的 final `architecture` 工件。 |
| `plan -> implement` | 执行工作流 | 依赖任务均为 `done`；必需计划与架构工件均为 final；可写范围和验证命令已明确。 |
| `implement -> validate` | `/ship` | final `implementation` 工件引用实现 diff、commit 或执行报告。 |
| `validate -> review` | `/ship` | final `validation` 工件记录命令和通过证据；验证失败时阻断流转。 |
| `review -> done` | `/ship` | final `review` 工件没有阻断项。`--no-review` 必须来自用户显式选择，并用 `waived` gate 记录原因。条件性的 release-note 和 published-doc 要求已满足或明确标为不适用。 |

阶段不得倒退。检查失败时保持当前阶段不变，并将目标 gate 标为 `blocked`；修复时追加新工件，再检查同一 gate。纠正误写阶段必须获得用户明确批准并记录原因。`status = blocked` 不改变 `stage`。

只有表中指定工作流可以把对应 gate 标为 `passed` 或 `waived`。只读查询和 dashboard 可以展示 gate 状态，但不能推进阶段。后续 decision/waitpoint 能力可以补充批准证据，但不改变该归属规则。

## 工件类型

任务文件只保存引用，不保存工件正文。工件 payload 继续以 append-only 方式保存在 `.agent/artifacts/<task-id>/` 或其他已有真理源文件中。

| Kind | 含义 | 现有 Artifact Bus envelope |
| :--- | :--- | :--- |
| `spec` | 范围、验收标准和约束 | `plan` |
| `architecture` | 已批准架构提案或待决策设计 | `plan` |
| `plan` | 可执行步骤、依赖和验证命令 | `plan` |
| `implementation` | diff、commit、执行报告或变更路径证据 | `execution` |
| `validation` | 测试、lint、安全或人工验证证据 | `validation` |
| `review` | 架构或代码审查结论 | `review` |
| `decision` | 明确的人类或架构决策 | decision store 建立前使用 `note` |
| `learning` | 可复用且已验证的经验 | `note` |
| `handoff` | 所有权转移和续接上下文 | `handoff` |
| `release-note` | 面向用户的交付摘要 | `note` |
| `published-doc` | 已发布文档路径与验证证据 | `note` |

当现有 Artifact Bus 不支持规范 kind 时，使用映射后的 envelope kind，并在 `payload.artifact_kind` 中写规范值。任务的 `artifacts[].kind` 始终使用上表规范值。该兼容规则无需修改既有 Artifact Bus reader。

只有同时满足以下条件的工件才能通过 gate：任务条目为 `status: "final"`、引用文件存在、gate 的 `evidence_refs` 包含该引用。被 superseded 的工件保留追溯能力，但不能满足新 gate。

## 写入规则

- `/plan` 创建任务文件，并在对应工件 final 后依次推进到 `spec` 和 `plan`。
- `/arch-design` 追加 `architecture` 工件；只有用户批准后才能标为 final 或用于 gate。
- `/ship` 负责 implementation、validation、review 和完成 gates。
- `/publish-docs` 只消费 final 工件并追加 `published-doc` 工件；它不能独立把任务标为 done。
- 时间戳使用 UTC ISO 8601 格式，每次任务变更后更新 `updated_at`。
- 不得把完整提案、diff、日志、prompt、凭证或生成文档复制到任务 JSON。
- Management API 增加明确的 task write gate 前，不得通过它修改任务记录。
