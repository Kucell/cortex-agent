# Progress Lock

Progress Lock prevents multiple agents from writing the same task or file scope at the same time.

It is a local file-lock protocol for Multi-Agent Coordinator. It does not attempt cross-machine coordination.

## Scope Format

| Scope | Meaning |
|---|---|
| `task:T-C05` | Lock a whole task |
| `mission:M-001` | Lock a mission |
| `file:src/auth.ts` | Lock a single file |

## Commands

```bash
node .agent/locks/scripts/progress-lock.js acquire --scope task:T-C05 --agent-id coordinator --ttl-seconds 300
node .agent/locks/scripts/progress-lock.js renew --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js release --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js list-held --agent-id coordinator
node .agent/locks/scripts/progress-lock.js inspect --scope task:T-C05
node .agent/locks/scripts/progress-lock.js sweep-expired
```

## Rules

- Lock creation uses exclusive file creation.
- Expired locks may be removed or acquired by another agent.
- Only the holder may renew or release an unexpired lock.
- Store only lock metadata, not source, diffs, or long logs.
