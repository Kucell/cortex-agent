---
name: runtime-state-mcp
description: 通过可选、只读的 MCP stdio adapter 暴露 Cortex Agent 运行态投影。当本地 MCP 客户端需要读取与 CLI、Dashboard 相同的 Management API 状态，且不能直接解析 .agent 状态时使用。
---

# Runtime State MCP

使用明确配置的 Management API 脚本启动可选 adapter：

```bash
CORTEX_MANAGEMENT_API_SCRIPT=.agent/skills/management-api/scripts/index.js \
  node .agent/skills/runtime-state-mcp/scripts/server.js
```

服务支持 `initialize`、`resources/list` 和 `resources/read`。资源 URI 为 `cortex://runtime-state/<query>`，其中 `<query>` 必须是已冻结的投影查询之一。

## 边界

- Management API projection 是唯一数据源；禁止在此解析 `.agent/` 状态文件。
- adapter 只读；禁止增加变更方法或 MCP tools。
- stdout 只输出协议帧，诊断只输出到 stderr。
- 未知 URI、不支持的方法、异常投影或 API 不可用时必须 fail closed。
- 服务保持可选：只有 MCP 客户端主动启动时才运行，不影响其他功能。

