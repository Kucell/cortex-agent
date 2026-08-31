---
agent: dsh
cli: dsh
displayName: DeepSeek Harness
status: shipped
protocol: native
homepage: https://github.com/deepseek-ai/deepseek-harness
installCommand: "cortex-agent mcp install dsh"
configPath: ~/.config/dsh/mcp.json
mcpBridge: P-006
capabilities:
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
  - model:discover
  - stream:structured
  - tool:cancel
  - session:resume
limitations:
  - native runtime,不走 stdio MCP — open-design daemon 直接 spawn `dsh` 子进程(P-006)
  - SSRF guard 在 open-design daemon 侧
  - cortex-agent 通过 P-002 MCP bridge 暴露 MCP tools 供 dsh 消费,反向通过 dsh structured stream 接收输出
  - 详见 .agent/projects/dsh-* (M-029 / P-006 提案)与 docs/architecture/dsh-host-adapter.md
pilot: dsh-market-publishing
last_verified: 2026-08-20
---

# DeepSeek Harness

## 1. Overview

DeepSeek 官方的 agent harness,open-design 的 first-class native runtime。dsh 提供结构化 thinking / 工具调用 / 模型发现 / 取消 / session resume;P-006 已把 dsh 接入 cortex-agent 的 dispatch adapter 体系。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent mcp install dsh
# open-design 上游安装
od agent setup deepseek-harness
```

## 3. MCP Configuration

```json
{
  "command": "dsh",
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

配置文件: ~/.config/dsh/mcp.json(P-006 已 ship 的 dsh MCP 配置路径)。cortex-agent MCP server 通过 `mcpServers.cortex-agent` 追加。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 实测通过 (P-002 MCP bridge pilot) |
| file:read | 实测通过 (P-002 MCP bridge pilot) |
| file:write | 实测通过 (P-002 MCP bridge pilot) |
| shell:exec | 实测通过 (P-002 MCP bridge pilot) |
| model:discover | 未实测 — reference 契约 |
| stream:structured | 未实测 — reference 契约 |
| tool:cancel | 未实测 — reference 契约 |
| session:resume | 未实测 — reference 契约 |

## 5. Known Limitations

- native runtime,不走 stdio MCP — open-design daemon 直接 spawn `dsh` 子进程(P-006)
- SSRF guard 在 open-design daemon 侧
- cortex-agent 通过 P-002 MCP bridge 暴露 MCP tools 供 dsh 消费,反向通过 dsh structured stream 接收输出
- 详见 .agent/projects/dsh-* (M-029 / P-006 提案)与 docs/architecture/dsh-host-adapter.md

## 6. Pilot Project

```text
dsh-market-publishing: <project-path>
验证: 2026-08-20
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- P-006 dsh first-class adapter 提案(.agent/projects/dsh-*)
- M-029 验收报告
- docs/architecture/dsh-host-adapter.md
