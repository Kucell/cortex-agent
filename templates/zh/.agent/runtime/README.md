# 运行时状态契约

这些契约是状态写入器、Management API projection、CLI、可选 MCP、Dashboard、Briefing、Handoff、Review 和审计视图的共享输入。

- `resource-event.schema.json` 定义 append-only 的资源活动和状态转换。
- `log-cursor.schema.json` 定义经过脱敏的 target-side 日志位置及其可用性。
- `evidence-ref.schema.json` 定义对命令、验证、产物、运行时、日志或人工证据的紧凑引用。

写入器仍由 workflow 管理。读取方保持 read-only，绝不修改资源状态、事件、证据、lease、Decision 或 Waitpoint。大体量原始日志必须保留在事件记录之外。
