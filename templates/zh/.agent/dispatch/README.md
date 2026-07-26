# Dispatch Runtime 契约——Phase 0

本目录冻结 Cortex Agent v1.7.0 的三个标准术语。Phase 0 只提供契约和 fail-closed CLI 发现能力，不执行任务，也不启动后台进程。

## 词汇

### Dispatch（派发）

一次显式或由 Trigger 请求的执行尝试：把已经批准的任务交给执行 Agent，并记录 Run journal。未来的 Dispatch 实现必须先校验幂等、并发、Queue、Lock 和 Workflow Gate。

### Daemon（守护进程）

可选的本地用户空间协调进程，可以轮询 Queue 和 Decision，并请求 Dispatch。Daemon **默认关闭**，必须由用户显式启动，且不得绕过 Workflow 拥有的状态转换。

### Trigger（触发器）

声明式请求，告诉未来的 Daemon 何时可以考虑 Dispatch。Trigger 不是授权；`schedule`、`file_change` 和 `post_commit` 必须显式 opt-in。Phase 0 不创建也不消费 Trigger 记录。

## 架构边界

- Management API 保持查询和受控 Run journal 层，不是调度器。
- Coordinator 决定任务归属和交接；Dispatch 决定已批准执行何时启动。
- Decision、Waitpoint、Progress Lock、Queue、Mission、Worktree、Ship Gate 继续保持权威。
- Dashboard 控制动作不直接修改 Dispatch 状态。
- Phase 0 CLI 命令都是 stub，不写入运行时状态。

## CLI 表面

```bash
cortex-agent dispatch <task-id> [options]
cortex-agent daemon <start|stop|status> [options]
cortex-agent trigger <create|list|disable> [options]
```

使用 `cortex-agent help <command> --json` 查看发现信息。执行 Phase 0 stub 时，以 `PHASE_ZERO_STUB` 和退出码 `2` fail closed。

## Schema

- `trigger.schema.json`：声明式 Trigger 请求，并显式约束 opt-in。
- `daemon-state.schema.json`：未来可选 Daemon 的可恢复状态。
- `idempotency.schema.json`：未来 Dispatch 的持久去重记录。

## 非目标

Phase 0 不实现 `dispatch-state`、dry-run 规划、任务执行、Daemon 轮询、schedule、文件监听、post-commit 动作、自动 merge、Ship、部署或 Decision 解决。
