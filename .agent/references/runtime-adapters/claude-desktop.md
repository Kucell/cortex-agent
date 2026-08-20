---
agent: claude-desktop
cli: claude-desktop
displayName: Claude Desktop
status: reference
protocol: stdio-mcp
homepage: https://claude.com/download
installCommand: "cortex-agent mcp install claude-desktop"
configPath: ~/.config/Claude/claude_desktop_config.json
mcpBridge: P-002
capabilities:
  - prompt:inject
  - file:read
limitations:
  - macOS / Windows only(桌面 App),无 Linux 桌面版
  - 桌面 App 的 MCP 配置重启后才生效
  - 仅限本机 stdio;远程 / 团队协作留 Phase 3 HTTP MCP
pilot: null
last_verified: 2026-08-20
---

# Claude Desktop

## 1. Overview

Anthropic 的桌面应用。通过 stdio MCP 接入 cortex-agent;配置走 claude_desktop_config.json,适合桌面端消费 design 资产。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install claude-desktop
# open-design 上游安装
od mcp install claude-desktop
```

## 3. MCP Configuration

```json
{
  "command": "claude-desktop",
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

配置文件: ~/.config/Claude/claude_desktop_config.json(macOS;Windows 在 %APPDATA%\Claude\claude_desktop_config.json)。桌面 App 配置,非 CLI。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |

## 5. Known Limitations

- macOS / Windows only(桌面 App),无 Linux 桌面版
- 桌面 App 的 MCP 配置重启后才生效
- 仅限本机 stdio;远程 / 团队协作留 Phase 3 HTTP MCP

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 mcp-bridge 提案 §1.1(Platform Compatibility 矩阵)
