---
agent: opencode
cli: opencode
displayName: OpenCode
status: stable
protocol: stdio-mcp
homepage: https://opencode.ai
installCommand: "cortex-agent mcp install opencode (best-effort)"
configPath: ~/.config/opencode/opencode.json
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
limitations:
  - best-effort 路径,需按 opencode 版本验证 key 名(`mcp` vs `mcpServers`)
  - 未跑 pilot
pilot: null
last_verified: 2026-08-20
---

# OpenCode

## 1. Overview

开源 terminal 原生 coding agent。cortex-agent 提供 best-effort 安装;协议为 stdio MCP。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install opencode (best-effort)
# open-design 上游安装
od mcp install opencode
```

## 3. MCP Configuration

```json
{
  "command": "opencode",
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

配置文件: ~/.config/opencode/opencode.json(best-effort — opencode 配置使用 `mcp` key,安装器会警告验证)。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |
| shell:exec | 未实测 — reference 契约 |

## 5. Known Limitations

- best-effort 路径,需按 opencode 版本验证 key 名(`mcp` vs `mcpServers`)
- 未跑 pilot

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- open-design docs/agent-adapters.md
- https://opencode.ai/docs
