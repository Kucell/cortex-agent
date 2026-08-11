---
name: agent-supervise
description: 监督受管 Agent 的 status / steer / abort 命令入口(P-005 / M-013 SP-006)。所有写操作前必须经过 4-gate 验证。
type: procedure
applicable_to:
  - all
inputs:
  - launchId: "受管 Agent 的 launchId"
  - reason: "动作原因代码 (stale_progress / host_unresponsive / user_request / policy_violation / scope_expansion_detected / explicit_abort)"
  - idempotencyKey: "幂等键 [a-zA-Z0-9_-]{8,128}"
outputs:
  - status: 返回 progress 摘要 (read-only)
  - steer: 引导请求 envelope (含 nonce)
  - abort: 中止请求 envelope + preserve { worktree, journal, receipt, cleanupInvoked: false }
linked_skills: []
linked_rules:
  - commit-standards
linked_workflows:
  - launch-governed-agent
owner: cortex-agent
last_verified: 2026-08-11
status: stable
---

# Agent Supervise 工作流 (/agent-supervise)

## 目标

提供受管 Agent 的三个监督命令入口,与 P-005 §8.2 (4-gate 验证)对齐:

- `cortex-agent agent supervise status <launchId>` — 只读,返回 progress 摘要
- `cortex-agent agent supervise steer  <launchId> <reason> <idempotencyKey>` — 引导(可挽救)
- `cortex-agent agent supervise abort  <launchId> <reason> <idempotencyKey>` — 终止(保留 worktree/journal/receipt)

## 使用方式

```text
cortex-agent agent supervise status L-001
cortex-agent agent supervise steer  L-001 stale_progress abc123def456
cortex-agent agent supervise abort  L-001 explicit_abort abc123def456
```

## 4-Gate 验证 (P-005 §8.2)

`steer` 与 `abort` 必须同时通过以下 4 个 gate,缺一不可:

1. **capability** — host-protocol capability profile (`pi-rpc-capability.js`)
2. **lease** — 当前 launch 持有有效 lease
3. **operation** — Operation attempt 仍存在且未 settled
4. **authorization** — 调用方被授权(由 policy + 4-gate decision 记录)

任何 gate 缺失,CLI fail-closed 返回 `GATE_VIOLATION` 并列出 missing gates。

## Idempotency-Key 规则

- 必填,8-128 字符 `[a-zA-Z0-9_-]`
- 同 key 在同一 attempt 内重复投递必须返回 idempotency conflict,不重复执行
- 跨 attempt 可以重新使用相同 key

## 边界

- status **只读**,无 4-gate 校验,无副作用
- steer **禁止扩 scope**:只能沿 bounded reason template 引导
- abort **保留所有物证**:worktree / journal / receipt 一律不清理
- CLI **不接受任意 stdin** 与 shell command

## 关联

- P-005 §5 (host adapter)
- P-005 §6 (RPC supervisor + control port)
- P-005 §7 (watchdog + steer 边界)
- P-005 §8 (4-gate + public CLI)
- M-013 SP-006 / VC-010a / VC-011t