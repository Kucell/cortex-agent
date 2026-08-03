---
name: agent-invoke
description: Invoke a registered agent from .agent/agents/registry.yaml to execute a task. May produce external side effects (HTTP call, file write to other system, etc.) — strict rollback required.
mode: general
schema_version: 1
handoff_to_skill: runtime-continuity  # 跨 host 续接:invoke 完可能切 host
handoff_to_subagent: null  # invoke 不必 spawn 新 sub-agent;target agent 自己可能是 sub-agent
state_machine: [pending, running, done]
failure_recovery: rollback-side-effect-and-notify  # D-002-4 拍板:外部副作用必先 rollback 再置 done
depends_on: [.agent/agents/registry.yaml has target agent, target agent status=available]
produces: [.agent/runs/<run_id>/{result,error,rollback}.json, .agent/inbox/<id>.yaml (notify), optional .agent/handoffs/H-NNN.json]
---

# /agent invoke — 跨 agent 调用

## 1. 入口

```text
/agent invoke <agent_id> <task_description> [--input <json>] [--timeout 300] [--on-fail rollback|notify]
```

## 2. 行为

从 `.agent/agents/registry.yaml` 找到目标 agent,根据其 `entry_point` / `protocol` 派发任务,等待结果或超时。

具体实现责任在 MS-003 收口,本文件仅声明 frontmatter + 状态列表 + 失败回滚规则。

## 3. 状态机(D-002-4 拍板:3 状态 + 失败回滚)

| 状态 | 进入条件 | 退出条件 |
| :--- | :--- | :--- |
| `pending` | workflow 被 dispatch,尚未定位 + 验证 target agent | 资源就绪,转 `running` |
| `running` | target agent check-in + 任务派发 + 等待结果 | 完成 → `done(status=success)`;失败 → 失败回滚 |
| `done` | `running` 终止 | 成功写 `result.json` + 通知父;失败必先 rollback 副作用再写 `error.json` |

**失败回滚规则**(严格,涉及外部副作用):

1. 失败时,`running` → `done(status=failed)`,**不** 自动 retry
2. **必**先 rollback 副作用:
   - HTTP call 已发 → 必发反向请求(若 target agent 提供 rollback endpoint)
   - 外部文件已写 → 必删(若 target agent 提供 rollback 协议)
   - 无 rollback endpoint → 必写 `rollback.json` 记录"未回滚的副作用" + 通知父 agent 由人介入
3. 必写 `.agent/runs/<run_id>/error.json`:`error_code` / `error_message` / `recoverable=false`(已发外部请求的不可自动 retry)
4. 通知父 agent:inbox 写 `kind=alert, severity=error, source=agent-invoke`

**rollback 失败二次回滚**:

- 副作用已发,但 rollback 失败 → `done(status=failed, rollback_status=failed)`,必写 `.agent/runs/<run_id>/rollback.json` 详细记录
- 父 agent 收到 inbox,必须升级为 `severity=critical`,由人介入修复

## 4. 调用链

```text
/agent invoke <agent_id> <task>
   ↓
.agent/agents/registry.yaml 查 <agent_id> → { entry_point, protocol, capabilities, rollback_endpoint }
   ↓
runtime-continuity skill(sessions/waitpoints 准备 + cross-host handoff 协议)
   ↓
派发任务(HTTP / CLI / 内部 function call)
   ↓
等结果 / 超时
   ↓
成功:写 .agent/runs/<run_id>/result.json + 可选 .agent/handoffs/H-NNN.json
失败:rollback 副作用 + 写 .agent/runs/<run_id>/{error,rollback}.json
   ↓
通知父 agent(inbox)
```

## 5. 不变量

- **不** invoke 状态非 `available` 的 agent
- **不** 跳过 rollback 步骤(D-002-4 拍板严格)
- **必** 验证 target agent 的 `capabilities` 包含 task 所需(否则 `error_code=capability_mismatch`)
- **必** 尊重 `timeout` 参数;超时后必 rollback

## 6. 关联

- RFC: `docs/architecture/general-mode-design.md` §6.5 / §6.6 / §6.4.1(跨 agent 续接)
- D-002-3 拍板:Agent Registry(静态能力) vs Coordination Registry(运行时实例)边界清晰
- D-002-4 拍板:`templates/general/.agent/README.md` §4
- 实现:MS-003(`lib/agents/invoke.js` + `bin/cli.js agent invoke` 子命令)
- 数据源:`templates/_base/.agent/agents/agent.schema.json`(M-001 publish)
