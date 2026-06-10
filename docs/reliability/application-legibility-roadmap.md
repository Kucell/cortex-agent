# Application Legibility 路线图

> 状态：规划中
> 日期：2026-04-21
> 目标：把 Agent 对“运行中应用”的理解能力，从概念层推进到可落地的仓库资产。

---

## 1. 问题定义

当前 Cortex Agent 已经具备较强的静态知识能力：

- 能读取规则、workflow、计划与设计文档
- 能做 knowledge lint 与 doc-gardening
- 能维持较稳定的知识结构

但它对“运行中的应用”仍然缺少统一理解入口。

这会导致：

- 改完服务后，Agent 不容易确认请求到底是否走通
- 改完前端后，Agent 不容易确认页面交互是否真的生效
- 排查问题时，Agent 更容易停留在代码猜测，而不是结合日志、指标和链路

这就是 application legibility 要解决的问题。

---

## 2. 目标

让 Cortex Agent 逐步具备以下四类运行时理解能力：

1. **Logs**：看懂请求、错误和上下文
2. **Metrics**：看懂健康度、错误率、延迟和关键业务指标
3. **Traces**：看懂一条请求跨服务的链路
4. **Browser Verification**：对 UI 项目直接做页面验证，而不是只靠代码推断

---

## 3. 任务优先级

### P0：先补最低成本、最高回报入口

#### T-H18 日志可理解性基线

状态：已完成第一版基线

目标：

- 定义日志查看入口、推荐字段与排查模板
- 明确 Agent 在服务型项目里如何先看日志再下结论

交付物：

- `docs/reliability/log-legibility.md`
- 日志排查最小模板
- 推荐输出格式

验收标准：

- 文档明确说明应优先关注哪些日志字段
- 能覆盖“启动失败”“接口失败”“链路中断”三类常见场景

#### T-H19 浏览器验证基线

状态：已完成第一版基线

目标：

- 为 UI 项目定义浏览器验证入口与最小验收动作
- 明确截图、页面断言和用户路径验证的输出格式

交付物：

- `docs/reliability/browser-verification.md`
- UI 验证最小模板

验收标准：

- 至少覆盖页面打开、按钮点击、表单提交、截图留档
- 能作为后续 browser skill / workflow 的承接文档

### P1：再补结构化运行时证据

#### T-H20 指标可理解性基线

状态：已完成第一版基线

目标：

- 定义 metrics 文档结构、关键指标分类和健康度表达方式

交付物：

- `docs/reliability/metrics-legibility.md`
- 指标分类模板

验收标准：

- 至少区分系统指标、接口指标、业务指标
- 能指导 `/briefing` 或后续 workflow 读取关键指标

#### T-H21 Trace / Request Chain 基线

状态：已完成第一版基线

目标：

- 定义 trace 与 request-id 相关的排查路径
- 让 Agent 能基于链路而不是单点日志看问题

交付物：

- `docs/reliability/trace-legibility.md`
- 请求链路排查模板

验收标准：

- 明确 request-id / trace-id 的作用和推荐读取顺序
- 覆盖至少一个跨服务调用示例

#### T-H22 运行时证据接入 briefing / ship 设计

状态：已完成第一版设计

目标：

- 设计 `/briefing`、`/ship` 如何消费运行时证据，而不是只读知识层指标

交付物：

- `docs/reliability/runtime-evidence-integration.md`

验收标准：

- 明确哪些 runtime signals 应进入 `/briefing`
- 明确哪些 runtime checks 应进入 `/ship`

### P2：最后做复用模板与标准化

#### T-H23 验证模板标准化

目标：

- 提供 UI 项目、服务项目、链路项目的标准验证模板

交付物：

- `docs/reliability/verification-templates.md`

验收标准：

- 至少给出 UI / API / 链路三类模板
- 可被后续 workflow 或 automation 直接引用

---

## 4. 建议顺序

推荐顺序：

1. T-H18 日志可理解性基线
2. T-H19 浏览器验证基线
3. T-H20 指标可理解性基线
4. T-H21 Trace / Request Chain 基线
5. T-H22 运行时证据接入设计
6. T-H23 验证模板标准化

原因：

- Logs 和 Browser 是一线排查与验收最常用入口
- Metrics 和 Traces 需要更稳定的运行时接入背景
- Workflow 集成应建立在前面的证据类型已定义之后

---

## 5. 非目标

- 当前不直接接入任何具体厂商的监控平台
- 当前不直接创建新的 runtime automation
- 当前不重写现有 `/ship` 与 `/briefing` 逻辑
- 当前不要求所有项目同时支持四类能力

---

## 6. 下一步建议

如果要正式启动 application legibility，建议先从 `T-H18` 开始。

它的投入最小，但会立刻改善“Agent 改完代码后如何验证服务真的工作了”这个问题。

当前状态：

- `T-H18` 已完成
- `T-H19` 已完成
- `T-H20` 已完成
- `T-H21` 已完成
- `T-H22` 已完成
- 推荐下一步进入 `T-H23`
