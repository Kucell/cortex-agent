---
name: dashboard-supervisor
description: Manual and opt-in supervisor for the Cortex Agent Dashboard. Default disabled; `auto enable` makes the supervisor opt into lifecycle management.
---

# Dashboard Supervisor

The supervisor decides whether a project has a live Cortex Agent Dashboard. It is **default disabled** so legacy projects do not silently gain a background process.

## Manual commands

```bash
cortex-agent dashboard status --project <path>
cortex-agent dashboard ensure --project <path>
cortex-agent dashboard stop --project <path> [--if-idle]
cortex-agent dashboard --help --project <path>
```

## Opt-in auto trigger

```bash
cortex-agent dashboard auto status --project <path>
cortex-agent dashboard auto enable --project <path>
cortex-agent dashboard auto disable --project <path>
```

`auto enable` fixes the owner project root, starts one detached Supervisor daemon, and records `transitioned_at` plus `trigger_source`. The daemon polls the read-only Management API projection, starts the existing Dashboard server for real workloads, and stops it after the configured idle grace.

The public CLI owns the runtime implementation. The project Skill contains policy, contracts, classifiers, and a compatibility entry that delegates back to `cortex-agent dashboard`.

## What the supervisor never does

- Starts when `enabled=false`; disabled `ensure` exits `0` with zero writes and zero processes.
- Signals an unverified recorded PID; the daemon owns and signals only its own Dashboard child.
- Impersonates the runtime-continuity `warm --auto` mode.
- Exposes a Dashboard lifecycle writer over MCP.

## Excluded roles

`stop --if-idle` re-queries Management API before signaling the daemon. `dashboard-manager`, `dashboard-supervisor`, and `runtime-continuity` never count as real work.

## State files

- `.agent/runtime-evidence/dashboard-supervisor/state.json`
- `.agent/runtime-evidence/dashboard-supervisor/lock`
- `.agent/config/dashboard-automation.json`
