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

### Cursor Capture Rules

1. Immediately before triggering the action under test, obtain the time from the target that produces the logs and use it as the log cursor for that validation run.
2. The cursor must come from the same time domain as the queried logs, such as the target service, target runtime, or log system.
3. When validation has multiple targets, capture and record a separate cursor for each target; do not reuse another component's cursor.
4. Controller time is diagnostic metadata only. It must not be used as the target cursor or as a substitute for a missing target cursor.
5. If a log query applies precision compensation or a lookback window, also record the actual `log_filter_start_utc`.

### Required Metadata

Cross-machine or cross-process evidence must include the following machine-readable data:

```json
{
  "type": "runtime_evidence_cursor",
  "target_id": "<target-id>",
  "timestamp_source": "target-system",
  "target_timestamp_utc": "2026-01-01T00:00:00Z",
  "controller_timestamp_utc": "2026-01-01T00:00:00Z",
  "clock_skew_ms": 0,
  "log_filter_start_utc": "2026-01-01T00:00:00Z"
}
```

- `target_id`: stable identifier for the target associated with this cursor.
- `timestamp_source`: specific source of the target time; it must not be `controller`.
- `target_timestamp_utc`: RFC 3339 UTC time obtained from the target.
- `controller_timestamp_utc`: controller UTC time from the same capture phase, optional.
- `clock_skew_ms`: controller time minus target time in milliseconds, when computable.
- `log_filter_start_utc`: actual lower bound used by the log query; it should equal `target_timestamp_utc` when no lookback window is applied.

### Unavailable Source And Result Status

If target time is unavailable, record the reason in `warnings` and preserve first-failure evidence. A blocking assertion that depends on time-filtered logs cannot pass and must be marked `partial` or `fail`. Do not fall back to controller time unless the validation contract explicitly permits alternative evidence that does not depend on time filtering.
