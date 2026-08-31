---
agent: reasonix
cli: reasonix
displayName: DeepSeek Reasonix
status: stable
protocol: stdio-mcp
homepage: unknown (see open-design agent-adapters)
installCommand: "manual — see reasonix.md"
configPath: null
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
limitations:
  - config 路径未公开 — `cortex-agent mcp install reasonix` 会警告并拒绝写入(UNKNOWN_CONFIG_PATH)
  - 未跑 pilot,status 为 reference
pilot: null
last_verified: 2026-08-20
---

# DeepSeek Reasonix

## 1. Overview

DeepSeek 的 reasonix CLI agent(open-design 上游支持 `od mcp install reasonix`)。cortex-agent 侧契约已文档化,配置路径待上游确认。

## 2. Installation

```bash
# 一键安装(MCP server)
manual — see reasonix.md
# open-design 上游安装
od mcp install reasonix
```

## 3. MCP Configuration

```json
{
  "command": "reasonix",
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

配置文件: unknown — open-design 上游 `od mcp install reasonix` 会写入其自有路径;cortex-agent 尚未发现公开 config 路径,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |

## 5. Known Limitations

- config 路径未公开 — `cortex-agent mcp install reasonix` 会警告并拒绝写入(UNKNOWN_CONFIG_PATH)
- 未跑 pilot,status 为 reference

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-002 §1.1 注释 (DeepSeek Reasonix)
- open-design docs/agent-adapters.md
