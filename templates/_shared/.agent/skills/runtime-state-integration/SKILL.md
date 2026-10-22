---
name: runtime-state-integration
description: Assess whether a feature is stateful or exempt, create and check its seven-part Runtime State Integration Contract, and summarize validation gaps. Use during architecture, planning, Mission, implementation review, or shipping of features with lifecycle, persistence, side effects, recovery, query surfaces, or durable evidence.
---

# Runtime State Integration

Use the deterministic script to classify features and fail closed on missing runtime integration. Pass JSON by `--input`; optionally persist JSON with `--output`.

## Modes

### ASSESS

Classify feature characteristics:

```bash
node .agent/skills/runtime-state-integration/scripts/index.js assess --input feature.json
```

The result is `stateful` if any stateful signal is true. It is `exempt` only if all four exemption guarantees are explicitly true. Ambiguous inputs fail closed as `stateful`.

### CREATE

Create a normalized contract from a feature declaration:

```bash
node .agent/skills/runtime-state-integration/scripts/index.js create --input feature.json --output contract.json
```

Creation preserves supplied contract sections and reports gaps; it does not invent evidence or integration claims.

### CHECK

Validate classification and all seven sections:

```bash
node .agent/skills/runtime-state-integration/scripts/index.js check --input contract.json
```

Exit nonzero when classification is missing/invalid, an exemption is unjustified, or any required stateful section is absent or incomplete. Treat prose without evidence references as a gap.

### SUMMARIZE

Produce a stable compact handoff:

```bash
node .agent/skills/runtime-state-integration/scripts/index.js summarize --input contract.json
```

Include classification, section coverage, blocking gaps, evidence references, consumers, and status.

## Contract rules

- Require `resource`, `state_machine`, `event_journal`, `evidence`, `write_gate`, `query_projection`, and `consumer_surface` for stateful features.
- Keep `.agent/` state/events/evidence authoritative and Management API a read-only projection.
- Require risky writes to retain workflow, owner, Decision, and Waitpoint gates.
- Require query and consumer declarations to be read-only; never accept query-side repair or cleanup.
- Require target-side timestamps and one log cursor per producer for cross-target time-filtered logs.
- Preserve failure and recovery history; redact secrets before persistence.
- Use script output and referenced artifacts as evidence. Agent prose alone is not evidence.
