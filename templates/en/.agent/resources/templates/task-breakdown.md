# Task Breakdown Preview

## Background

- Requirement: {user requirement or proposal name}
- Recommended entry: {/arch-design | /plan | /mission | /parallel | /start-task}
- Reason: {why this entry was selected}

## Breakdown Strategy

- Split dimension: {module boundary / API boundary / data-flow phase / risk level / other}
- Serial work: {tasks that must happen first and why}
- Parallel opportunities: {tasks that can run in parallel and why}

## Task List

| Task ID | Priority | Goal | Scope | Dependencies | Parallel | Recommended Agent |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| T-xxx | P1 | {one-sentence goal} | `{path}` | none | yes/no | `implementer` |

## Task Details

### T-xxx {Task Name}

- Goal: {specific result}
- Input context: {references, proposal, and code paths to read}
- Expected output: {code / docs / tests / config / validation report}
- Acceptance criteria:
  - {executable or checkable done condition}
- Dependencies: {which tasks must finish first}
- Parallel judgment: {why this can or cannot run in parallel}
- Recommended agent: `{planner|researcher|implementer|code-reviewer|documenter|coordinator}`
- Risks and blocking conditions: {risks or decisions requiring user confirmation}

## Batch Recommendation

```text
Batch 1:
  - T-xxx: {reason}

Batch 2:
  - T-yyy: depends on T-xxx
```

## Next Step

- Suggested command: `{next cortex-agent workflow command}`
