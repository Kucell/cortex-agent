# `.agent/memory/` — 跨 session 蒸馏记忆(general 模式核心)

> **Schema**: [`memory.schema.json`](./memory.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 用途

跨 session 蒸馏记忆(memory entries)。**general 模式核心**,code 模式可选。

参考 RFC `general-mode-design.md` §6.4 + §6.5(`/memory recall` `/memory distill` `/memory forget`)。

## 三类

| Type | 含义 | 例子 |
| :--- | :--- | :--- |
| `episodic` | 情景记忆:具体事件 | "2026-07-31 用户切换 Cortex → Codex 完成 FAE-001 审批" |
| `semantic` | 语义记忆:稳定事实 | "Eric 决策风格:接受具体推荐+备选+风险,不要纯菜单" |
| `procedural` | 程序记忆:习惯/流程偏好(**v1.12 推后**) | "用户偏好 `/ship` 之前必跑 `node .agent/architecture-guard`" |

## 目录结构

```text
.agent/memory/
├── episodic/                  # 情景记忆:具体事件
│   └── MEM-NNN.json
├── semantic/                  # 语义记忆:稳定事实
│   └── MEM-NNN.json
└── procedural/                # 程序记忆:习惯 / 流程偏好(v1.12 推后)
    └── MEM-NNN.json
```

> MS-001 阶段只发布 schema + sample(覆盖三类)。MS-002/003 落 `episodic/` `semantic/` 子目录;`procedural/` 推 v1.12。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `memory_id` | string (`MEM-…`) | ✓ | 稳定 id |
| `type` | enum | ✓ | `episodic` / `semantic` / `procedural` |
| `title` | string (≤200) | | 标题 |
| `content` | string (≤4000) | ✓ | 正文(episodic=prose, semantic=一句话, procedural=recipe) |
| `tags` | string[] (≤10) | | 检索标签(小写 slug) |
| `source_conversation_id` | string (`C-…`) | | 来源对话 |
| `source_decision_id` | string (`D-…`) | | 来源决策 |
| `source_run_id` | string | | 来源 run |
| `scope` | enum | | `user` / `project` / `global` |
| `expires_at` | date | | 过期时间(semantic 可永久,episodic 默认 90 天) |
| `pinned` | bool | | pinned 不参与自动 forget |
| `confidence` | number (0-1) | | 蒸馏置信度 |
| `created_at` | date-time | ✓ | |
| `updated_at` | date-time | | |

## Scope 语义

| Scope | 谁能读 | 用途 |
| :--- | :--- | :--- |
| `user` | 仅本人 | 个人偏好/风格 |
| `project` | 项目内所有协作者 | 项目级事实 |
| `global` | 跨项目 | cortex-agent framework 自身的事实 |

## 与其他目录关系

- 来源 → `conversations/C-NNN/` / `decisions/D-NNN/` / `runs/R-NNN/`
- 检索 → 通过 `tags` + `scope`(`/memory recall`)
- 清理 → `/memory forget`(尊重 `pinned` 和 `expires_at`)
- 蒸馏 → `/memory distill` 从 `conversations/` 抽出

## Sample

见 [`sample.json`](./sample.json) —— 一条 semantic 记忆(用户决策风格)。
