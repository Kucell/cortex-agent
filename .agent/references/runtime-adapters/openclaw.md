---
agent: openclaw
cli: openclaw
displayName: OpenClaw
status: reference
protocol: stdio-mcp
homepage: https://openclaw.ai
installCommand: "cortex-agent mcp install openclaw (best-effort)"
configPath: ~/.openclaw/openclaw.json
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - shell:exec
limitations:
  - best-effort 路径,需按 openclaw 版本验证
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# OpenClaw

## 1. Overview

OpenClaw(原 Clawdbot)开源 agent。cortex-agent 提供 best-effort 安装;协议为 stdio MCP。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install openclaw (best-effort)
# open-design 上游安装
od mcp install openclaw
```

## 3. MCP Configuration

```json
{
  "command": "openclaw",
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

配置文件: ~/.openclaw/openclaw.json(best-effort)。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- best-effort 路径,需按 openclaw 版本验证
- 未跑 pilot

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- open-design docs/agent-adapters.md
