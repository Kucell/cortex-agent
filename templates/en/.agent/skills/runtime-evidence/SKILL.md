---
name: runtime-evidence
description: Initialize and maintain runtime verification evidence files for /briefing, /ship, and validation-contract checks.
---

# Runtime Evidence

## Purpose

Provide standardized verification evidence files for `/briefing` and `/ship`. These files record how deeply a change was verified and feed risk assessment and phase gates.

## Output Files

The scripts write the following files under `.agent/metrics/` only when they do not already exist:

```text
.agent/metrics/
├── runtime-health.json
├── browser-verification.json
└── verification-summary.json
```

## Usage

```bash
node .agent/skills/runtime-evidence/scripts/init.js
node .agent/skills/runtime-evidence/scripts/generate-summary.js
```

## Workflow Integration

| Workflow | Integration |
|----------|-------------|
| `/briefing` | Reads `verification-summary.json` to show the latest verification state |
| `/ship` REVIEW | Runs verification templates and updates runtime/browser evidence |
| `/ship` CLEAN | Reads `verification-summary.json` and blocks release on failure |

## Cross-Machine Or Cross-Process Timestamp Source

When one machine or process triggers validation and another machine or process produces the logs, the log cursor must come from the **target that produces the logs**, not from the controller's local clock.

Examples:

- When a Mac controls a Windows UI MCP worker, `sinceUtc` should come from Windows Worker health or the Windows diagnostic service.
- When browser tests filter server logs, the cursor should come from the server log system or a server health endpoint.
- In multi-container validation, each component's evidence cursor should record that component's own timestamp source.

Runtime evidence should record:

- `timestamp_source`: for example `target-health`, `server-log`, `browser`, `controller`
- `target_timestamp_utc`: target-side timestamp
- `controller_timestamp_utc`: controller-side timestamp, optional for debugging skew
- `clock_skew_ms`: when computable

If the target-side timestamp is unavailable, record a warning and preserve first-failure evidence so a real product failure is not misclassified as clock skew.
