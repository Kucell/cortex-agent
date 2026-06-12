# Agent Registry

Agent Registry 记录哪些 agent 处于活跃状态、它们拥有哪个 task 或 mission、使用什么 model/session、占用哪些文件、有哪些 pending artifacts，以及最近的协调事件。

该目录属于 Multi-Agent Coordinator。它在 `.agent/` 下保存运行态协调状态，不应作为源码或 diff 归档。

## 文件

| 文件 | 作用 |
|---|---|
| `agents.json` | 当前 registry 状态和 append-only event log |
| `agent-registry.schema.json` | registry 结构的 JSON schema |
| `scripts/agent-registry.js` | 零依赖辅助脚本，支持 check-in、heartbeat、check-out、active listing、conflict detection 和 stale marking |

## 命令

```bash
node .agent/registry/scripts/agent-registry.js check-in \
  --agent-id implementer-001 \
  --role implementer \
  --model codex \
  --task-id T-C03 \
  --session-id s-001 \
  --owned-files src/a.ts,src/b.ts

node .agent/registry/scripts/agent-registry.js heartbeat --agent-id implementer-001
node .agent/registry/scripts/agent-registry.js check-out --agent-id implementer-001 --status completed
node .agent/registry/scripts/agent-registry.js list-active --task-id T-C03
node .agent/registry/scripts/agent-registry.js get-conflicts --task-id T-C03 --owned-files src/a.ts
node .agent/registry/scripts/agent-registry.js mark-stale --ttl-seconds 300
```

## 规则

- 只保存路径、状态、时间戳和 artifact 引用。
- 不保存源码、完整 diff、PRD 或长命令输出。
- `running` 和 `paused` 视为 active status。
- 过期 active agent 可以标记为 `failed`；handoff recovery 由 Coordinator 处理。
