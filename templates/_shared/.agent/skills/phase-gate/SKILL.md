---
name: phase-gate
description: State machine gate checker for workflow phase transitions. Ensures hard preconditions are met before moving to next phase.
area: agent-tuning
summary: State machine gate checker for workflow phase transitions. Ensures hard preconditions are met before moving to next phase.
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

## Mechanical Runner (首选路径)

> **规则**：判断一次转换能否通过，**以 runner 的 exit code 为准**，不要靠阅读散文自行判断。

本 skill 自带可执行实现 `scripts/gate.js`，把上表的散文前置条件变成有 exit code 的机械检查：

```bash
# 基本用法
node .agent/skills/phase-gate/scripts/gate.js --from LINT --to REVIEW --task T-001

# 只跑 lint 门禁（/ship Phase 2 用）
node .agent/skills/phase-gate/scripts/gate.js --lint-only --task T-001 \
  --write-lint-result .agent/artifacts/T-001/lint-result.json

# 复用已写入的 lint 结果，避免重复执行
node .agent/skills/phase-gate/scripts/gate.js --from LINT --to REVIEW \
  --lint-result .agent/artifacts/T-001/lint-result.json

# 机器可读输出
node .agent/skills/phase-gate/scripts/gate.js --from REVIEW --to COMMIT --json
```

| Exit code | 含义 | 动作 |
|---|---|---|
| `0` | PASS — 全部 required 检查通过 | 推进到下一阶段 |
| `1` | BLOCK — 至少一个 required 检查失败 | 修复后重试（上限 2 次） |
| `2` | USAGE — 参数错误或未知转换 | 修正命令，不计入重试 |

### 为什么需要 runner

`.agent/hooks/pre-commit-check.sh` 是 **Claude Code PostToolUse 钩子**：它从 stdin 的
JSON payload 里取目标文件路径。直接执行它（例如 `bash pre-commit-check.sh`）会因为
没有 payload 而**对任何输入都 exit 0**——门禁形同虚设。

runner 负责构造它真正期待的 payload：

```json
{"tool_input": {"file_path": "<相对路径>"}}
```

并逐个文件执行、聚合结果。同时 runner **fail-closed**：

- 找不到 `pre-commit-check.sh` → FAIL（不静默放行）
- `jq` 缺失（钩子将无法解析 payload）→ FAIL（不静默放行）
- 只报告 WARN/SKIP 的检查不阻断；只有 required + FAIL 才阻断

### 输出格式

runner 在人类可读输出之后附带机器可解析 JSON：

```json
{
  "type": "phase_gate_verdict",
  "from": "REVIEW",
  "to": "COMMIT",
  "verdict": "FAIL",
  "checks": [
    {
      "id": "no_blocking_issues",
      "severity": "required",
      "status": "FAIL",
      "detail": "存在 2 个阻断项：..."
    }
  ],
  "blocking_issues": ["no_blocking_issues: 存在 2 个阻断项：..."],
  "warnings": [],
  "generated_at": "2026-10-21T11:54:08.065Z"
}
```

### 常用参数

| 参数 | 用途 |
|---|---|
| `--from <PHASE>` / `--to <PHASE>` | 转换两端 |
| `--task <id>` | 任务 / mission id，用于定位 plan、review verdict、产物目录 |
| `--plan <path>` | 显式指定计划文件 |
| `--review-verdict <path>` | 显式指定 review verdict JSON |
| `--architecture-audit <path>` | 架构预审报告（缺失时该检查为 SKIP，不阻断） |
| `--lint-result <path>` | 复用既有 lint 结果；文件不存在则回退为现场执行 |
| `--write-lint-result <path>` | 写出 lint 结果工件 |
| `--lint-only` | 只跑 lint 门禁 |
| `--json` | 只输出 JSON |

## Manual Invocation（人工核对路径）

> 手动核对仅作为 runner 不可用时的兜底；**优先执行 `scripts/gate.js`**。

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
