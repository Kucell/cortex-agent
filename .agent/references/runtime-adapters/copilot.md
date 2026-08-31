---
agent: copilot
cli: copilot
displayName: GitHub Copilot
status: shipped
protocol: stdio-mcp
homepage: https://github.com/features/copilot
installCommand: "cortex-agent mcp install copilot"
configPath: ~/.config/github-copilot/mcp.json
mcpBridge: P-002
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - 同一 config 同时服务 VS Code 与 CLI,升级需谨慎
  - MCP tools 默认 read-only
pilot: null
last_verified: 2026-08-20
---

# GitHub Copilot

## 1. Overview

GitHub Copilot(VS Code + Copilot CLI)。通过 stdio MCP 接入 cortex-agent,`cortex-agent mcp install copilot` 写入统一配置。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install copilot
# open-design 上游安装
od mcp install copilot
```

## 3. MCP Configuration

```json
{
  "command": "copilot",
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

配置文件: ~/.config/github-copilot/mcp.json。覆盖 VS Code + GitHub Copilot / GitHub Copilot CLI 两个 runtime。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 实测通过 (P-002 MCP bridge pilot) |
| file:read | 实测通过 (P-002 MCP bridge pilot) |
| file:write | 实测通过 (P-002 MCP bridge pilot) |
| shell:exec | 实测通过 (P-002 MCP bridge pilot) |

## 5. Known Limitations

- 同一 config 同时服务 VS Code 与 CLI,升级需谨慎
- MCP tools 默认 read-only

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 mcp-bridge 提案
- docs/architecture/mcp-bridge.md
