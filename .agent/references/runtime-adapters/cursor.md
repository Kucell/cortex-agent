---
agent: cursor
cli: cursor
displayName: Cursor
status: shipped
protocol: stdio-mcp
homepage: https://cursor.com
installCommand: "cortex-agent mcp install cursor"
configPath: ~/.cursor/mcp.json
mcpBridge: P-002
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - MCP tools 默认 read-only
  - IDE 需重启以加载新 MCP 配置
pilot: csm-view-memory
last_verified: 2026-08-20
---

# Cursor

## 1. Overview

AI 驱动的代码编辑器(IDE)。通过 stdio MCP 接入 cortex-agent 资产,`cortex-agent mcp install cursor` 写入 ~/.cursor/mcp.json。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install cursor
# open-design 上游安装
od mcp install cursor
```

## 3. MCP Configuration

```json
{
  "command": "cursor",
  "args": [
    "mcp",
    "serve"
  ],
  "env": {
    "CORTEX_AGENT_PROJECT_ROOT": "<cwd>",
    "CORTEX_AGENT_MCP_TOKEN": "<hex32>"
  }
}
```

配置文件: ~/.cursor/mcp.json(JSON,`mcpServers` key)。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 实测通过 (P-002 MCP bridge pilot) |
| file:read | 实测通过 (P-002 MCP bridge pilot) |
| file:write | 实测通过 (P-002 MCP bridge pilot) |
| shell:exec | 实测通过 (P-002 MCP bridge pilot) |

## 5. Known Limitations

- MCP tools 默认 read-only
- IDE 需重启以加载新 MCP 配置

## 6. Pilot Project

```text
csm-view-memory: <project-path>
验证: 2026-08-20
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 mcp-bridge 提案
- docs/architecture/mcp-bridge.md
