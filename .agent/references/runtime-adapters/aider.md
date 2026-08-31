---
agent: aider
cli: aider
displayName: Aider
status: reference
protocol: stdio-mcp
homepage: https://aider.chat
installCommand: "manual — see aider.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - config 路径未公开
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# Aider

## 1. Overview

Aider — 老牌 terminal pair-programming agent(open-design 上游支持 `od mcp install aider`)。cortex-agent 侧契约已文档化。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see aider.md
# open-design 上游安装
od mcp install aider
```

## 3. MCP Configuration

```json
{
  "command": "aider",
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

配置文件: unknown — aider 的 MCP config 路径未公开,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- config 路径未公开
- 未跑 pilot

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- open-design docs/agent-adapters.md
