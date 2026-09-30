# PlatformHealth v1

> **Status**: M-041 MS-001 baseline

## Purpose

PlatformHealth is the canonical read-only health/status contract shared across Cortex platform components.

It is designed for:

- CLI
- Dashboard
- MCP
- operators
- external platform tooling

It is not a new source of truth.

## Status model

```text
healthy
degraded
unhealthy
unknown
```

Aggregation priority:

```text
unhealthy > degraded > unknown > healthy
```

An empty component set is `unknown`.

Unknown must never be silently interpreted as healthy.

## Envelope

```text
PlatformHealth
  schema_version
  generated_at
  overall
  components[]
```

Each component carries:

- id
- kind
- status
- observed_at
- producer identity
- checks
- evidence refs
- redacted flag

## Component kinds

Initial kinds:

- package
- protocol
- project
- daemon
- permission
- runtime
- regression
- extension

The list is closed in v1 and can evolve through protocol versioning.

## Producer model

Subsystems contribute through explicit producer functions.

```text
subsystem owner
   -> HealthProducer
       -> HealthComponent[]
           -> PlatformHealth aggregation
```

Producer output is a projection. The producer does not acquire mutation authority over its source subsystem.

## Data safety

Check details are intentionally bounded to scalar metadata.

Nested arbitrary objects are rejected so health projections do not become a side channel for prompts, secrets, stack traces or private project state.

Each component also declares whether the projected data is redacted.

## Reference producer

M-041 MS-001 includes a package/protocol producer.

It reports:

- root export availability;
- package publication readiness;
- canonical protocol availability.

Private `0.0.0` workspace packages are currently reported as `degraded`, not unhealthy: their contracts exist, but public publication has not yet been enabled.

## Future producers

- Connected Project producer — MS-003
- Control Service daemon producer — MS-005
- Permission enforcement producer — MS-006
- RuntimeEndpoint producer — MS-007
- Regression debt producer — MS-010
- Aggregation and CLI/Dashboard/MCP UX — MS-011
