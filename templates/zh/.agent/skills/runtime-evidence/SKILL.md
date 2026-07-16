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

示例：

- Mac 控制 Windows UI MCP 时，`sinceUtc` 应来自 Windows Worker health 或 Windows 诊断服务时间。
- 浏览器测试过滤服务端日志时，时间游标应来自服务端日志系统或服务端 health endpoint。
- 多容器验证时，每个组件的 evidence cursor 应记录对应组件自己的时间源。

运行时证据中应记录：

- `timestamp_source`: 例如 `target-health`, `server-log`, `browser`, `controller`
- `target_timestamp_utc`: 被测端时间
- `controller_timestamp_utc`: 控制端时间（可选，用于排查时钟偏差）
- `clock_skew_ms`: 可计算时记录

若无法获得被测端时间，必须在 `warnings` 中说明，并保留首次失败证据，避免把真实产品问题误判为时钟偏差。
