---
agent: codex
cli: codex
displayName: Codex CLI
status: stable
protocol: stdio-mcp
homepage: https://developers.openai.com/codex/
installCommand: "cortex-agent mcp install codex"
configPath: ~/.codex/config.toml
mcpBridge: P-002
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - TOML 配置格式,非 JSON — 安装器按 section 追加,已有 cortex-agent section 会被替换
  - MCP tools 默认 read-only
pilot: null
last_verified: 2026-08-20
---

# Codex CLI

## 1. Overview

OpenAI 官方的 CLI agent。通过 stdio MCP 接入 cortex-agent 资产;TOML 配置由 `cortex-agent mcp install codex` 写入。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install codex
# open-design 上游安装
od mcp install codex
```

## 3. MCP Configuration

```json
{
  "command": "codex",
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

配置文件: ~/.codex/config.toml(TOML,`[mcp_servers.<name>]` section)。cortex-agent 安装器追加/替换 `[mcp_servers.cortex-agent]`。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 实测通过 (P-002 MCP bridge pilot) |
| file:read | 实测通过 (P-002 MCP bridge pilot) |
| file:write | 实测通过 (P-002 MCP bridge pilot) |
| shell:exec | 实测通过 (P-002 MCP bridge pilot) |

## 5. Known Limitations

- TOML 配置格式,非 JSON — 安装器按 section 追加,已有 cortex-agent section 会被替换
- MCP tools 默认 read-only

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 mcp-bridge 提案 §4.4
- docs/architecture/mcp-bridge.md
