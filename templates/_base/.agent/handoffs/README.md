# `.agent/handoffs/` — 跨 agent 续接 payload

> **Schema**: [`handoff.schema.json`](./handoff.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

跨 agent 续接(handoff)payload 存储。**HUMAN_RESUME** 模式:交回人类;**AGENT_RESUME** 模式:交给另一个 agent。

code 模式(同构 agent)和 general 模式(异构 agent + 人类)共用,但 general 模式用得更深 —— 因为 Cortex / Codex / Claude Code 协议不同,需要显式 handoff payload。

参考 RFC §6.4.1 跨 agent 续接协议 + `general-mode-design.md` 第 269-329 行 H-NNN.json 设计。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `handoff_id` | string (`H-…`) | ✓ | 稳定 id |
| `mode` | enum | ✓ | `HUMAN_RESUME` / `AGENT_RESUME` |
| `from.agent_id` | string | ✓ | 离场方 |
| `from.model` | string | ✓ | 离场方模型 |
| `from.session_id` | string | | 离场方 session |
| `to.role` | string | ✓ | 接收方 role |
| `to.model_pref` | string[] | ✓ | 模型偏好(按顺序尝试) |
| `to.required_capabilities` | string[] | ✓ | 必需能力 |
| `task_id` | string | ✓ | 主绑定 task |
| `mission_id` | string | | 关联 mission |
| `task_progress.current_step` | string | ✓ | 当前步骤 |
| `task_progress.completed_steps` | string[] | ✓ | 已完成 |
| `task_progress.in_progress` | string | ✓ | 进行中 |
| `task_progress.remaining_steps` | string[] | ✓ | 剩余 |
| `artifacts.completed` | string[] | ✓ | 已完成 artifacts 路径 |
| `artifacts.context_snapshot_ref` | string | ✓ | 上下文快照 ref(指向 RC-*.json) |
| `artifacts.markdown_ref` | string | ✓ | markdown 版本 ref(人类可读) |
| `artifacts.artifact_refs` | string[] | | 其他 artifacts |
| `next_action` | string | ✓ | 接收方下一步 |
| `constraints` | string[] | | 硬约束 |
| `verification.commands_run` | object[] | ✓ | 已跑命令 |
| `verification.commands_needed` | string[] | ✓ | 待跑命令 |
| `verification.known_failures` | string[] | ✓ | 已知失败 |
| `graphify_context` | object | | code 模式专属:图谱上下文 |
| `context_budget_hint` | int | | 建议 context budget |
| `produced_at` | date-time | ✓ | |

## 与 RFC §6.4.1 H-NNN.json 的关系

RFC §6.4.1 描述的 `H-NNN.json` 是 **conversation-scoped**(存在 `conversations/<id>/handoffs/H-NNN.json`)。
本 schema 是 **project-scoped**(存在 `.agent/handoffs/H-*.json`)。

两者字段基本一致;区别在于:

- project-scoped:绑定到 task/mission,有完整 `verification` 段
- conversation-scoped:绑定到 conversation,`task_id` 可选,有 `checksum` 字段

## 切换流程(mermaid)

```
Old agent ──(1)checkpoint──> handoff payload ──(2)hand over──> New agent
                              │
                              └──(3)verify checksum──> state.json
                              │
New agent ──(4)turn_resumed──> conversations/<id>/
```

## Sample

见 [`sample.json`](./sample.json) —— 真实 `H-20250612-053200-t-c09-verification.json`(T-C09 验证 handoff)。
