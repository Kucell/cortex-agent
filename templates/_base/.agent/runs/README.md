# `.agent/runs/` — Run Journal

> **Schema**: [`run.schema.json`](./run.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

协作 run journal:一次**有界执行**的完整轨迹。code 模式和 general 模式共用。

一个 run 对应一次 `/start-task`、一次 `/mission milestone`、一次 `/handoff`、一次 `/memory distill` 等等 —— "有起点 + 有终点"。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `run_id` | string | ✓ | 稳定 id,惯例 `R-{slug}` |
| `task_id` | string \| null | | 绑定 task |
| `mission_id` | string \| null | | 绑定 mission |
| `agent_id` | string \| null | | 哪个 agent 跑 |
| `role` | string \| null | | implementer / coordinator / reviewer |
| `kind` | enum | ✓ | `plan` / `implement` / `validate` / `merge` / `handoff` / `dashboard` / `publish` / `memory` / `conversation` |
| `status` | enum | ✓ | `queued` / `running` / `completed` / `failed` / `canceled` |
| `phase` | string \| null | | 当前阶段(init / planning / editing / handoff / blocked …) |
| `activity` | string \| null | | 一行当前活动 |
| `worktree_path` / `branch` / `base_commit` / `head_commit` | string | | code 模式专属,general 模式为 null |
| `started_at` | date-time | ✓ | |
| `finished_at` / `updated_at` | date-time | | |
| `events[]` | object[] | | 时间线 |
| `next_action` | string | | 下一步(供续接) |

## kind 说明

| Kind | 触发场景 | 模式 |
| :--- | :--- | :--- |
| `plan` | `/plan` 输出阶段 | code |
| `implement` | `/start-task` 实现阶段 | code |
| `validate` | `/start-task` 验证 + 收口 | code |
| `merge` | worktree merge 到主分支 | code |
| `handoff` | 跨 agent 续接 | code + general |
| `dashboard` | dashboard supervisor | code |
| `publish` | docs / npm 发布 | code |
| `memory` | `/memory distill` 等 | **general** |
| `conversation` | `/conversation log` | **general** |

## 与其他目录关系

- run journal 事件会触发 `waitpoints/` 暂停
- run 完成后会写 `decisions/`(如适用)
- run 一旦涉及多 agent → 配套 `handoffs/H-*.json`
- run 是 `missions/` milestone 状态推进的输入

## Sample

见 [`sample.json`](./sample.json) —— 真实 `R-P-001-session-cli`(已 completed 的 P-001 实施 run)。
