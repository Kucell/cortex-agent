# Harness Phase 7：知识架构与可理解性地基

> 状态：进行中
> 开始日期：2026-04-20

## 目标

为 Cortex Agent 的下一轮 Harness 优化建立稳定的知识架构地基，使后续的 knowledge lint、doc-gardening 和 application legibility 有明确落点。

## 范围

- 补齐 `docs/` 知识架构骨架
- 更新高层架构文档
- 统一技术债务记录入口
- 为下一轮自动化维护预留计划与承接位置

## 非目标

- 本轮不接入定时维护自动化
- 本轮不接入浏览器、日志、指标或 Trace 工具链
- 本轮不调整 CLI 行为

## 任务拆解

### T-H09 [已完成]

- 创建 `docs/quality/`
- 创建 `docs/reliability/`
- 创建 `docs/security/`
- 创建 `docs/exec-plans/`
- 新增 `docs/tech-debt.md`

### T-H10 [已完成]

- 更新 `docs/architecture.md`
- 更新 `docs/architecture/harness-optimization-design.md`

### T-H11 [已完成]

- 新增本 active plan
- 把高优先级债务写入 `docs/tech-debt.md`

### T-H12 [已完成]

- 设计 knowledge lint 的检查范围
- 设计 doc-gardening 的触发方式
- 明确下一批实现落在哪些 workflow / script / docs 中

### T-H13 [已完成]

- 新增 `.agent/skills/knowledge-lint/`
- 实现第一版确定性检查脚本
- 输出 `.agent/metrics/knowledge-health.json`
- 同步更新双语模板

### T-H14 [已完成]

- 将 `knowledge-health.json` 接入 `/briefing` 工作流说明
- 让知识健康度进入每日可见面
- 同步更新双语模板

### T-H15 [已完成]

- 将轻量 `knowledge-lint` 接入 `/ship` 工作流说明
- 让交付后自动刷新 `knowledge-health.json`
- 同步更新双语模板

### T-H16 [已完成]

- 新增 `doc-gardening` skill 与建议报告脚本
- 将 `doc-gardening-report.json` 接入 `/briefing` 工作流说明
- 将 `doc-gardening` 接入 `/ship` 后置建议生成阶段
- 同步更新双语模板

### T-H17 [已完成]

- 新增知识维护 Runbook，定义 heartbeat / cron 的输入、边界与 prompt 约定
- 将 Runbook 挂回质量文档与 `/briefing` 自动维护提示
- 为后续真实 automation 创建保留统一入口

## 验收标准

- 新知识目录结构已创建
- 架构文档与现状一致
- active plan 和 tech debt 入口已建立
- 下一轮工作项有明确承接位置

## 当前进展

- 2026-04-20：完成知识架构骨架、架构文档同步和计划资产落地
- 2026-04-20：完成 knowledge lint / doc-gardening 设计稿，并明确下一轮实现落点
- 2026-04-20：完成第一版 knowledge lint 技能与脚本，实现 knowledge-health.json 输出
- 2026-04-20：完成 `/briefing` 对 knowledge-health.json 的消费设计
- 2026-04-20：完成 `/ship` 对 knowledge-health.json 的后置刷新设计
- 2026-04-20：完成第一版 doc-gardening 技能与报告输出，并接入 `/briefing` / `/ship`
- 2026-04-20：完成知识维护 Runbook，为 heartbeat / cron 接入提供统一入口
