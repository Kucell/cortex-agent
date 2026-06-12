# Verification Templates

> 对应任务：T-H23
> 状态：已实现第一版
> 日期：2026-06-12

---

## 1. 目标

提供三类可复用的验证模板，让 Agent 在 `/ship` 的 REVIEW 阶段和 `/briefing` 的风险判断中，用一致的结构表达"这次变更被验证到什么程度"。

三类模板覆盖：

- **UI 验证**：浏览器/端到端交互，确认界面真的能用
- **API 验证**：接口/日志/指标，确认后端服务按预期响应
- **链路验证**：跨服务 trace，确认端到端请求链路无断点

每类分"最小模板"（快速完成，不超过 10 分钟）和"完整模板"（深度覆盖，适合重大变更）。

---

## 2. 使用方式

### 何时使用

| 场景 | 推荐模板 |
|------|---------|
| `/ship` REVIEW 阶段 | 按改动类型选对应最小模板 |
| `/briefing` 风险评估 | 读取 `verification-summary.json` |
| 重大 feature 上线前 | 三类模板完整版依次执行 |
| Bug fix 验证 | 仅 API 模板最小版 + 对应 E2E 路径 |

### 输出位置

```text
.agent/metrics/
├── runtime-health.json          # API 验证结果摘要
├── browser-verification.json    # UI 验证截图 + 断言结果
└── verification-summary.json    # 三类结果的统一汇总（/briefing 读取此文件）
```

---

## 3. UI 验证模板

> 适用于：前端 / 全栈项目，有可交互的页面

### 最小模板（5 分钟）

```markdown
## UI 验证

**验证时间**: [YYYY-MM-DD HH:MM]
**触发原因**: [本次 /ship 改动了哪些前端路径]

### 关键页面可用性

| 路径 | HTTP 状态 | 可交互 | 截图 |
|------|----------|--------|------|
| /    | 200      | ✅     | [链接或说明] |
| /[改动路径] | 200 | ✅  | [链接或说明] |

### 改动路径冒烟

- [ ] 入口正常渲染（无空白页、无明显报错）
- [ ] 主要交互元素可点击（按钮、表单、导航）
- [ ] 与本次变更最相关的一条 Happy Path 走通

### 结论

- **状态**: PASS / FAIL / PARTIAL
- **阻断 CLEAN**: 是 / 否
- **备注**: [若 FAIL，具体原因]
```

### 完整模板（30 分钟）

```markdown
## UI 验证（完整版）

**验证时间**: [YYYY-MM-DD HH:MM]
**测试环境**: [本地 / 预发 / 生产]
**工具**: [Chrome DevTools / Playwright / 手动]

### 页面可用性矩阵

| 路径 | 状态码 | 首屏时间 | 交互状态 | 截图 |
|------|-------|---------|---------|------|
| (填写所有改动相关页面) |

### Happy Path 验证

针对本次变更涉及的核心用户流程，逐条记录：

1. **流程名称**: [例：用户登录]
   - 步骤：[点击"登录"→填写表单→提交]
   - 预期：[跳转到首页，展示用户名]
   - 实际：[✅ 符合预期 / ❌ 描述偏差]

### 回归检查

- [ ] 与本次变更无关的邻近页面没有出现视觉回归
- [ ] 控制台无 uncaught error（非已知老问题）
- [ ] 网络请求中无非预期的 4xx / 5xx

### 结论

- **覆盖路径数**: [N 条]
- **通过率**: [N/N]
- **状态**: PASS / FAIL / PARTIAL
- **遗留问题**: [若有]
```

---

## 4. API 验证模板

> 适用于：后端服务、CLI 工具、有 API 接口的项目

### 最小模板（5 分钟）

```markdown
## API 验证

**验证时间**: [YYYY-MM-DD HH:MM]
**触发原因**: [本次 /ship 改动了哪些接口/逻辑]

### 接口可用性

| 接口 | 方法 | 状态码 | 响应时间 | 结果 |
|------|------|-------|---------|------|
| [改动接口] | GET/POST | 200 | <500ms | ✅ |

### 日志检查

- [ ] 服务启动日志无 ERROR
- [ ] 改动路径的请求日志无异常
- [ ] 无新增的 WARN / ERROR 模式

### 结论

- **状态**: PASS / FAIL / PARTIAL
- **阻断 CLEAN**: 是 / 否
```

### 完整模板（20 分钟）

