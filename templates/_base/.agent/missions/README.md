# `.agent/missions/` — 长周期任务编排

> **Schema**: [`mission.schema.json`](./mission.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

长周期任务(mission)状态目录。code 模式和 general 模式共用。

参考 `docs/architecture/mission-lite-design.md` — 一个 mission 包含:

- `mission-plan.md` — 计划
- `validation-contract.json` — 验证契约
- `command-log.md` — 命令日志
- `milestones/MS-*.md` — 每个 milestone 的完成证据
- `handoffs/H-*.json` — 跨 agent 续接

mission schema 是 mission-plan + milestones 状态的**结构化摘要**(便于程序读),**不是** plan 文档本身(plan 是 markdown)。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `mission_id` | string (`M-…`) | ✓ | 稳定 id |
| `title` | string | ✓ | 简述 |
| `description` | string | | 详情 |
| `status` | enum | ✓ | `draft` / `active` / `blocked` / `completed` / `canceled` / `superseded` |
| `current_milestone_id` | string (`MS-…`) | | 当前活跃 milestone |
| `milestones[]` | object[] | ✓ | milestone 列表 |
| `validation_contract_ref` | string | ✓ | 指向 `validation-contract.json` |
| `command_log_ref` | string | | 指向 `command-log.md` |
| `owner` | string | | 主要 worker / coordinator |
| `coordinator_session_id` | string | | 哪个 session 主持 |
| `created_at` / `updated_at` | date-time | ✓ | |

## Milestone 字段(嵌套)

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `milestone_id` | string (`MS-…`) | ✓ | |
| `title` | string | ✓ | |
| `description` | string | | |
| `status` | enum | ✓ | `planned` / `in_progress` / `blocked` / `passed` / `failed` / `waived` |
| `owner` | string | | worker 标识 |
| `depends_on` | string[] (`MS-…`) | | 依赖的其他 milestone |
| `validation_contract_ref` | string | ✓ | 指向该 milestone 的 contract |
| `milestone_ref` | string | | 指向 `milestones/MS-*.md` |
| `started_at` / `completed_at` | date-time | | |

## 状态机

```
draft → active → (blocked ↔ in_progress) → completed
                          ↘ canceled
                          ↘ superseded
```

## 与其他目录关系

- 推进时 → 改 `runs/R-*.json` 的 `mission_id`
- 阻塞时 → 落 `waitpoints/WP-*.json`
- 跨 worker 交接 → 落 `handoffs/H-*.json`
- 终态 → 关联 `conversations/<id>/`(general 模式归档)

## Sample

见 [`sample.json`](./sample.json) —— 真实 M-001 mission(Phase 1: mode 切分 + 跨 host 切换总线)。
