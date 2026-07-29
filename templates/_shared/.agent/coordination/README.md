# Coordination Contract

This directory contains Git-shareable coordination policy only. Runtime journals,
task snapshots, leases, cursors, delivery attempts, sockets, process identifiers,
and machine-specific paths belong under the Git-ignored `.agent-runtime/coordination/`
directory and must never be published through a Team Pack.

The journal is authoritative. Snapshots and Management API results are rebuildable
read-only projections; notification transports are optional acceleration layers.

The public notification runtime is operated through:

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

`watch` is a foreground, single-consumer process driven by filesystem events
with bounded backoff. `status` is read-only and `stop` is idempotent. The Codex
adapter uses the official Codex App Server with `CODEX_THREAD_ID`, or an
explicit `CORTEX_CODEX_THREAD_ID` outside a Codex task. It performs
`initialize`, `thread/resume`, and `turn/start`; a missing thread or unavailable
host returns `deferred` and retains pending delivery. Delivery never simulates
ACK.

`authorization-policy.json` is a project-controlled allowlist for workflow
gates that are not already registered as `.agent/missions/M-*/mission-plan.md`.
The CLI treats `--auth-context-json` as a local caller claim, not an independent
credential. A claim is accepted only when its gate is registered here or in the
mission registry; owner events additionally require a matching producer
session, durable lease and fencing token.
