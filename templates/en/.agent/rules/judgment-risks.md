---
title: "判断力风险规则 (Judgment Risks)"
description: "把判断力的四类失败模式（Silent Failure、Spec Drift、Sycophancy、Cascade Failure）从隐式机制升级为显式规则：四类风险的定义、识别信号与针对性检查一表打尽；Sycophancy 三条硬约束（结论可溯源 / 错误前提拒绝 / 显式置信度）封堵最危险的失败模式；按任务类型触发检查清单；挂接 validation-contract 的 drift-check 断言与 parallel / mission / worktree 的下游独立验证。"
type: rule
scope: L1
applicable_to:
  - all
linked_workflows:
  - .agent/workflows/parallel.md
  - .agent/workflows/mission.md
  - .agent/workflows/worktree.md
linked_skills:
  - .agent/skills/validation-contract/SKILL.md
linked_rules:
  - .agent/rules/ai-behavior.md
owner: Kucell
last_verified: 2026-08-19
status: stable
---
<!-- EN translation pending: structural English skeleton; detailed Chinese content below is the source of truth. TODO: translate the four-risk table, task-type checklist table, and hooks section into English. -->

# Judgment Risks Rule

The four judgment failure modes must be explicitly identified and guarded against — never rely on implicit mechanisms ("tests will catch it", "milestones will intercept it"). This rule defines the four risks, three Sycophancy hard constraints, task-type-specific checklists, and integration points.

## The Four Failure Modes

| 风险 (Risk) | 定义 (Definition) | 识别信号 (Signals) | 针对性检查 (Targeted check) |
| :--- | :--- | :--- | :--- |
| Silent Failure | 格式正确但底层数据/逻辑错误 | 断言全绿但假设未核对；数字来源不明 | 数据分析任务：逐条核对假设、数据来源、口径 |
| Spec Drift | 长任务中产出逐渐偏离初始需求 | 中途产出与 spec.md 字段不一致 | 长任务：设置 drift-check 检查点，回读初始 Spec |
| Sycophancy | 基于错误前提生成"自信"错误结论 | 用户断言被直接采纳且无证据引用；无置信度声明 | 结论必须引用证据；错误前提必须拒绝并说明原因 |
| Cascade Failure | 多 Agent 协作中错误逐级放大 | 下游直接采信上游结论，无独立验证 | 下游必须独立验证上游输出；收口时交叉复核 |

**Shared bottom line**: whenever any of the four risks is identified, "proceeding while broken" is forbidden — return to the failing node, fix it, then continue. Prefer an explicit block over silent masking.

## Sycophancy Hard Constraints

> Scope: deliverables only. Stay collaborative with the user, but "rejecting a false premise" is not "rejecting the user" — first point out the conflict, then offer the correct option.

1. **Conclusions must be traceable**: any conclusive statement in a deliverable must cite verifiable evidence (file, command output, data, source). Fast interactive Q&A outside deliverables does not require per-statement citations, but must not dress up guesses with confident wording.
2. **Reject false premises**: when a user premise conflicts with known facts, point out the conflict first; never keep generating on top of a false premise.
3. **Explicit confidence**: when full verification is impossible, explicitly state the uncertainty and what verification is needed; never dress up guesses with confident wording.

## Task-Type Checklist

| 任务类型 (Task type) | 检查重点 (Check focus) | 必做动作 (Mandatory action) |
| :--- | :--- | :--- |
| 数据分析 (Data analysis) | 假设 / 数据来源 / 口径 | 逐条核对假设、数据来源与统计口径；结论与数字一一对应到来源 |
| 编程 (Coding) | Edge Case | 核对边界条件、空值、并发、异常路径；不只验证 happy path |
| 长任务 (Long tasks) | drift | 任务过半与里程碑边界设置 drift-check 检查点，回读初始 Spec/需求 |
| 多 Agent (Multi-agent) | 独立验证 (independent verification) | 下游必须独立验证上游输出（命令/文件/证据），禁止链式信任 |

## Integration Points

- `validation-contract`: 长任务断言增加 `type: drift-check`（见 `.agent/skills/validation-contract/SKILL.md`）。
- `/start-task` / `/mission`: 进入实现前与里程碑边界回读 `.agent/specs/` 或任务初始需求（Spec 回读检查点）。
- `/parallel` / `/mission` / `/worktree`: 下游 agent 必须独立验证上游输出（命令/文件/证据），禁止链式信任；收口时对跨 agent 传递的结论做交叉复核。
