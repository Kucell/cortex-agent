# 风险分级策略

## 目的

在自动化或审查前划分任务风险，使既有 Task Pipeline、Validation Contract、Decision/Waitpoint 与 owning workflow 选择适当证据门槛。本策略不新增状态机，也不授予执行权限。

## 分级

| 等级 | 默认控制 | 未获得独立资源绑定 Decision、Waitpoint 与 owning workflow/环境 gate 前禁止事项 |
| :--- | :--- | :--- |
| low | 范围与验证证据；遵循项目常规 review 策略 | 绕过保护分支、host 或环境权限。 |
| medium | 最终计划、验证证据与独立 review | 未记录 deviation 时扩大 writable scope。 |
| high | owner architecture Decision、强化验证与独立或人工 review | merge、release、高影响动作或外部副作用。 |
| critical | 具名人类 Decision、环境 gate、人工或预批准 runbook | agent 直接执行、agent 间权限转移、生产部署。 |

未知、跨环境、敏感路径、外部副作用或 agent-to-agent 权限链不清时，默认标为 high，直到 owner 记录更窄分类。

## Artifact 契约

- Spec 记录 intent summary、constraints、non-goals、open questions 与 risk tier。
- Plan 记录 spec reference、writable scope、validation commands、risk rationale 与 deviation policy。
- Review 记录 risk tier、独立 reviewer evidence、proof-carrying findings 与 verdict。
- Learning 记录 source event、confirmer、目标 rule/fixture/task 或 bounded waiver，以及验证计划。

risk_tier 必须出现在 Spec 或 Plan artifact；缺失或未知时，执行前按 high 处理。字段先作为 payload/template 约定；仅在 fixture 与 pilot 证明跨 host 互操作需要后，才提升为 schema 必填字段。

## 权限边界

Trigger 是条件，不是批准。risk tier 只选择所需证据与 gate；它绝不替代 owning workflow、资源绑定 Decision、Waitpoint、环境控制或人类授权。