```markdown
## API 验证（完整版）

**验证时间**: [YYYY-MM-DD HH:MM]
**测试环境**: [本地 / 预发]

### 接口功能矩阵

| 接口 | 方法 | 场景 | 预期状态码 | 实际 | 响应摘要 |
|------|------|------|----------|------|---------|
| (填写本次改动涉及的全部接口及边界场景) |

### 指标基线对比

| 指标 | 变更前 | 变更后 | 差异 | 判断 |
|------|-------|-------|------|------|
| P50 响应时间 | - | - | - | ✅/⚠️ |
| 错误率 | - | - | - | ✅/⚠️ |
| QPS（峰值） | - | - | - | ✅/⚠️ |

### 日志模式扫描

检查最近 50 条日志是否有新增 ERROR 模式，无新增 ERROR / 慢查询 / 超时即为通过。

### 结论

- **接口覆盖率**: [N/N]
- **状态**: PASS / FAIL / PARTIAL
- **遗留问题**: [若有]
```

---

## 5. 链路验证模板

> 适用于：微服务架构、有跨服务调用的项目

### 最小模板（10 分钟）

```markdown
## 链路验证

**验证时间**: [YYYY-MM-DD HH:MM]
**触发原因**: [本次改动涉及的跨服务路径]

### 关键链路检查

| 链路 | 入口服务 | 出口服务 | trace_id | 状态 |
|------|---------|---------|---------|------|
| [改动涉及的链路] | - | - | [从日志取] | ✅/❌ |

### 断点检查

- [ ] 所有跨服务 span 均有完整的 parent_id
- [ ] 无超时 span（> SLA 阈值）
- [ ] 无孤儿 span（缺少 trace_id）

### 结论

- **状态**: PASS / FAIL / PARTIAL
- **阻断 CLEAN**: 是 / 否
```

### 完整模板（30 分钟）

```markdown
## 链路验证（完整版）

**验证时间**: [YYYY-MM-DD HH:MM]
**Tracing 工具**: [Jaeger / Zipkin / OpenTelemetry / 其他]

### 端到端请求链路

| 请求场景 | trace_id | 总耗时 | span 数 | 错误 span | 状态 |
|---------|---------|-------|--------|---------|------|
| (填写关键业务请求) |

### 服务依赖验证

| 调用方 | 被调用方 | 协议 | P99 耗时 | 错误率 | 状态 |
|-------|---------|------|---------|-------|------|

### 变更影响扫描

- [ ] 新增的跨服务调用有 trace_id 传递
- [ ] 本次变更未引入新的同步阻塞调用
- [ ] 超时配置与 SLA 阈值一致

### 结论

- **链路覆盖数**: [N 条]
- **状态**: PASS / FAIL / PARTIAL
- **遗留问题**: [若有]
```

---

## 6. 汇总结构（verification-summary.json）

`/briefing` 和 `/ship` 读取以下结构作为统一输入：

```json
{
  "generated_at": "2026-06-12T12:00:00Z",
  "triggered_by": "/ship",
  "overall_status": "pass",
  "coverage": {
    "ui": "minimal",
    "api": "full",
    "trace": "skipped"
  },
  "results": {
    "ui": {
      "status": "pass",
      "paths_checked": 3,
      "screenshot_paths": []
    },
    "api": {
      "status": "pass",
      "endpoints_checked": 5,
      "error_rate_delta": 0.0
    },
    "trace": {
      "status": "skipped",
      "reason": "no cross-service calls in this change"
    }
  },
  "blockers": [],
  "warnings": []
}
```

**字段说明**：
- `coverage`: `full` / `minimal` / `skipped`
- `overall_status`: `pass` / `fail` / `partial` — 影响 `/ship` CLEAN 阶段是否阻断
- `blockers`: 阻断 CLEAN 的具体原因列表

---

## 7. 与工作流的集成点

| 工作流 | 集成方式 |
|--------|---------|
| `/ship` REVIEW | 执行对应最小模板，结果影响 Phase Gate |
| `/ship` CLEAN | 读取 `verification-summary.json`，`fail` 时阻断 |
| `/briefing` | 读取 `verification-summary.json` 展示上次验证状态 |
| `mission` VALIDATE | 按 milestone 类型选择对应完整模板 |

---

## 8. 相关文档

- [log-legibility.md](./log-legibility.md) — 日志排查字段优先级与标准输出模板
- [metrics-legibility.md](./metrics-legibility.md) — 指标分层与健康度表达
- [trace-legibility.md](./trace-legibility.md) — Trace 断点判断与链路排查顺序
- [browser-verification.md](./browser-verification.md) — 浏览器验证基线与截图留证
- [runtime-evidence-integration.md](./runtime-evidence-integration.md) — /briefing 与 /ship 接入设计
