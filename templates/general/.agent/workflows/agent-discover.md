---
name: agent-discover
description: Discover registered agents from .agent/agents/registry.yaml matching a query (by capability / domain / status). Read-only operation; no side effects.
mode: general
schema_version: 1
handoff_to_skill: null
handoff_to_subagent: null  # discover is read-only; no sub-agent needed
state_machine: [pending, running, done]
failure_recovery: log-and-notify  # D-002-4 拍板:read-only,失败仅记 error.json + inbox 通知
depends_on: [.agent/agents/registry.yaml exists]
produces: [.agent/runs/<run_id>/result.json, .agent/runs/<run_id>/error.json (on fail)]
---

# /agent discover — agent 发现

## 1. 入口

```text
/agent discover [query] [--capability <cap>] [--domain <d>] [--status available|all] [--limit 10]
```

## 2. 行为

按 query / capability / domain / status 在 `.agent/agents/registry.yaml` 中检索匹配的 agent 列表,按相关度 + 优先级排序后返回。

具体实现责任在 MS-003 收口,本文件仅声明 frontmatter + 状态列表 + 失败回滚规则。

## 3. 状态机(D-002-4 拍板:3 状态 + 失败回滚)

| 状态 | 进入条件 | 退出条件 |
| :--- | :--- | :--- |
| `pending` | workflow 被 dispatch,尚未启动 discover 查询 | 资源就绪,转 `running` |
| `running` | 开始检索 + 过滤 + 排序 | 完成 → `done(status=success)`;失败 → `done(status=failed)` |
| `done` | `running` 终止 | 写 `.agent/runs/<run_id>/{result,error}.json` + 通知父 agent |

**失败回滚规则**(read-only,无副作用):

1. 失败时,`running` → `done(status=failed)`,**不** 自动 retry
2. 必写 `.agent/runs/<run_id>/error.json`:`error_code` / `error_message` / `recoverable=true`(registry 文件损坏可重建)
3. 通知父 agent:inbox 写 `kind=alert, severity=warn, source=agent-discover`

## 4. 调用链

```text
/agent discover [query]
   ↓
读 .agent/agents/registry.yaml + .agent/agents/capabilities/*.yaml
   ↓
按 capability / domain / status 过滤
   ↓
按 priority + 最近活跃时间排序
   ↓
返回 top-K agent 列表
   ↓
写 .agent/runs/<run_id>/result.json
   ↓
通知父 agent(inbox)
```

## 5. 不变量

- **不写** `.agent/agents/registry.yaml`(只读,改 registry 走 `agent register` 子命令,本任务不实现)
- **不** 跨 project 检索(每个 project 隔离)
- **必** 区分 `internal` agents(本项目内)和 `external` agents(.agent/agents/external/,例 Claude Code / Codex / Codey)

## 6. 关联

- RFC: `docs/architecture/general-mode-design.md` §6.5
- D-002-3 拍板:Agent Registry(静态能力) vs Coordination Registry(运行时实例)边界
- D-002-4 拍板:`templates/general/.agent/README.md` §4
- 实现:MS-003(`lib/agents/discover.js` + `bin/cli.js agent discover` 子命令)
- 数据源:`templates/_base/.agent/agents/agent.schema.json`(M-001 publish)
