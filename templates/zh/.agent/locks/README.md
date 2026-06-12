# Progress Lock

Progress Lock 防止多个 agent 同时写同一个 task 或 file scope。

这是 Multi-Agent Coordinator 的本地文件锁协议，不尝试做跨机器协调。

## Scope 格式

| Scope | 含义 |
|---|---|
| `task:T-C05` | 锁住整个任务 |
| `mission:M-001` | 锁住一个 mission |
| `file:src/auth.ts` | 锁住单个文件 |

## 命令

```bash
node .agent/locks/scripts/progress-lock.js acquire --scope task:T-C05 --agent-id coordinator --ttl-seconds 300
node .agent/locks/scripts/progress-lock.js renew --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js release --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js list-held --agent-id coordinator
node .agent/locks/scripts/progress-lock.js inspect --scope task:T-C05
node .agent/locks/scripts/progress-lock.js sweep-expired
```

## 规则

- 锁创建使用独占文件创建。
- 过期锁可以被移除或被另一个 agent 获取。
- 未过期锁只能由持有者 renew 或 release。
- 只保存锁元数据，不保存源码、diff 或长日志。
