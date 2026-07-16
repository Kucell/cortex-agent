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

## Pass Criteria

- Define exact counts, statuses, response fields, UI states, or log conditions required for PASS.
- Avoid screenshot-only success claims when structured evidence is available.

## Failure Preservation

- Preserve first failure evidence before restarting services.
- Record environment, timestamp source, and command arguments.

## Cleanup

- Describe how to stop services, reset fixtures, and remove temporary state.
