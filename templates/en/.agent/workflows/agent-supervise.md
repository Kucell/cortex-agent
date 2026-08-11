---
name: agent-supervise
description: Supervise governed Agent status / steer / abort entry points (P-005 / M-013 SP-006). All write actions must pass 4-gate verification before invoking.
type: procedure
applicable_to:
  - all
inputs:
  - launchId: "managed Agent's launchId"
  - reason: "action reason code (stale_progress / host_unresponsive / user_request / policy_violation / scope_expansion_detected / explicit_abort)"
  - idempotencyKey: "idempotency key [a-zA-Z0-9_-]{8,128}"
outputs:
  - status: progress summary (read-only)
  - steer: steer request envelope (with nonce)
  - abort: abort request envelope + preserve { worktree, journal, receipt, cleanupInvoked: false }
linked_skills: []
linked_rules:
  - commit-standards
linked_workflows:
  - launch-governed-agent
owner: cortex-agent
last_verified: 2026-08-11
status: stable
---

# Agent Supervise Workflow (/agent-supervise)

## Goal

Expose three supervise commands for governed agents, aligned with P-005 §8.2 (4-gate verification):

- `cortex-agent agent supervise status <launchId>` — read-only, returns progress summary
- `cortex-agent agent supervise steer  <launchId> <reason> <idempotencyKey>` — steer (recoverable)
- `cortex-agent agent supervise abort  <launchId> <reason> <idempotencyKey>` — abort (preserves worktree/journal/receipt)

## Usage

```text
cortex-agent agent supervise status L-001
cortex-agent agent supervise steer  L-001 stale_progress abc123def456
cortex-agent agent supervise abort  L-001 explicit_abort abc123def456
```

## 4-Gate Verification (P-005 §8.2)

`steer` and `abort` must pass all 4 gates simultaneously — missing any fails closed:

1. **capability** — host-protocol capability profile (`pi-rpc-capability.js`)
2. **lease** — current launch holds a valid lease
3. **operation** — Operation attempt still exists and is not settled
4. **authorization** — caller authorized (per policy + 4-gate decision record)

Any missing gate returns `GATE_VIOLATION` with the missing list.

## Idempotency-Key Rules

- Required, 8-128 chars `[a-zA-Z0-9_-]`
- Same key replayed within the same attempt must return idempotency conflict (no double-fire)
- Same key can be re-used across attempts

## Boundaries

- status **read-only**, no 4-gate, no side-effects
- steer **forbidden to expand scope**: only bounded reason template
- abort **preserves all evidence**: worktree / journal / receipt never cleaned
- CLI **rejects arbitrary stdin** and shell commands

## Related

- P-005 §5 (host adapter)
- P-005 §6 (RPC supervisor + control port)
- P-005 §7 (watchdog + steer boundaries)
- P-005 §8 (4-gate + public CLI)
- M-013 SP-006 / VC-010a / VC-011t