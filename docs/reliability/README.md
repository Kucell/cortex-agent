# 可靠性与可观测性

本目录用于沉淀运行时可靠性、可观测性以及 application legibility 相关实践。

## 作用

- 记录 Agent 如何验证“系统真的工作了”
- 记录日志、指标、Trace、浏览器验证等运行时能力
- 承接后续针对 UI / 服务型项目的应用可理解性方案

## 当前重点

- 将验收标准从“文字描述”逐步改为“可执行验证”
- 为 logs / metrics / traces 留出明确文档入口
- 为浏览器驱动验证模式提供知识承接位置
- 明确 application legibility 的下一阶段任务顺序

## 后续计划

- 定义本地调试与验证的推荐路径
- 整理 UI 验证、服务启动验证和链路验证的标准模板
- 让 `/briefing` 或后续 workflow 能消费可靠性文档中的关键指标

## 当前路线图

- [Application Legibility 路线图](./application-legibility-roadmap.md)
- [Log Legibility](./log-legibility.md)
- [Browser Verification](./browser-verification.md)
- [Metrics Legibility](./metrics-legibility.md)
- [Trace Legibility](./trace-legibility.md)
- [Runtime Evidence Integration](./runtime-evidence-integration.md)
- [Harness Phase 8：Application Legibility](../exec-plans/active/harness-phase8-application-legibility.md)
