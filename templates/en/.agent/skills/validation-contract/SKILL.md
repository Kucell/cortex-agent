---
name: validation-contract
description: Create, check, and summarize executable validation contracts for Mission Lite milestones and high-risk tasks before implementation begins.
area: agent-tuning
summary: Create, check, and summarize executable validation contracts for Mission Lite milestones and high-risk tasks before implementation begins.
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
13. Milestones with 4 or more total assertions must include at least one `drift-check` assertion.

The `drift-check` rule (item 13) applies only to **newly created** validation contracts. Existing contracts are not retroactively bound; if a legacy contract is otherwise valid but lacks a `drift-check`, it may be explicitly waived. Record the waiver with: reason, approver, and follow-up task (see Contract Rules below).

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
| `drift-check` | Long-running task drift checkpoint: at a defined point (e.g., task midpoint or milestone boundary), re-read the initial Spec/requirement and verify the current output still matches its audience, scope, and non-goals; block on silent deviation |

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

## Drift-Check Assertion

Use a `drift-check` assertion for long-running tasks that can silently drift from the initial requirement. The checkpoint re-reads the initial Spec/requirement (e.g., `.agent/specs/<spec-id>/spec.md`) at a defined point — task midpoint, milestone boundary, or before handoff — and verifies the current output still matches its audience, scope, and non-goals. Block on deviation rather than letting the task continue amplifying drift.

```json
{
  "id": "VC-DRIFT-001",
  "type": "drift-check",
  "assertion": "任务进度过半时，产出与 .agent/specs/<spec-id>/spec.md 的受众/范围/非目标一致，无静默偏离。",
  "evidence": ".agent/specs/<spec-id>/spec.md + 当前产出 diff",
  "blocking": true
}
```

A milestone with 4 or more assertions must include at least one `drift-check` (CHECK rule 13). This requirement binds only new contracts; legacy contracts may use an explicit waiver: reason + approver + follow-up task.

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
