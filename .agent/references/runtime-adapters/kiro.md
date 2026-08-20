---
agent: kiro
cli: kiro
displayName: Kiro
status: reference
protocol: stdio-mcp
homepage: https://kiro.dev
installCommand: "manual — see kiro.md"
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

# Kiro

## 1. Overview

Amazon 的 Kiro agent(open-design 上游支持 `od mcp install kiro`)。cortex-agent 侧契约已文档化。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see kiro.md
# open-design 上游安装
od mcp install kiro
```

## 3. MCP Configuration

```json
{
  "command": "kiro",
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

配置文件: unknown — Kiro(Amazon)无公开 MCP config 路径,安装为 manual。

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
