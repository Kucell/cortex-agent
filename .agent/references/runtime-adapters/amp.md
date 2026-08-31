---
agent: amp
cli: amp
displayName: Amp
status: stable
protocol: stdio-mcp
homepage: https://ampcode.com
installCommand: "manual — see amp.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
limitations:
  - config 路径未公开
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# Amp

## 1. Overview

Sourcegraph 的 Amp coding agent(open-design 上游支持 `od mcp install amp`)。cortex-agent 侧契约已文档化。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see amp.md
# open-design 上游安装
od mcp install amp
```

## 3. MCP Configuration

```json
{
  "command": "amp",
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

配置文件: unknown — Amp(Sourcegraph)的 MCP config 路径未公开,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |

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
