# 质量体系

本目录用于沉淀 Cortex Agent 的质量标准、质量度量和后续自动化检查策略。

## 作用

- 记录“什么叫合格实现”
- 记录已经机械化的质量 Gate
- 承接后续 knowledge lint、doc lint、结构检查等规则

## 当前范围

- 架构合规
- 代码规范与提交规范
- workflow / sub-agent / docs 的一致性要求
- knowledge lint 与 doc-gardening 的指标和维护策略

## 后续计划

- 把 doc-gardening 结果接入定时维护或 heartbeat
- 定义文档新鲜度与 stale 标记规则
- 建立质量评分板，跟踪主要知识域的覆盖率与健康度

## 当前设计稿

- [Knowledge Lint 与 Doc-Gardening 设计](./knowledge-lint-and-doc-gardening.md)
- [Knowledge Maintenance Runbook](./knowledge-maintenance-runbook.md)
