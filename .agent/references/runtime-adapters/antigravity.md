---
agent: antigravity
cli: antigravity
displayName: Antigravity
status: stable
protocol: stdio-mcp
homepage: https://antigravity.google
installCommand: "manual — see antigravity.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
limitations:
  - config 路径未公开
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# Antigravity

## 1. Overview

Google 的 Antigravity agent(open-design 上游支持 `od mcp install antigravity`)。cortex-agent 侧契约已文档化。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see antigravity.md
# open-design 上游安装
od mcp install antigravity
```

## 3. MCP Configuration

```json
{
  "command": "antigravity",
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

配置文件: unknown — Google Antigravity 无公开 MCP config 路径,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |

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
