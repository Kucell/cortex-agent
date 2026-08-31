---
agent: claude
cli: claude
displayName: Claude Code
status: shipped
protocol: stdio-mcp
homepage: https://docs.anthropic.com/en/docs/claude-code
installCommand: "cortex-agent mcp install claude"
configPath: ~/.claude/mcp_servers.json
mcpBridge: P-002
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - macOS / Linux 一键安装;Windows 需手动配置
  - config 文件路径与 open-design 上游 `~/.claude/mcp.json` 存在差异 — cortex-agent 写入 `~/.claude/mcp_servers.json`(P-002 MS-003 决策)
  - MCP tools 默认 read-only,write 工具(design/install)需 confirm: true
pilot: csm-view-memory, SamHMI
last_verified: 2026-08-20
---

# Claude Code

## 1. Overview

Anthropic 官方的 CLI agent。通过 stdio MCP 接入 cortex-agent 的 design / prototype / prd / template / plugin / skill 资产,是 P-002 双向桥接的首个目标 agent。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install claude
# open-design 上游安装
od mcp install claude
```

## 3. MCP Configuration

```json
{
  "command": "claude",
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

配置文件: ~/.claude/mcp_servers.json(JSON,`mcpServers` key)。macOS/Linux 一键安装;Windows 需手动配置。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 实测通过 (P-002 MCP bridge pilot) |
| file:read | 实测通过 (P-002 MCP bridge pilot) |
| file:write | 实测通过 (P-002 MCP bridge pilot) |
| shell:exec | 实测通过 (P-002 MCP bridge pilot) |

## 5. Known Limitations

- macOS / Linux 一键安装;Windows 需手动配置
- config 文件路径与 open-design 上游 `~/.claude/mcp.json` 存在差异 — cortex-agent 写入 `~/.claude/mcp_servers.json`(P-002 MS-003 决策)
- MCP tools 默认 read-only,write 工具(design/install)需 confirm: true

## 6. Pilot Project

```text
csm-view-memory, SamHMI: <project-path>
验证: 2026-08-20
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 mcp-bridge 提案 §4.4 / VC-3(写入 ~/.claude 配置)
- docs/architecture/mcp-bridge.md
