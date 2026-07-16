---
name: validate-<domain>
description: Validate a project-specific runtime, device, UI, integration, or workflow using explicit commands and evidence.
---

# Validate <Domain>

Use this template to create `.agent/skills/validate-<domain>/SKILL.md` when a project has domain-specific validation that generic lint, typecheck, or unit tests cannot cover.

## Preconditions

- List required services, devices, accounts, fixtures, or environment variables.
- State ownership and safety constraints.
- State what must not be touched.

## Commands

```bash
# setup or build command
# validation command
```

## Required Evidence

- Command output path
- Screenshot or runtime capture path
- Log or structured JSON result path
- Manual verification notes, if unavoidable
- For cross-machine or cross-process checks, the target-side log cursor and its timestamp source

Record the evidence in a machine-readable manifest when practical:

```json
{
  "type": "domain_validation_evidence",
  "status": "pass",
  "started_at": "2026-01-01T00:00:00Z",
  "finished_at": "2026-01-01T00:05:00Z",
  "artifacts": [
    {
      "type": "command_output",
      "path": "<artifact-path>"
    }
  ],
  "time_basis": {
    "target_id": "<target-id>",
    "timestamp_source": "target-system",
    "target_timestamp_utc": "2026-01-01T00:00:00Z",
    "controller_timestamp_utc": "2026-01-01T00:00:00Z",
    "clock_skew_ms": 0,
    "log_filter_start_utc": "2026-01-01T00:00:00Z"
  }
}
```

Omit `time_basis` for same-process checks that do not filter evidence by time. For cross-machine or cross-process checks, capture the cursor from the target immediately before the action under test; never substitute the controller clock.

## Pass Criteria

- Define exact counts, statuses, response fields, UI states, or log conditions required for PASS.
- Avoid screenshot-only success claims when structured evidence is available.

## Failure Preservation

- Preserve first failure evidence before restarting services.
- Record environment, timestamp source, and command arguments.
- If the target-side timestamp is unavailable, record the gap and do not claim a time-filtered check passed.

## Cleanup

- Describe how to stop services, reset fixtures, and remove temporary state.
