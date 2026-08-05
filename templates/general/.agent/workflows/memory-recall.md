---
name: memory-recall
description: Recall distilled memories from .agent/memory/{episodic,semantic,procedural}/ that match a user query. Read-only operation; no side effects on memory/.
mode: general
schema_version: 1
handoff_to_skill: runtime-continuity
handoff_to_subagent: null  # recall is read-only; no sub-agent needed
state_machine: [pending, running, done]
failure_recovery: log-and-notify  # D-002-4 拍板:read-only,失败仅记 error.json + inbox 通知
depends_on: [memory-curator skill available, .agent/memory/ exists]
produces: [.agent/runs/<run_id>/result.json, .agent/runs/<run_id>/error.json (on fail)]
---

# /memory recall — 跨 session 记忆召回

## 1. 入口

```text
/memory recall <query> [--limit 5] [--type episodic,semantic,procedural] [--min-confidence 0.3]
```

## 2. 行为

按 query 在 `.agent/memory/{episodic,semantic,procedural}/` 中检索匹配的记忆条目,按相关度排序后返回。

具体实现责任在 MS-004 收口,本文件仅声明 frontmatter + 状态列表 + 失败回滚规则。

## 3. 状态机(D-002-4 拍板:3 状态 + 失败回滚)

| 状态 | 进入条件 | 退出条件 |
| :--- | :--- | :--- |
| `pending` | workflow 被 dispatch,但尚未启动 recall 查询 | 资源就绪,转 `running` |
| `running` | 开始检索 + 排序 + 写 result | 完成 → `done(status=success)`;失败 → `done(status=failed)` |
| `done` | `running` 终止 | 写 `.agent/runs/<run_id>/{result,error}.json` + 通知父 agent |

**失败回滚规则**(read-only,无副作用):

1. 失败时,`running` → `done(status=failed)`,**不** 自动 retry
2. 必写 `.agent/runs/<run_id>/error.json`:`error_code` / `error_message` / `recoverable=true`(query syntax error 可 retry)
3. 通知父 agent:inbox 写 `kind=alert, severity=warn, source=memory-recall`

## 4. 调用链

```text
/memory recall <query>
   ↓
runtime-continuity skill(sessions/waitpoints 检查 — 是否值得 recall)
   ↓
.memory recall 逻辑(MS-002 落 lib/memory/recall.js)
   ↓
返回 top-K 记忆条目(episodic/semantic/procedural)
   ↓
写 .agent/runs/<run_id>/result.json
   ↓
通知父 agent(inbox)
```

## 5. 不变量

- **不写** `.agent/memory/`(read-only,所有写操作走 `/memory distill`)
- **不删** 任何 memory 条目(走 `/memory forget`,本任务不实现)
- **不** 跨 project 检索(每个 project 隔离)

## 6. 关联

- RFC: `docs/architecture/general-mode-design.md` §6.5
- D-002-4 拍板:`templates/general/.agent/README.md` §4
- 实现:MS-002(`lib/memory/recall.js` + `bin/cli.js memory recall` 子命令)
- 数据源:`templates/_base/.agent/memory/memory.schema.json`(M-001 publish)
