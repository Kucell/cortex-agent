---
agent: devin
cli: devin
displayName: Devin
status: reference
protocol: stdio-mcp
homepage: https://devin.ai
installCommand: "manual — see devin.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - config 路径未公开
  - 云托管 agent — 本地 config 语义与 CLI agent 不同
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# Devin

## 1. Overview

Cognition 的 Devin — 云托管 autonomous agent(open-design 上游支持 `od mcp install devin`)。cortex-agent 侧契约已文档化。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see devin.md
# open-design 上游安装
od mcp install devin
```

## 3. MCP Configuration

```json
{
  "command": "devin",
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

配置文件: unknown — Devin(Cognition)的 MCP config 路径未公开,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- config 路径未公开
- 云托管 agent — 本地 config 语义与 CLI agent 不同
- 未跑 pilot

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- open-design docs/agent-adapters.md
