---
agent: pi
cli: pi
displayName: Pi Agent
status: reference
protocol: stdio-mcp
homepage: unknown (see open-design agent-adapters)
installCommand: "manual — see pi.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - MCP config 路径未公开 — 安装为 manual
  - Pi 与 cortex-agent 的集成走 M-003 dispatch adapter,不经 stdio MCP(两条独立通道)
pilot: null
last_verified: 2026-08-20
---

# Pi Agent

## 1. Overview

Pi agent — cortex-agent 的 M-003 first-class dispatch adapter(5 adapters 之一),同时是 open-design 上游支持的 stdio MCP agent。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see pi.md
# open-design 上游安装
od mcp install pi
```

## 3. MCP Configuration

```json
{
  "command": "pi",
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

配置文件: unknown — Pi agent 的 MCP config 路径未公开;但 Pi 已有 cortex-agent M-003 dispatch adapter(5 adapters 之一),可直接 `cortex-agent agent dispatch-execute pi:<id>`。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- MCP config 路径未公开 — 安装为 manual
- Pi 与 cortex-agent 的集成走 M-003 dispatch adapter,不经 stdio MCP(两条独立通道)

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- M-003 5-adapters 提案(lib/agents/adapters/pi.js)
- open-design docs/agent-adapters.md
