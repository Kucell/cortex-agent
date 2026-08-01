# `.agent/decisions/` — 决策记录

> **Schema**: [`decision.schema.json`](./decision.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

决策记录(decision record)的存储目录。**已 resolved 的决策** —— 不存"待决"(那用 `waitpoints/`)。

code 模式典型 type: `architecture` / `merge` / `release` / `risk`。
general 模式新增 `lifestyle` —— 日常任务中的偏好/规范类决策。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `decision_id` | string (`D-…`) | ✓ | 稳定 id |
| `type` | enum | ✓ | `approval` / `architecture` / `merge` / `release` / `risk` / `lifestyle` |
| `status` | enum | ✓ | `open` / `approved` / `rejected` / `revision_requested` / `canceled` / `superseded` |
| `requested_by` | string | ✓ | 申请方 |
| `prompt` | string | ✓ | 决策问题全文 |
| `options` | string[] (≥2) | ✓ | 候选选项,各选项独立可读 |
| `selected_option` | string \| null | | 终选(null if open/canceled/superseded) |
| `resolved_by` | string \| null | | 终选者 |
| `resolved_at` | date-time \| null | | 终选时间 |
| `rationale` | string | | 决策理由(留痕) |
| `gate.action` | enum | ✓ | `architecture` / `merge` / `release` / `destructive` / `credential` / `external_side_effect` / `lifestyle` |
| `gate.resource_ref` | string | ✓ | 受 gate 保护的资源 ref |
| `task_id` | string \| null | | 关联 task |
| `mission_id` | string \| null | | 关联 mission |
| `superseded_by_decision_id` | string (`D-…`) | | 被取代时填 |
| `created_at` | date-time | ✓ | |
| `updated_at` | date-time | ✓ | |

## 状态机

```
            requested
                |
                v
              open ----+----- approved (终选 + resolved_by/at)
                |      |
                |      +----- rejected
                |      |
                |      +----- revision_requested (回到 requested 变体)
                |
                +----- canceled (撤回)
                |
superseded <---- (新 decision 取代)
```

## 与 waitpoint 的关系

`waitpoints/` 存的是"决策前的等待状态"。waitpoint 关闭(resolved)时,**必须** 产生一个 `decisions/D-NNN.json`,反之未必(决策可独立走 `/approve` workflow)。

## 与其他目录关系

- 决策前 → 关联 `waitpoints/WP-NNN.json`
- 决策后 → 关联 `runs/R-NNN.json`(决策如何影响 run)
- 架构决策 → 关联 proposal:`gate.resource_ref = "proposal:..."`
- 日常决策(general 模式)→ 关联 `conversations/<id>/`

## Sample

见 [`sample.json`](./sample.json) —— 真实 `D-FAE-001`(已 approved 的 FAE-001 架构决策)。
