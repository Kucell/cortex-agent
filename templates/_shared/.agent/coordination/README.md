# Coordination Contract

This directory contains Git-shareable coordination policy only. Runtime journals,
task snapshots, leases, cursors, delivery attempts, sockets, process identifiers,
and machine-specific paths belong under the Git-ignored `.agent-runtime/coordination/`
directory and must never be published through a Team Pack.

The journal is authoritative. Snapshots and Management API results are rebuildable
read-only projections; notification transports are optional acceleration layers.
