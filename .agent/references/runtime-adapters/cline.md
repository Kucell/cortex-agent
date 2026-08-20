---
agent: cline
cli: cline
displayName: Cline
status: reference
protocol: stdio-mcp
homepage: https://cline.bot
installCommand: "cortex-agent mcp install cline (best-effort)"
configPath: ~/.cline/mcp_settings.json
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - best-effort 路径 — cline 同时支持项目级 .cline/mcp_settings.json
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# Cline

## 1. Overview

VS Code 的开源 agent 插件 Cline。通过 stdio MCP 接入;best-effort 全局配置路径。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install cline (best-effort)
# open-design 上游安装
od mcp install cline
```

## 3. MCP Configuration

```json
{
  "command": "cline",
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

配置文件: ~/.cline/mcp_settings.json(best-effort;cline 的全局 MCP 设置在 ~/.cline/)。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- best-effort 路径 — cline 同时支持项目级 .cline/mcp_settings.json
- 未跑 pilot

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- open-design docs/agent-adapters.md
- https://cline.bot
