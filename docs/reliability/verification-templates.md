# Verification Templates

> 对应任务：T-H23
> 状态：已实现第一版
> 日期：2026-06-12

---

## 1. 目标

为三类最常见的项目形态（UI、服务/API、链路）提供标准化验证模板。

每份模板解决三个问题：

- **验什么**：最小验证集合
- **怎么验**：动作顺序与证据收集
- **怎么记录**：标准输出结构，可直接嵌入 `validation-contract` 的 `runtime` 断言

模板技术栈无关，可被 workflow 或 automation 引用。

---

## 2. 模板索引

| 项目形态 | 模板 | 主要依赖文档 |
| :--- | :--- | :--- |
| UI / 前端 | [T-VUI：UI 验证模板](#3-t-vui-ui-验证模板) | [browser-verification.md](./browser-verification.md) |
| 服务 / API | [T-VAPI：API 验证模板](#4-t-vapi-api-验证模板) | [log-legibility.md](./log-legibility.md), [metrics-legibility.md](./metrics-legibility.md) |
| 链路 / 分布式 | [T-VCHAIN：链路验证模板](#5-t-vchain-链路验证模板) | [trace-legibility.md](./trace-legibility.md) |

---

## 3. T-VUI：UI 验证模板

### 3.1 适用场景

- 前端页面、Web App、React/Vue/Svelte 项目
- 改动影响了路由、交互、表单、关键流程

### 3.2 最小验证集合

| 检查项 | 动作 | 证据 |
| :--- | :--- | :--- |
| 页面可打开 | `navigate(URL)` 返回 200 | 截图或状态码 |
| 主路径可走通 | 核心用户流程完整执行一次 | 截图序列 |
| 关键交互可触发 | 点击/输入/提交 不报错 | 浏览器控制台无 Error |
| 无明显视觉回归 | 与基线截图对比 | diff 截图 |

### 3.3 标准输出结构

```json
{
  "template": "T-VUI",
  "verified_at": "2026-06-12T00:00:00Z",
  "project_url": "http://localhost:3000",
  "results": [
    {
      "check": "page_load",
      "url": "/",
      "status": "pass",
      "evidence": "docs/reliability/evidence/ui-homepage.png"
    },
    {
      "check": "critical_flow",
      "flow": "user_login",
      "steps": ["navigate /login", "fill form", "submit"],
      "status": "pass",
      "evidence": "docs/reliability/evidence/ui-login-flow.png"
    },
    {
      "check": "console_errors",
      "count": 0,
      "status": "pass"
    }
  ],
  "overall": "pass",
  "notes": ""
}
```

### 3.4 嵌入 validation-contract 示例

```json
{
  "id": "VC-UI-001",
  "type": "runtime",
  "assertion": "关键页面可打开，主路径无阻断性错误",
  "evidence": "docs/reliability/evidence/ui-verification.json",
  "template_ref": "T-VUI",
  "blocking": true
}
```

---

## 4. T-VAPI：API 验证模板

### 4.1 适用场景

- 后端服务、REST API、GraphQL、gRPC
- 改动影响了接口响应、错误处理、数据结构

### 4.2 最小验证集合

| 检查项 | 动作 | 证据 |
| :--- | :--- | :--- |
| 服务可启动 | 进程启动，健康检查端点返回 2xx | 日志首行 + 健康检查响应 |
| 关键接口可响应 | curl / http client 调用，状态码符合预期 | 响应体 JSON |
| 错误处理正确 | 传入非法输入，返回正确错误码和消息 | 响应体 JSON |
| 无意外日志错误 | 服务日志中无 `ERROR` / `FATAL` | 日志截断片段 |

### 4.3 标准输出结构

```json
{
  "template": "T-VAPI",
  "verified_at": "2026-06-12T00:00:00Z",
  "service": "my-api",
  "base_url": "http://localhost:8080",
  "results": [
    {
      "check": "health",
      "endpoint": "/health",
      "method": "GET",
      "expected_status": 200,
      "actual_status": 200,
      "status": "pass"
    },
    {
      "check": "critical_endpoint",
      "endpoint": "/api/users",
      "method": "GET",
      "expected_status": 200,
      "actual_status": 200,
      "response_sample": { "count": 3 },
      "status": "pass"
    },
    {
      "check": "error_handling",
      "endpoint": "/api/users/invalid-id",
      "method": "GET",
      "expected_status": 404,
      "actual_status": 404,
      "status": "pass"
    },
    {
      "check": "log_errors",
      "error_count": 0,
      "fatal_count": 0,
      "status": "pass"
    }
  ],
  "overall": "pass",
  "notes": ""
}
```

### 4.4 嵌入 validation-contract 示例

```json
{
  "id": "VC-API-001",
  "type": "runtime",
  "assertion": "关键接口可响应，错误处理符合预期，无 FATAL 日志",
  "evidence": "docs/reliability/evidence/api-verification.json",
  "template_ref": "T-VAPI",
  "blocking": true
}
```

---

## 5. T-VCHAIN：链路验证模板

### 5.1 适用场景

- 多服务调用链路（微服务、BFF、消息队列）
- 改动影响了请求在多个服务间的流转

### 5.2 最小验证集合

| 检查项 | 动作 | 证据 |
| :--- | :--- | :--- |
| request_id 全链路可追踪 | 发起请求，在各服务日志中找到同一 request_id | 日志片段（含 request_id） |
| 链路无断点 | Trace 展示 span 连续，无 missing span | Trace 截图或导出 JSON |
| 端到端延迟在预期范围 | 总耗时 < SLA 阈值 | Trace summary 或 metrics |
| 失败时降级正确 | 其中一个下游返回错误，上游正确降级 | 日志 + 响应体 |

### 5.3 标准输出结构

```json
{
  "template": "T-VCHAIN",
  "verified_at": "2026-06-12T00:00:00Z",
  "request_id": "req-abc123",
  "entry_point": "POST /api/orders",
  "results": [
    {
      "check": "trace_continuity",
      "spans": ["gateway", "order-service", "inventory-service", "payment-service"],
      "missing_spans": [],
      "status": "pass"
    },
    {
      "check": "e2e_latency",
      "total_ms": 245,
      "sla_ms": 500,
      "status": "pass"
    },
    {
      "check": "request_id_propagation",
      "found_in": ["gateway-log", "order-service-log", "inventory-service-log"],
      "status": "pass"
    },
    {
      "check": "degradation",
      "scenario": "inventory-service returns 503",
      "expected_behavior": "order-service returns 202 with degraded flag",
      "actual_behavior": "order-service returns 202 with degraded: true",
      "status": "pass"
    }
  ],
  "overall": "pass",
  "notes": ""
}
```

### 5.4 嵌入 validation-contract 示例

```json
{
  "id": "VC-CHAIN-001",
  "type": "runtime",
  "assertion": "请求链路可端到端追踪，延迟符合 SLA，下游失败时降级正确",
  "evidence": "docs/reliability/evidence/chain-verification.json",
  "template_ref": "T-VCHAIN",
  "blocking": true
}
```

---

## 6. 使用边界

| 场景 | 是否适用 |
| :--- | :--- |
| 单文件 bug 修复，无 UI/API 影响 | 不强制，可跳过 runtime 断言 |
| 新增 API 端点 | **T-VAPI 必选** |
| 新增前端页面或关键交互 | **T-VUI 必选** |
| 跨服务改动或新增消息链路 | **T-VCHAIN 必选** |
| Mission Lite milestone 验收 | 三类中至少选一个作为 `runtime` 断言 |

---

## 7. 与现有工具的关系

| 工具 | 关系 |
| :--- | :--- |
| `validation-contract` skill | `runtime` 断言的 `evidence` 指向本模板输出的 JSON 文件 |
| `/ship` DONE 阶段 | 提交前检查 `blocking: true` 的 runtime 断言是否有对应 evidence |
| `/briefing` runtime evidence 板块 | 读取 `docs/reliability/evidence/*.json` 摘要展示 |
| `browser-verification.md` | T-VUI 模板的实施细节参考 |
| `log-legibility.md` / `metrics-legibility.md` | T-VAPI 模板的实施细节参考 |
| `trace-legibility.md` | T-VCHAIN 模板的实施细节参考 |
