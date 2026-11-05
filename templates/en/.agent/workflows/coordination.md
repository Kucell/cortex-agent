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

A lease scope must name the smallest shared resource the action actually
writes. Device-level scopes are for real whole-machine actions only; where the
environment already provides instance-level isolation, use
`<class>:<device>:instance:<id>`, and let every action that touches the same
physical singleton (an interactive desktop, for example) reuse one scope string
so that scope itself serializes them. Pass `--scope-tree` on acquire when
parent and child scopes must exclude each other; the default stays an exact
key, where different strings never interact.

Codex host wakeup uses the official App Server `thread/resume` + `turn/start`
flow. When `CODEX_THREAD_ID` / `CORTEX_CODEX_THREAD_ID` or the host is
unavailable, retain pending delivery and use journal recovery as the reliable
path.
