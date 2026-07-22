---
name: phase-gate
description: State machine gate checker for workflow phase transitions. Ensures hard preconditions are met before moving to next phase.
---
# Phase Gate Skill

## Goal
Enforce state machine discipline in workflows (especially `/ship`) by validating preconditions before each phase transition.

## State Machine Definitions

### /ship Workflow States
```
PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE
```

### Phase Transition Rules

| Transition | Preconditions | Validation |
|------------|---------------|------------|
| **START → PLAN** | - Task description exists<br>- Architecture constraints loaded | Check `.agent/rules/architecture-design.md` exists |
| **PLAN → EXECUTE** | - Implementation plan written<br>- File paths identified<br>- Architecture pre-audit passed | Verify plan file exists<br>Run `architecture-guard` audit |
| **EXECUTE → LINT** | - Code files written/edited<br>- No uncommitted changes in constraints | Check files exist at planned paths<br>`git status` shows modifications |
| **LINT → REVIEW** | - Linter checks passed<br>- No hardcoded secrets detected | Exit code 0 from pre-commit-check.sh<br>No security violations |
| **REVIEW → COMMIT** | - Code review completed<br>- No blocking issues (❌ Must Fix) | Review report exists<br>Parse report for blocking issues |
| **COMMIT → DONE** | - Changes committed<br>- Task progress updated | `git log -1` shows new commit<br>task-progress.md updated |

## When to Use

Invoke this skill at **every phase transition** in `/ship` workflow:

```yaml
# Example in workflows/ship.md
phases:
  - name: PLAN
    agent: planner
    gate_check: phase-gate --from START --to PLAN

  - name: EXECUTE
    agent: implementer
    gate_check: phase-gate --from PLAN --to EXECUTE

  - name: LINT
    script: .agent/hooks/pre-commit-check.sh
    gate_check: phase-gate --from EXECUTE --to LINT

  - name: REVIEW
    agent: code-reviewer
    gate_check: phase-gate --from LINT --to REVIEW

  - name: COMMIT
    workflow: /commit
    gate_check: phase-gate --from REVIEW --to COMMIT

  - name: DONE
    action: update-task-status
    gate_check: phase-gate --from COMMIT --to DONE
```

## How to Use

### Manual Invocation
When you are about to transition phases in `/ship` workflow:

1. **Identify current phase and target phase**
2. **Check preconditions** based on the table above
3. **Report gate status**:
   - ✅ **PASS**: All preconditions met, safe to proceed
   - ❌ **BLOCK**: Missing preconditions, must fix before continuing
   - ⚠️ **WARN**: Optional preconditions missing, proceed with caution

### Output Format

```yaml
Gate Check: PLAN → EXECUTE
Status: ❌ BLOCK
Preconditions:
  ✅ Implementation plan written: .agent/plans/feature-x.md
  ❌ Architecture pre-audit: FAILED (circular dependency detected)
  ✅ File paths identified: 3 files

Blocking Issues:
  - Circular dependency: services/auth ↔ services/user
  - Suggested fix: Introduce shared interface layer

Action Required: Fix architecture violations before proceeding to EXECUTE phase
```

## Max Retry Integration

This skill enforces `max_retry: 2` from `reasoning-config.yml`:

- If a phase fails validation **2 times**, block further retries
- Report failure to user and request manual intervention
- Example: If LINT fails twice (e.g., persistent ESLint errors), stop automatic retry and ask user to fix

## Rollback Support

If `auto_rollback: true` in `reasoning-config.yml`:

- On gate failure, automatically revert to last stable state
- Example: If REVIEW → COMMIT fails (blocking issues found), rollback to REVIEW phase
- Preserve all outputs from failed phase for debugging

## Error Handling

```yaml
Gate Check: EXECUTE → LINT
Status: ❌ BLOCK (Retry 2/2)
Error: Linter check failed with 5 errors

Max retry limit reached. Blocking automatic retry.
Manual intervention required.

Options:
  1. Fix linter errors manually
  2. Skip linter for this commit (not recommended)
  3. Adjust .eslintrc.js rules if false positives
```

## Integration with Hooks

Phase-gate works **in parallel** with PostToolUse hooks:

- **Hooks (Layer 1)**: Deterministic checks on individual file writes
- **Phase-gate (Workflow level)**: State machine checks across multiple files

Example:
- Hook blocks write of `auth.ts` if it has linter errors
- Phase-gate blocks EXECUTE → LINT transition if ANY file in the changeset has issues

## Success Criteria

Gate checks should:
- ✅ Prevent skipping critical phases (e.g., review before commit)
- ✅ Catch missing preconditions early (e.g., no plan before execution)
- ✅ Integrate seamlessly with `max_retry` and `auto_rollback`
- ✅ Provide clear, actionable error messages
