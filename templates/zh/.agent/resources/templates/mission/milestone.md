# Milestone: MS-xxx

## Goal

{一句话说明这个 milestone 要证明或交付什么。}

## Scope

- Feature(s): {F-xxx}
- Files/modules: {paths}
- Validation contract: `../validation-contract.json`

## Status

- State: Planned
- Started: {YYYY-MM-DD or blank}
- Completed: {YYYY-MM-DD or blank}
- Validator: {agent/person}

## Validation Results

| Assertion ID | Type | Blocking | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| VC-001 | test | true | NOT_RUN | {command output, diff reference, runtime evidence, or manual basis} |

## Command Evidence

| Command | Exit Code | Result |
| :--- | :--- | :--- |
| `{command}` | {0/1/not-run} | {summary} |

## Findings

### Passed

- {已验证的行为或契约}

### Failed

- {阻断性失败，如有}

### Waived

- {被 waiver 的 assertion、批准者、原因和 follow-up}

## Follow-Up Fix Tasks

- [ ] {进入下一阶段前需要完成的任务或修复}

## Decision

- Result: PASS / FAIL / WAIVED
- Next state: FIX_OR_ADVANCE

