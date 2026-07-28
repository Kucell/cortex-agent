# Coordination Workflow

1. Create and assign a Coordination Task through the public CLI.
2. The assignee accepts the declared repository-relative ownership scope.
3. Heartbeats and ordinary progress remain journal-only.
4. Input requests, blockers, failures, and ready-for-review events carry
   structured evidence and the appropriate notification policy.
5. The Coordinator ACKs delivery, independently validates evidence, then uses
   the owning workflow to complete, revise, cancel, or safely take over.
6. For low-latency delivery, explicitly start
   `cortex-agent notification pump ... --watch`; use the same
   consumer/target/adapter identity for `--status` or idempotent `--stop`.

Never infer completion from process exit or terminal silence. Never treat ACK as
authorization. Read-only status, list, watch, Management API, and MCP queries
must not mutate stale state, leases, Decisions, or Waitpoints.

Until the host wakeup capability is verified, keep the status at
`CORTEX_READY_HOST_ADAPTER_PENDING` and retain journal recovery as the reliable
path.
