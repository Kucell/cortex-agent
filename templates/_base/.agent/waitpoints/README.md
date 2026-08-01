# `.agent/waitpoints/` — 等待点

> **Schema**: [`waitpoint.schema.json`](./waitpoint.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

阻塞性决策前的暂停闸口。当 run 撞到 gate(架构 / 合并 / 发布 / 凭证 / 外部副作用 / 日常),run 暂停并产生 waitpoint,等待 `decisions/D-*.json` 拍板。

code 模式和 general 模式共用。general 模式新增 `lifestyle` action。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `waitpoint_id` | string (`WP-…`) | ✓ | 稳定 id |
| `status` | enum | ✓ | `pending` / `blocked` / `released` / `canceled` / `expired` |
| `owner_workflow` | string (`/xxx`) | ✓ | 持有此 waitpoint 的 workflow(`/ship` `/approve` `/mission` `/handoff` 等) |
| `reason` | string | ✓ | 为什么等待 |
| `gate.action` | enum | ✓ | 跟 decision 一样 |
| `gate.resource_ref` | string | ✓ | 等待拍板的资源 |
| `decision_id` | string (`D-…`) | | released 时填 |
| `evidence_refs` | string[] | | 决策依据 |
| `release_note` | string | | released 时的人话说明 |
| `released_by` | string | | 谁(workflow 或用户)释放 |
| `released_at` | date-time | | released 时戳 |
| `expires_at` | date-time | | 超时阈值(可选) |
| `task_id` / `mission_id` | string | | 关联 |
| `created_at` / `updated_at` | date-time | ✓ | |

## 状态机

```
                pending <--------+
                   |             |
                   v             |
   (decision made) released      | (decision rejected/revising)
                                 |
   (manual abort)  canceled      |
                                 |
   (TTL reached)   expired ------+
```

## 与其他目录关系

- waitpoint 一旦 `released` → **必须** 关联 `decisions/D-*.json`(强一致)
- waitpoint 一旦创建 → 关联 `runs/R-*.json`(run 在该处暂停)
- waitpoint 由 `inbox/IM-*` 触发更佳(让收件方知道"为什么我卡住了")

## Sample

见 [`sample.json`](./sample.json) —— 真实 `WP-FAE-001`(已 released 的 FAE-001 架构 waitpoint)。
