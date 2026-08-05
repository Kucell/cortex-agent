# `.agent/inbox/` — 通信对象

> **Schema**: [`inbox.schema.json`](./inbox.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

agent 间消息(inbox message)的存储目录。code 模式和 general 模式共用。

每条 message 是**单向通信**:一个 sender → 多个 recipient(可能含 broadcast)。**不要**用 inbox 当作持久聊天记录 —— 那是 `conversations/` 的职责(general 模式)。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | 模式版本 |
| `message_id` | string (`IM-…`) | ✓ | 稳定 id,前缀 IM- |
| `type` | enum | ✓ | `information` / `request` / `handoff` / `decision_request` / `alert` |
| `status` | enum | ✓ | `unread` / `read` / `acknowledged` / `archived` |
| `sender_id` | string | ✓ | 发送方 agent 或人类 id |
| `recipient_ids` | string[] | ✓ | 直接接收方,`broadcast` 表示全员 |
| `subject` | string (≤200) | ✓ | 一行摘要 |
| `body` | string (≤4000) | ✓ | 正文(精简,大内容走 artifacts) |
| `task_id` | string \| null | | 主绑定任务 |
| `mission_id` | string \| null | | 主绑定 mission |
| `related_decision_ids` | string[] (`D-…`) | | 关联的决策记录 id |
| `related_waitpoint_ids` | string[] (`WP-…`) | | 关联的 waitpoint id |
| `related_handoff_ids` | string[] | | 关联的 handoff id |
| `created_at` | date-time | ✓ | RFC 3339 |
| `updated_at` | date-time | ✓ | RFC 3339 |
| `read_at` | date-time \| null | | 第一次 read 的时间 |
| `acknowledged_at` | date-time \| null | | acknowledge 时间 |
| `archived_at` | date-time \| null | | archive 时间 |

## type 语义

| Type | 含义 | 配套 action |
| :--- | :--- | :--- |
| `information` | 单向通知 | 无需 action |
| `request` | 请求对方做某事 | 对方应 ack + 完成 |
| `handoff` | 跨 agent 续接触发 | 配套 `H-NNN.json`(`handoffs/`) |
| `decision_request` | 请求对方拍板 | 配套 `D-NNN.json`(`decisions/`) |
| `alert` | 紧急通知(超时/失败/合规) | 对方必须 ack |

## 与其他目录关系

- `decision_request` → 后续在 `decisions/` 落 `D-NNN.json`
- `handoff` → 后续在 `handoffs/` 落 `H-NNN.json`(`conversations/<id>/handoffs/` 或顶层)
- `request` → 完成后写入 `runs/` run journal
- `alert` → 可触发 `waitpoints/` 暂停闸口

## 文件存放约定

- 每条 message 独立文件:`.agent/inbox/IM-NNN.json`
- 索引:`.agent/inbox/index.json`(`{ messages: [{message_id, path, type, status, updated_at}] }`)
- 删除策略:archive 后保留 30 天,过期可由 `cortex-agent inbox prune` 清理

## Sample

见 [`sample.json`](./sample.json) —— 一条 `decision_request`,发给 coordinator,绑定 mission M-001 MS-001。
