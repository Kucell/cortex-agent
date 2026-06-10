# Runtime Evidence Integration

> 对应任务：T-H22
> 状态：已完成第一版设计
> 日期：2026-04-22

---

## 1. 目标

把 runtime evidence 从“分散的说明文档”推进到“可被 `/briefing` 与 `/ship` 消费的统一输入面”。

这里的 runtime evidence 指四类运行时证据：

- logs
- metrics
- traces
- browser verification

这份文档不直接接入具体平台，而是回答三个问题：

- 哪些 runtime signals 应进入 `/briefing`
- 哪些 runtime checks 应进入 `/ship`
- 应如何分层接入，避免把 workflow 做成重型流程

---

## 2. 设计原则

1. 先接“摘要”，再接“原始证据”
2. 先接可选输入，再决定哪些场景升级为默认步骤
3. 先做分项目类型的最小集合，不追求所有仓库统一一刀切
4. 先让 Agent 能解释运行时证据，再考虑自动化决策

---

## 3. `/briefing` 的接入设计

### 3.1 目标

让 `/briefing` 不只读静态知识和任务计划，还能快速回答：

- 当前系统是否健康
- 最近有没有运行时异常信号
- 今天如果继续改动，最该优先关注哪类 runtime risk

### 3.2 推荐输入

`/briefing` 应优先读取“摘要型运行时证据”，而不是直接扫原始日志或大规模 tracing 数据。

建议输入：

- `.agent/metrics/runtime-health.json`
- `.agent/metrics/browser-verification.json`
- `.agent/metrics/verification-summary.json`

当前这些文件还未实现；这里只定义它们未来应承载的职责。

### 3.3 推荐展示内容

建议在 `/briefing` 中新增一个 `Runtime Evidence` 板块，最小展示：

```text
## Runtime Evidence

- Runtime health: {healthy|advisory|attention}
- Last verification time: {timestamp}
- Signals:
  - Logs: {status}
  - Metrics: {status}
  - Traces: {status}
  - Browser: {status}

### Key Findings
- {最近一次高优先级运行时发现}

### Recommended Focus
- {今天最该优先验证的运行时方向}
```

### 3.4 推荐使用规则

- 如果运行时摘要不存在，不阻断 `/briefing`
- 但应明确提示“当前没有 runtime evidence 快照”
- `/briefing` 默认只展示摘要，不直接展开大量原始日志

---

## 4. `/ship` 的接入设计

### 4.1 目标

让 `/ship` 在交付阶段不只依赖静态检查，还能按项目类型补充最小 runtime validation。

### 4.2 推荐接入位置

推荐把 runtime evidence 放在：

```text
REVIEW → RUNTIME_EVIDENCE → COMMIT
```

或者更保守地先作为：

```text
DONE → RUNTIME_SUMMARY
```

两种策略区别：

- **前置校验型**：用于高风险项目，runtime check 影响是否允许交付
- **后置摘要型**：用于通用项目，runtime check 不阻断交付，但进入报告

### 4.3 推荐最小检查

按项目类型选择：

#### 服务型项目

- Logs：启动/请求错误摘要
- Metrics：错误率、延迟、吞吐健康度
- Traces：关键请求是否断链

#### UI 项目

- Browser verification：关键页面打开与主路径点击
- 必要时补日志或接口指标摘要

#### 混合项目

- Browser + Logs
- 必要时再补 Metrics / Traces

### 4.4 阻断策略建议

默认不要把所有 runtime checks 都做成阻断项。

建议分级：

- `P0 runtime failure`：可阻断交付
- `Advisory runtime drift`：进入报告，不阻断
- `Missing runtime evidence`：提醒补充，不默认阻断

---

## 5. 建议的摘要文件

为了让 workflow 稳定消费，建议未来统一生成以下文件：

### 5.1 `runtime-health.json`

职责：

- 聚合 logs / metrics / traces 的摘要结论

建议字段：

- `generated_at`
- `health_status`
- `project_type`
- `signals.logs`
- `signals.metrics`
- `signals.traces`
- `high_priority_findings`
- `recommended_focus`

### 5.2 `browser-verification.json`

职责：

- 聚合最近一次关键 UI 验证结果

建议字段：

- `generated_at`
- `scenario`
- `status`
- `evidence`
- `next_step`

### 5.3 `verification-summary.json`

职责：

- 面向 `/briefing` 与 `/ship` 的统一摘要

建议字段：

- `generated_at`
- `overall_status`
- `coverage`
- `signals`
- `blocking_findings`
- `advisory_findings`

---

## 6. 分阶段接入建议

### Step 1：先有文档基线

当前已完成：

- `log-legibility.md`
- `browser-verification.md`
- `metrics-legibility.md`
- `trace-legibility.md`

### Step 2：再定义摘要文件格式

下一步建议实现：

- `runtime-health.json`
- `browser-verification.json`
- `verification-summary.json`

### Step 3：最后接 workflow

建议顺序：

1. 先让 `/briefing` 读取摘要
2. 再让 `/ship` 读取摘要
3. 最后决定哪些项目把 runtime evidence 升级为阻断项

---

## 7. 非目标

- 当前不接具体 observability 平台
- 当前不直接实现 runtime evidence 生成脚本
- 当前不直接修改 `/briefing` 与 `/ship` 的执行状态机
- 当前不要求所有项目都产生同一种 runtime evidence

---

## 8. 当前结论

T-H22 的目标不是立刻把 `/briefing` 和 `/ship` 做重，而是先建立一个简单但稳定的共识：

> workflow 不应直接消费原始运行时噪声，而应优先消费结构化 runtime summary。
