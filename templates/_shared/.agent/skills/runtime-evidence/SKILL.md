---
name: runtime-evidence
description: 初始化三类运行时验证证据文件（API 摘要、UI 截图结果、统一汇总），供 /briefing 和 /ship 读取验证状态。
---

# Runtime Evidence

## 目标

为 `/briefing` 和 `/ship` 工作流提供三个标准化的验证证据文件。这些文件记录"这次变更被验证到什么程度"，是风险评估和 Phase Gate 的数据来源。

## 输出文件

脚本执行后会在 `.agent/metrics/` 下写入（仅在文件不存在时创建，不覆盖已有内容）：

```text
.agent/metrics/
├── runtime-health.json          # API 验证结果摘要
├── browser-verification.json    # UI 验证截图 + 断言结果
└── verification-summary.json    # 三类结果的统一汇总（/briefing 读取此文件）
```

## 文件用途与写入来源

### `verification-summary.json`

**由谁写入**：`/ship` REVIEW 阶段执行完三类验证后汇总写入；也可由 Agent 手动合并 `runtime-health.json` 和 `browser-verification.json` 生成。

**读取方**：`/briefing`（步骤 9 展示上次验证状态）、`/ship` CLEAN 阶段（`overall_status: "fail"` 时阻断发布）。

**关键字段**：
- `overall_status`：`pass` / `fail` / `partial` / `not_run` — 影响 `/ship` CLEAN 是否阻断
- `coverage`：每类验证的覆盖深度 `full` / `minimal` / `skipped`
- `blockers`：阻断 CLEAN 的具体原因列表

**格式**：

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

---

### `runtime-health.json`

**由谁写入**：API 验证流程（手动或自动化）执行接口检查、日志扫描后写入。

**读取方**：`/ship` REVIEW 阶段评估后端服务健康状态；可被汇总脚本读取后并入 `verification-summary.json`。

**关键字段**：
- `status`：`pass` / `fail` / `partial` / `not_run`
- `summary.error_rate`：接口错误率（数值，0.0 = 无错误）
- `logs.new_patterns`：新增 ERROR/WARN 日志模式列表

---

### `browser-verification.json`

**由谁写入**：UI/E2E 验证流程（Playwright、Chrome DevTools、手动截图）完成后写入。

**读取方**：`/ship` REVIEW 阶段评估前端可用性；可被汇总脚本读取后并入 `verification-summary.json`。

**关键字段**：
- `status`：`pass` / `fail` / `partial` / `not_run`
- `paths`：逐路径验证结果列表（含 HTTP 状态、可交互性、截图路径）
- `console_errors`：浏览器控制台 uncaught error 列表

---

## 使用方式

### 初始化（首次使用）

```bash
node .agent/skills/runtime-evidence/scripts/init.js
```

仅在文件不存在时创建默认空结构，已存在的文件不会被覆盖。

### 再次运行

幂等操作：已存在的文件会被跳过，输出 `[skip]`。

### 生成综合摘要（核心功能）

```bash
node .agent/skills/runtime-evidence/scripts/generate-summary.js
```

聚合以下四个已有 metrics 文件，生成 `verification-summary.json`：

| 输入源 | 对应组件 |
|--------|---------|
| `.agent/metrics/self-check-report.json` | harness |
| `.agent/metrics/knowledge-health.json` | knowledge |
| `.agent/entropy-report.json` | entropy |
| `.agent/metrics/coordinator-health.json` | coordinator |

**说明**：
- 若某输入文件不存在，对应组件标记为 `"status": "unknown"`，不影响其他组件
- 综合状态（`overall_status`）基于已知组件的最差状态计算：任一 `critical` → `critical`；任一 `warning` → `warning`；否则 `healthy`
- 综合评分（`overall_score`）为已知组件评分的加权平均
- `actions_needed` 会根据各组件状态自动生成具体修复建议
- 脚本零外部依赖，仅使用 Node.js built-in

## 与工作流的集成点

| 工作流 | 集成方式 |
|--------|---------|
| `/briefing` | 读取 `verification-summary.json` 展示上次验证状态 |
| `/ship` REVIEW | 执行验证模板后更新三个文件 |
| `/ship` CLEAN | 读取 `verification-summary.json`，`fail` 时阻断发布 |

## 跨机/跨进程证据时间源

当验证由一台机器或进程发起、另一台机器或进程产生日志时，日志过滤起点必须来自**产生日志的被测端**，不能使用控制端本机时间。

### 游标采集规则

1. 在触发被测动作前立即从产生日志的被测端获取时间，作为该次验证的日志游标。
2. 游标必须来自与待查询日志相同的时间域，例如目标服务、目标运行时或日志系统提供的时间。
3. 存在多个被测端时，为每个被测端分别采集并记录游标；不得复用其他组件的游标。
4. 控制端时间只能用于诊断时钟偏差，不能作为被测端游标或缺失游标的替代值。
5. 如果日志查询采用了精度补偿或回看窗口，必须同时记录实际使用的 `log_filter_start_utc`。

### 必需元数据

跨机器或跨进程证据必须包含以下机器可读信息：

```json
{
  "type": "runtime_evidence_cursor",
  "target_id": "<target-id>",
  "timestamp_source": "target-system",
  "target_timestamp_utc": "2026-01-01T00:00:00Z",
  "controller_timestamp_utc": "2026-01-01T00:00:00Z",
  "clock_skew_ms": 0,
  "log_filter_start_utc": "2026-01-01T00:00:00Z"
}
```

- `target_id`：本次游标对应的被测端稳定标识。
- `timestamp_source`：被测端时间的具体来源；不得填写 `controller`。
- `target_timestamp_utc`：从被测端取得的 RFC 3339 UTC 时间。
- `controller_timestamp_utc`：同一采集阶段的控制端 UTC 时间，可选。
- `clock_skew_ms`：控制端时间减被测端时间的毫秒数，可计算时记录。
- `log_filter_start_utc`：日志查询实际使用的过滤起点；未采用回看窗口时应等于 `target_timestamp_utc`。

### 不可用与判定

若无法获得被测端时间，必须在 `warnings` 中记录原因并保留首次失败证据。任何依赖按时间过滤日志的阻断性断言都不能判定为通过，应标记为 `partial` 或 `fail`；除非验证契约明确允许不依赖时间过滤的替代证据，否则不得降级为控制端时间。

## 相关文档

> 以下文档属于 cortex-agent 主仓，不随模板分发（分发面不含 `docs/` 与
> `workflows/`），下游项目需自行按上述三类验证模板落地。

- 三类验证模板与 JSON 格式规范：主仓 `docs/reliability/verification-templates.md`
- 验证状态在晨播简报中的展示位置：主仓 `workflows/briefing.md`
