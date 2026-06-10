# Harness Phase 8：Application Legibility

> 状态：进行中
> 开始日期：2026-04-21

## 目标

让 Cortex Agent 对运行中应用具备可复用、可解释、可持续维护的理解入口，逐步覆盖日志、指标、Trace 和浏览器验证。

## 范围

- 为 logs / metrics / traces / browser verification 建立文档入口
- 为运行时证据定义最小模板和验收标准
- 为 `/briefing` 与 `/ship` 接入 runtime evidence 做设计准备

## 非目标

- 本轮不直接接入具体监控平台
- 本轮不直接创建新的 runtime automation
- 本轮不重写现有 workflow 的执行逻辑

## 任务拆解

### T-H18 [已完成]

- 新增 `docs/reliability/log-legibility.md`
- 定义日志字段、排查顺序和常见故障模板

### T-H19 [已完成]

- 新增 `docs/reliability/browser-verification.md`
- 定义页面打开、交互、截图和断言的最小模板

### T-H20 [已完成]

- 新增 `docs/reliability/metrics-legibility.md`
- 定义关键指标分类与健康度表达方式

### T-H21 [已完成]

- 新增 `docs/reliability/trace-legibility.md`
- 定义 request-id / trace-id 与链路排查模板

### T-H22 [已完成]

- 新增 `docs/reliability/runtime-evidence-integration.md`
- 设计 `/briefing` 与 `/ship` 如何消费 runtime evidence

### T-H23 [待开始]

- 新增 `docs/reliability/verification-templates.md`
- 整理 UI / API / 链路三类验证模板

## 验收标准

- `docs/reliability/` 下有完整的四类运行时证据入口
- 每类入口文档都给出最小模板和使用边界
- `/briefing` 与 `/ship` 的接入设计有明确文档承接

## 风险与依赖

- 需要先明确不同项目形态的通用最小集合，避免文档过早绑定某个技术栈
- 浏览器验证与 trace 方案的落地复杂度高于 logs / metrics
- 若缺少真实项目样本，模板容易过泛

## 当前进展

- 2026-04-21：完成 Phase 8 任务拆解与优先级排序
- 2026-04-21：在 reliability 文档层建立 application legibility 的路线图入口
- 2026-04-21：完成 `log-legibility.md`，建立日志入口、字段优先级、排查顺序与输出模板
- 2026-04-21：完成 `browser-verification.md`，建立页面验证入口、最小交互动作、截图留证与输出模板
- 2026-04-22：完成 `metrics-legibility.md`，建立指标分层、健康度表达方式与标准输出模板
- 2026-04-22：完成 `trace-legibility.md`，建立 request_id / trace_id 优先级、链路排查顺序与断点判断模板
- 2026-04-22：完成 `runtime-evidence-integration.md`，明确 `/briefing` 与 `/ship` 的 runtime summary 接入策略
