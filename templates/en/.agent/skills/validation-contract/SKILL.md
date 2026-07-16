---
name: validation-contract
description: Create, check, and summarize executable validation contracts for Mission Lite milestones and high-risk tasks before implementation begins.
---

# Validation Contract Skill

## Purpose

Use this skill when a task needs explicit validation criteria before implementation. It turns goals, scope, acceptance criteria, API contracts, and runtime expectations into structured assertions that a Worker can implement against and a Validator can check independently.

This skill is required for Mission Lite milestones and recommended for high-risk `/start-task` or `/ship` work.

## Modes

### CREATE

Create a `validation_contract` JSON object from a task, feature, or milestone description.

Inputs:

- Mission or task ID
- Feature or milestone scope
- Relevant files or modules
- Acceptance criteria
- Public API or documentation impact
- Runtime evidence needs, if any

Output:

```json
{
  "type": "validation_contract",
  "mission_id": "M-001",
  "task_id": "T-H25",
  "milestone_id": "MS-001",
  "scope": {
    "feature": "validation-contract-skill",
    "files": [
      ".agent/skills/validation-contract/SKILL.md",
      "templates/en/.agent/skills/validation-contract/SKILL.md",
      "templates/zh/.agent/skills/validation-contract/SKILL.md"
    ]
  },
  "assertions": [
    {
      "id": "VC-001",
      "type": "docs",
      "assertion": "The skill defines CREATE, CHECK, and SUMMARIZE modes.",
      "evidence": ".agent/skills/validation-contract/SKILL.md",
      "blocking": true
    }
  ]
}
```

### CHECK

Check an existing contract for completeness.

Required checks:

1. `type` is `validation_contract`.
2. At least one of `mission_id` or `task_id` is present.
3. `scope.feature` is present.
4. `assertions` is a non-empty array.
5. Every assertion has `id`, `type`, `assertion`, and `blocking`.
6. Every milestone has at least one `blocking: true` assertion.
7. Assertions with `type: "test"`, `typecheck`, or `lint` should include `command`.
8. Assertions without `command` must include `evidence` or a clear manual verification basis.
9. Public API changes must include at least one `api` or `docs` assertion.
10. Runtime claims must reference a runtime evidence source or template.
11. Cross-machine or cross-process runtime assertions must require the log cursor to be captured from the target that produces the logs immediately before the action under test. Controller time is not an acceptable substitute.
12. Time-filtered runtime assertions must require evidence for `target_id`, `timestamp_source`, `target_timestamp_utc`, and `log_filter_start_utc`; require a separate cursor for each target when more than one target produces logs.

Output a compact report:

```json
{
  "type": "validation_contract_check",
  "status": "PASS",
  "blocking_issues": [],
  "warnings": [],
  "coverage_gaps": []
}
```

### SUMMARIZE

Compress a contract for handoff or reviewer input.

The summary must include:

- Contract identity
- Scope
- Blocking assertions
- Commands to run
- Runtime or manual evidence still needed
- Known waivers, if any

## Assertion Types

| Type | Use |
| :--- | :--- |
| `test` | Unit, integration, or end-to-end test command |
| `typecheck` | Type checker command |
| `lint` | Static lint or formatting command |
| `api` | API, schema, payload, or interface contract |
| `docs` | Documentation synchronization requirement |
| `runtime` | Logs, metrics, traces, browser verification, or manual runtime evidence |
| `security` | Authentication, authorization, secret, supply-chain, or dangerous API check |
| `manual` | Human verification that cannot yet be automated |

## Contract Rules

- Define validation before implementation begins.
- Prefer executable commands where practical.
- Keep assertions small and independently checkable.
- Mark only true release blockers as `blocking: true`.
- Do not hide uncertainty; record it as a warning, coverage gap, or manual assertion.
- If an assertion is waived, record the reason, approver, and follow-up task.
- Validators must check the contract against code, diff, command output, and runtime evidence. Worker explanations are not evidence.
- For cross-machine or remote UI validation, include a blocking runtime assertion that evidence cursors come from the target system timestamp when logs are filtered by time.
- If target time is unavailable, a blocking assertion that depends on time-filtered logs cannot pass. Record the gap and use `partial` or `fail` unless the contract defines alternative evidence that does not depend on time filtering.

## Cross-Machine Runtime Assertion

Use a blocking assertion like this when evidence is filtered by time across machine or process boundaries:

```json
{
  "id": "VC-002",
  "type": "runtime",
  "assertion": "Cross-machine evidence uses a target-side timestamp captured immediately before the action under test as the log cursor.",
  "evidence": ".agent/metrics/runtime-health.json",
  "evidence_requirements": [
    "target_id",
    "timestamp_source",
    "target_timestamp_utc",
    "log_filter_start_utc"
  ],
  "blocking": true
}
```

The referenced evidence must identify each target separately. `timestamp_source` must identify a target-side source and must not be `controller`; `controller_timestamp_utc` and `clock_skew_ms` may be included as diagnostic metadata.

## Minimal Template

```json
{
  "type": "validation_contract",
  "task_id": "T-xxx",
  "scope": {
    "feature": "short-feature-name",
    "files": []
  },
  "assertions": [
    {
      "id": "VC-001",
      "type": "test",
      "command": "npm test -- feature",
      "assertion": "The feature satisfies the primary success path.",
      "blocking": true
    }
  ]
}
```
