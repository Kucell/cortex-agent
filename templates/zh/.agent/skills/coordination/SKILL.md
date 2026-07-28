---
name: coordination
description: 通过 Cortex Agent 公共 CLI 上报和查询厂商无关的多 Agent 任务协调状态。
---

# Agent Coordination

使用 `cortex-agent task` 与 `cortex-agent event`，不得直接修改 journal、
snapshot、lease、cursor 或 delivery 文件。先通过
`cortex-agent help task --json` 发现准确的机器契约。

只读操作不得产生副作用：

```bash
cortex-agent task status --project . --task T-001
cortex-agent task list --project .
cortex-agent event list --project . --task T-001
cortex-agent query coordination-tasks --project . --state READY_FOR_REVIEW
```

写命令通过 `--event-json` 把完整事件信封交给 Coordination Application
Service；Schema、Actor、Sequence、状态转换、Journal 和 Snapshot 规则只由
Application Service 维护。

ACK 只表示已收到通知，不代表批准 Decision、释放 Waitpoint，也不授权
commit、push、merge、publish、dispatch 或任务状态变更。

生产通知通过公共 CLI 运行：

```bash
cortex-agent notification pump --project . --consumer coordinator \
  --target coordinator:root --adapter codex --once
cortex-agent notification pump --project . --consumer coordinator \
  --target coordinator:root --adapter codex --watch
cortex-agent notification pump --project . --consumer coordinator \
  --target coordinator:root --adapter codex --status
cortex-agent notification pump --project . --consumer coordinator \
  --target coordinator:root --adapter codex --stop
```

`watch` 是单 consumer 前台常驻进程，使用文件事件加有界退避；`status`
只读，`stop` 幂等。宿主 capability 未验证时必须保留 pending 并报告
`CORTEX_READY_HOST_ADAPTER_PENDING`，不得伪造投递或 ACK。

运行态只保存在已 Git ignore 的 `.agent-runtime/coordination/`。Team Pack
只能分发 `.agent/coordination/README.md`、`notification-policy.json` 与
Schema；禁止分发 journal、snapshot、lease、cursor、delivery、socket、
PID、绝对路径、令牌或完整 prompt。
