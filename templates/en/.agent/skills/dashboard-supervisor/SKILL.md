---
name: dashboard-supervisor
description: Manual and opt-in supervisor for the Cortex Agent Dashboard. Default disabled; `auto enable` makes the supervisor opt into lifecycle management.
---

# Dashboard Supervisor

The supervisor decides whether a project has a live Cortex Agent Dashboard. It is **default disabled** so legacy projects do not silently gain a background process.

## Manual commands

```bash
node .agent/skills/dashboard-supervisor/scripts/supervisor.js status              # report current supervisor state
node .agent/skills/dashboard-supervisor/scripts/supervisor.js ensure              # start the dashboard if not already running
node .agent/skills/dashboard-supervisor/scripts/supervisor.js stop [--if-idle]    # stop the dashboard; --if-idle refuses when an active workload is recorded
node .agent/skills/dashboard-supervisor/scripts/supervisor.js --help
```

## Opt-in auto trigger

```bash
node .agent/skills/dashboard-supervisor/scripts/supervisor.js auto status        # report enabled flag
node .agent/skills/dashboard-supervisor/scripts/supervisor.js auto enable        # atomic flip to enabled=true
node .agent/skills/dashboard-supervisor/scripts/supervisor.js auto disable       # atomic flip to enabled=false
```

`auto enable` records `transitioned_at` and `trigger_source`. It never impersonates runtime-continuity and never claims `automatic` mode by default.

## What the supervisor never does

- Schedules a self-sustaining background shutdown timer.
- Kills or signals the recorded dashboard PID.
- Impersonates the runtime-continuity `warm --auto` mode.
- Writes when the supervisor is disabled (except `auto enable` itself, which only writes the config flag).

## Excluded roles

`stop --if-idle` recognizes `dashboard-manager`, `dashboard-supervisor`, and `runtime-continuity` session IDs and never blocks on those alone.

## State files

- `.agent/runtime-evidence/dashboard-supervisor/state.json`
- `.agent/runtime-evidence/dashboard-supervisor/lock`
- `.agent/config/dashboard-automation.json`