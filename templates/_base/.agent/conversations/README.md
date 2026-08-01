# `.agent/conversations/` — 长期对话档案(general 模式核心)

> **Schema**: [`conversation.schema.json`](./conversation.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

长期对话档案(conversation archive)。**general 模式核心** —— sessions/ 是短时(5h),conversations/ 是长时(跨 session + 跨 agent)。

参考 RFC `general-mode-design.md` §6.4.1(269-329 行)H-NNN.json 跨 agent 续接协议。

## 目录结构

```text
.agent/conversations/
└── C-NNN/
    ├── meta.json                # 本 schema 的内容(conversation_id / topic / active_agent / state)
    ├── turns/
    │   ├── 0001.yaml            # turn 1
    │   ├── 0002.yaml
    │   └── ...
    ├── handoffs/
    │   ├── H-001.md             # 人类可读
    │   ├── H-001.json           # 机器可读(结构化状态)
    │   └── state.json           # 当前活跃 agent + 上次 checksum
    ├── summary.md               # 蒸馏后的摘要
    ├── decisions.md             # 产生的决策(链接 .agent/decisions/)
    ├── artifacts.md             # 产生的产物(链接 .agent/artifacts/)
    └── relations.yaml           # 跟 mission / task / 其他 conversation 的关系
```

> MS-001 阶段只发布 schema(本文件)+ sample(代表 C-NNN/meta.json);`turns/` `handoffs/` 等子目录由后续 MS(general 模式 workflow,Phase 2)落。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `conversation_id` | string (`C-…`) | ✓ | 稳定 id |
| `topic` | string | | 一行主题 |
| `outcome` | enum \| null | | `open` / `resolved` / `abandoned` / `superseded` |
| `domain` | string | | 域(代码 / 设计 / 日常 / 健康 …) |
| `active_agent` | object | | 当前活跃 agent |
| `active_agent.type` | enum | | `claude-code` / `cortex` / `codex` / `codey` / `human` / `other` |
| `turn_count` | int | | turn 总数 |
| `handoffs[]` | object[] | | 跨 agent 续接记录 |
| `summary_ref` | string | | `summary.md` 路径 |
| `decisions_refs` | string[] (`D-…`) | | 产生的 decision |
| `artifact_refs` | string[] | | 产生的 artifact |
| `relations` | object | | 与 mission / task / 其他 conversation 的关系 |
| `state` | object | | 实时状态指针 |
| `state.latest_turn` | int | | 最新 turn 号 |
| `state.active_missions` / `pending_decisions` / `in_flight_tasks` | string[] | | |
| `state.checksum` | string | | 防止切换过程数据漂移 |
| `created_at` / `updated_at` | date-time | ✓ | |

## 切换协议(§6.4.1 核心不变量)

1. 离场 agent 写 `H-NNN.{md,json}` + 更新 `state.json`
2. 入场 agent 读 latest `H-NNN` + latest turn
3. 入场 agent 写 `turn_resumed.yaml` 标记续接完成
4. 任何 agent 都能通过 `state.json` + latest `H-NNN.json` 重建完整上下文

切换过程中 `decisions/` / `inbox/` / `artifacts/` 内容**不丢失**;`sessions/` 短期状态正确迁移到 `conversations/` 长期状态。

## 与其他目录关系

- 跨 agent 续接 → 关联 `handoffs/H-*.json`(project-scoped)或 `conversations/C-NNN/handoffs/H-NNN.json`(conversation-scoped)
- 决策 → 关联 `decisions/D-*.json`
- run journal → 关联 `runs/R-*.json`
- mission / task 绑定 → `relations.{mission_ids,task_ids}`

## Sample

见 [`sample.json`](./sample.json) —— 真实对话档案示例:跨 Cortex → Codex → Claude Code 三 agent 续接,绑定 M-001。
