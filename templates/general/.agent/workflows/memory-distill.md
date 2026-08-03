---
name: memory-distill
description: Distill raw session / conversation state into structured memory records (.agent/memory/{episodic,semantic,procedural}/). Has write side effects; rollback required on failure.
mode: general
schema_version: 1
handoff_to_skill: null
handoff_to_subagent: memory-curator  # 唯一首发 sub-agent(RFC §6.6 §12 #5 拍板)
state_machine: [pending, running, done]
failure_recovery: rollback-draft-and-notify  # D-002-4 拍板:有写副作用,失败必删 draft + 通知
depends_on: [memory-curator sub-agent available, .agent/memory/ exists, .agent/conversations/ 或 .agent/sessions/ 存在]
produces: [.agent/memory/{episodic,semantic,procedural}/<id>.md, .agent/runs/<run_id>/{result,error,draft}.json]
---

# /memory distill — 记忆蒸馏

## 1. 入口

```text
/memory distill [--source sessions|conversations] [--since <ISO>] [--max-records 20] [--type episodic,semantic,procedural]
```

## 2. 行为

把最近 N 个 session 或 conversation 中的关键事件 / 事实 / 习惯,蒸馏为结构化 memory 记录,落到 `.agent/memory/{episodic,semantic,procedural}/`。

具体实现责任在 MS-002 收口,本文件仅声明 frontmatter + 状态列表 + 失败回滚规则。

## 3. 状态机(D-002-4 拍板:3 状态 + 失败回滚)

| 状态 | 进入条件 | 退出条件 |
| :--- | :--- | :--- |
| `pending` | workflow 被 dispatch,memory-curator sub-agent 尚未领取任务 | sub-agent check-in,转 `running` |
| `running` | memory-curator 拉源数据 + 生成 draft + 校验 + 落盘 | 完成 → `done(status=success)`;失败 → 失败回滚 |
| `done` | `running` 终止 | 成功写 `<id>.md` + `result.json`;失败删 draft + 写 `error.json` + 通知父 |

**失败回滚规则**(有写副作用,严格):

1. 失败时,`running` → `done(status=failed)`,**不** 自动 retry
2. 必删 draft 文件:`.agent/memory/{type}/<draft_id>.md`(若已创建)
3. 必写 `.agent/runs/<run_id>/error.json`:`error_code` / `error_message` / `recoverable=false`(memory 写失败通常不可自动 retry)
4. 通知父 agent:inbox 写 `kind=alert, severity=error, source=memory-distill`,要求父 agent 决定重试还是放弃

**半成品处理**:

- 任何 `.agent/memory/{type}/<id>.md` 若 schema 校验失败,文件存在但**不** 被 registry 索引;下次 run 会检测到并清理

## 4. 调用链

```text
/memory distill
   ↓
memory-curator sub-agent(check-in → running)
   ↓
拉源数据(.agent/sessions/ 或 .agent/conversations/)
   ↓
LLM 提取关键事件 / 事实 / 习惯
   ↓
生成 draft + schema 校验
   ↓
写 .agent/memory/{type}/<id>.md + 更新 memory/index.yaml
   ↓
写 .agent/runs/<run_id>/result.json
   ↓
通知父 agent(inbox)
```

## 5. 不变量

- **不** 删任何已存在的 memory 记录(走 `/memory forget`,本任务不实现)
- **不** 跨 project 写 memory
- **必** schema 校验通过才落盘(否则写到 `runs/<id>/drafts/` 留作调试)
- **必** 在 `memory/index.yaml` 登记新条目

## 6. 关联

- RFC: `docs/architecture/general-mode-design.md` §6.5 / §6.6
- D-002-4 拍板:`templates/general/.agent/README.md` §4
- 实现:MS-002(`lib/memory/distill.js` + `bin/cli.js memory distill` 子命令 + memory-curator sub-agent)
- 数据源:`templates/_base/.agent/memory/memory.schema.json`(M-001 publish)
