---
name: runtime-evidence
description: 初始化和维护运行时验证证据文件，供 /briefing、/ship 和 validation-contract 判断验证状态。
---

# Runtime Evidence

## 目标

为 `/briefing` 和 `/ship` 工作流提供标准化的验证证据文件。这些文件记录“这次变更被验证到什么程度”，是风险评估和 Phase Gate 的数据来源。

## 输出文件

脚本执行后会在 `.agent/metrics/` 下写入（仅在文件不存在时创建，不覆盖已有内容）：

```text
.agent/metrics/
├── runtime-health.json
├── browser-verification.json
└── verification-summary.json
```

## 使用方式

```bash
node .agent/skills/runtime-evidence/scripts/init.js
node .agent/skills/runtime-evidence/scripts/generate-summary.js
```

## 与工作流的集成点

| 工作流 | 集成方式 |
|--------|---------|
| `/briefing` | 读取 `verification-summary.json` 展示上次验证状态 |
| `/ship` REVIEW | 执行验证模板后更新 runtime/browser 证据文件 |
| `/ship` CLEAN | 读取 `verification-summary.json`，失败时阻断发布 |

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
