# Runtime State Contracts

These contracts are the shared input for state writers, Management API projections, CLI, optional MCP, Dashboard, Briefing, Handoff, Review, and audit views.

- `resource-event.schema.json` defines append-only resource activity and transitions.
- `log-cursor.schema.json` defines redacted target-side log positions and availability.
- `evidence-ref.schema.json` defines compact references to command, validation, artifact, runtime, log, or manual evidence.

Writers remain owned by workflows. Readers never mutate resource state, events, evidence, leases, Decisions, or Waitpoints. Bulky logs stay outside event records.
