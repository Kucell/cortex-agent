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
# 判断力风险规则（Judgment Risks）

判断力的四类失败模式必须被显式识别与防护，禁止依赖隐式机制（"测试会兜住""milestone 会拦截"）。本规则定义四类风险、Sycophancy 三条硬约束、按任务类型的针对性检查清单与挂接点。

## 四类失败模式

| 风险 | 定义 | 识别信号 | 针对性检查 |
| :--- | :--- | :--- | :--- |
| Silent Failure | 格式正确但底层数据/逻辑错误 | 断言全绿但假设未核对；数字来源不明 | 数据分析任务：逐条核对假设、数据来源、口径 |
| Spec Drift | 长任务中产出逐渐偏离初始需求 | 中途产出与 spec.md 字段不一致 | 长任务：设置 drift-check 检查点，回读初始 Spec |
| Sycophancy | 基于错误前提生成"自信"错误结论 | 用户断言被直接采纳且无证据引用；无置信度声明 | 结论必须引用证据；错误前提必须拒绝并说明原因 |
| Cascade Failure | 多 Agent 协作中错误逐级放大 | 下游直接采信上游结论，无独立验证 | 下游必须独立验证上游输出；收口时交叉复核 |

**共同底线**：任何一类风险被识别到时，禁止"带病推进"——先回到出错节点修正，再继续。宁可显式阻断，不可静默掩盖。

## Sycophancy 硬约束

> 作用域：交付物（deliverables）。对用户保持协作态度，但"拒绝错误前提"不等于"拒绝用户"——先指出冲突，再提供正确选项。

1. **结论可溯源**：交付物中的任何结论性陈述必须引用可复核的证据（文件、命令输出、数据、来源）；非交付物的快速交互问答不强制逐条引用，但不得以自信语气包装猜测。
2. **错误前提拒绝**：检测到用户前提与已知事实冲突时，必须先指出冲突，不得基于错误前提继续生成。
3. **显式置信度**：无法完全验证时，显式声明不确定性与所需验证，禁止用自信语气包装猜测。

## 按任务类型检查清单

| 任务类型 | 检查重点 | 必做动作 |
| :--- | :--- | :--- |
| 数据分析 | 假设 / 数据来源 / 口径 | 逐条核对假设、数据来源与统计口径；结论与数字一一对应到来源 |
| 编程 | Edge Case | 核对边界条件、空值、并发、异常路径；不只验证 happy path |
| 长任务 | drift | 任务过半与里程碑边界设置 drift-check 检查点，回读初始 Spec/需求 |
| 多 Agent | 独立验证 | 下游必须独立验证上游输出（命令/文件/证据），禁止链式信任 |

## 挂接点

- `validation-contract`：长任务断言增加 `type: drift-check`（见 `.agent/skills/validation-contract/SKILL.md`）。
- `/start-task` / `/mission`：进入实现前与里程碑边界回读 `.agent/specs/` 或任务初始需求（Spec 回读检查点）。
- `/parallel` / `/mission` / `/worktree`：下游 agent 必须独立验证上游输出（命令/文件/证据），禁止链式信任；收口时对跨 agent 传递的结论做交叉复核。
