# `.agent/tasks/` — Task Pipeline

> **Schema**: [`task.schema.json`](./task.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

Task Pipeline:长期任务(task)。每个 task 走 stage gates(`draft → spec → plan → implement → validate → review → done`),每个 gate 关联 required artifacts + evidence。

code 模式和 general 模式共用。**和 missions 的区别**:task 是"单一有界工作",mission 是"多 milestone 长周期编排"——一个 mission 可以包含多个 task。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `task_id` | string | ✓ | 稳定 id(`T-*` 或 `M-NNN-MS-NNN`) |
| `title` | string | ✓ | |
| `description` | string | ✓ | |
| `status` | enum | ✓ | `draft` / `active` / `blocked` / `completed` / `canceled` |
| `stage` | enum | ✓ | `draft` / `spec` / `plan` / `implement` / `validate` / `review` / `done` |
| `priority` | enum | ✓ | `P0` / `P1` / `P2` / `P3` |
| `owner` | string | | worker / coordinator |
| `mission_id` | string | | 所属 mission |
| `acceptance_criteria` | string[] | | 验收条件 |
| `dependencies` | string[] | | 依赖的其他 task |
| `subtasks` | string[] | | 子 task |
| `validation_commands` | string[] | | 验证命令 |
| `gates[]` | object[] | | stage 流转 gate |
| `artifacts[]` | object[] | | 关联 artifacts(spec / architecture / plan / implementation / validation / review / decision / learning / handoff / release-note / published-doc) |
| `created_at` / `updated_at` | date-time | ✓ | |

## Stage 流转

```
draft → spec → plan → implement → validate → review → done
                                       ↑________waived
```

每个 stage 之间的 gate:

| Gate | required_artifacts | evidence_refs |
| :--- | :--- | :--- |
| `draft → spec` | spec draft | spec.md |
| `spec → plan` | spec final | spec.md + planning notes |
| `plan → implement` | plan + (architecture if required) | plan.md + arch proposal |
| `implement → validate` | implementation | code + tests |
| `validate → review` | validation report | test output + lint output |
| `review → done` | review approval | review notes + sign-off |

## 与其他目录关系

- task 推进 → 改 `runs/R-*.json` 的 stage
- task 阻塞 → 落 `waitpoints/WP-*.json`
- task 完成 → 关联 `missions/M-NNN` 的 milestone
- task 跨 worker 交接 → 落 `handoffs/H-*.json`

## Sample

见 [`sample.json`](./sample.json) —— 真实 `T-DASH-AUTO-001`(Dashboard lifecycle 设计任务)。
