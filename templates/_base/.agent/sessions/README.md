# `.agent/sessions/` — 实时会话状态

> **Schema**: [`session.schema.json`](./session.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

实时会话状态(session state)的存储目录。**短生命周期** —— Claude Code 5 小时上限就是 sessions 关注的核心问题。

> **不要** 把 sessions 当成长期对话档案;那用 `conversations/`(general 模式专属)。

参考 `sub-agents/session-manager.md` 的 5 模式协议:`assess` / `warm` / `archive` / `restore` / `status`。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `session_id` | string (`S-…`) | ✓ | 稳定 id |
| `project` | string | | 项目名(决定 archive 路径) |
| `agent_id` | string | ✓ | 哪个 agent |
| `role` | enum | ✓ | implementer / coordinator / reviewer / researcher / documenter / memory-curator / conversation-curator / user |
| `mode` | enum \| null | | `code` / `general`,MS-001 后由 `cortex-agent init` 决定 |
| `status` | enum | ✓ | `running` / `paused` / `closed` / `stale` / `archived` |
| `phase` | string \| null | | 当前阶段 |
| `activity` | string \| null | | 一行活动 |
| `current_run_id` / `current_task_id` / `current_mission_id` | string | | 关联 |
| `worktree_path` | string | | code 模式专属 |
| `started_at` | date-time | ✓ | |
| `last_heartbeat_at` | date-time | | |
| `updated_at` | date-time | | |
| `updated_by_gate` | enum | | 谁触发的 update |
| `closed_at` | date-time | | |
| `archive_path` | string | | 指向 `.agent/runtime-continuity/archives/RC-*.json` |

## 5 模式协议(session-manager)

| 模式 | 触发 | 副作用 |
| :--- | :--- | :--- |
| `assess` | "开始任务前评估时间" | 估时 + 拆分 ≤3h 子阶段 + 检查点 |
| `warm` | "会话即将超时" | 预 archive 到 RC-*.json |
| `archive` | "5h 上限到达" | 强制 archive + closed |
| `restore` | "新会话恢复" | 读 RC-*.json → 重建上下文 |
| `status` | "查询当前会话" | 读 session.json,无副作用 |

## 与其他目录关系

- session archive → 写 `runtime-continuity/archives/RC-*.json` + 关联 `conversations/<id>/`
- session 关闭 → 关联 `runs/R-*.json`(结束 run)
- session 切换 agent → 触发 `handoffs/H-*.json`

## Sample

见 [`sample.json`](./sample.json) —— 真实 `S-M-006`(mission coordinator running session)。
