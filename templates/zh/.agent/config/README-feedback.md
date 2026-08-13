# Feedback Inbox (P-001 · M-024)

> 本目录是 P-001 反馈闭环的中文说明投影；具体配置与行为请参考共享层的 `templates/_shared/.agent/config/feedback.json.example` 与 `lib/feedback/`。

## 启用流程

1. 复制 `templates/_shared/.agent/config/feedback.json.example` 到 `<project>/.agent/config/feedback.json`。
2. 将 `enabled` 改为 `true`。
3. 按需打开 `adapters.cortex_diagnostic` 或 `adapters.evolution_observation`。
4. 执行 `cortex-agent feedback log ...` 或由已注册的结构化适配器调用 `feedback ingest-event`。

## 默认行为

- `enabled=false`：所有写入命令零写入；`feedback status` 仍可只读。
- `nudge.enabled=false`：SessionStart 不会有反馈 nudge 输出。
- 写前脱敏由 `lib/feedback/redact.js` 完成；不会采集 prompt、transcript、token、stack、任意环境变量或业务 payload。

## 退出码

| Code | 语义 |
| :--- | :--- |
| 0 | 成功 |
| 2 | 项目未初始化或 Inbox 根不可解析 |
| 3 | 参数/schema 错误 |
| 4 | 写入或读取 I/O 失败 |
| 5 | 写入功能未启用；不适用于 status |
| 6 | 配置或权限不安全 |

## 范围

- 在范围内：本地 immutable event storage、白名单 schema、写前脱敏、统一配置、三个 CLI 子命令、默认关闭的 SessionStart nudge。
- 不在范围内：Issue 候选、GitHub 写入、Task 同步、Release 集成、自动修改 `.agent/memory/feedback/`。