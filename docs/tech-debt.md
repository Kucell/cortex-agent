# 技术债务

本文件用于统一记录 Cortex Agent 当前已知、但尚未偿还的结构性债务。

| ID | 领域 | 债务描述 | 影响 | 建议后续动作 |
|----|------|---------|------|-------------|
| TD-001 | Knowledge | knowledge lint、doc-gardening 与 maintenance runbook 已就位，但真实 heartbeat / cron automation 仍未创建 | 知识维护仍依赖人工触发，无法稳定形成周期性整理节奏 | 按 runbook 创建 heartbeat 或 cron，消费 `knowledge-health.json` 与 `doc-gardening-report.json` |
| TD-002 | Reliability | application legibility 仍未真正落地，浏览器、日志、指标、Trace 仍缺统一仓库入口 | Agent 仍较难直接验证运行时行为 | 按 `docs/reliability/application-legibility-roadmap.md` 和 `docs/exec-plans/active/harness-phase8-application-legibility.md` 分阶段推进 |
| TD-003 | Harness | `upgrade` 纯加法策略下，已安装项目不会自动拿到改造后的 workflow / sub-agent 文件 | 用户升级后能力不一致 | 补 migration 指南或差异提示机制 |
| TD-004 | Context | `context-index.json` 的 `estimated_tokens` 依赖人工维护，准确性可能漂移 | 上下文预算可能失真 | 增加校准或检查机制 |
| TD-005 | Cost | 推理三明治和结构化审查增加了 token 成本，但成本控制策略尚未产品化 | 使用成本不透明 | 在后续 quality / reliability 资产中加入成本观察指标 |
