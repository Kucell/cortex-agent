# Coordination Contract

This directory contains Git-shareable coordination policy only. Runtime journals,
task snapshots, leases, cursors, delivery attempts, sockets, process identifiers,
and machine-specific paths belong under the Git-ignored `.agent-runtime/coordination/`
directory and must never be published through a Team Pack.

The journal is authoritative. Snapshots and Management API results are rebuildable
read-only projections; notification transports are optional acceleration layers.

`authorization-policy.json` is a project-controlled allowlist for workflow
gates that are not already registered as `.agent/missions/M-*/mission-plan.md`.
The CLI treats `--auth-context-json` as a local caller claim, not an independent
credential. A claim is accepted only when its gate is registered here or in the
mission registry; owner events additionally require a matching producer
session, durable lease and fencing token.
