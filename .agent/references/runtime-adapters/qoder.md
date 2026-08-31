---
agent: qoder
cli: qoder
displayName: Qoder
status: stable
protocol: stdio-mcp
homepage: https://qoder.com
installCommand: "cortex-agent add qoderclicn (M-026) + manual MCP"
configPath: .qoder/ (project) / ~/.qoder-cn/ (CN memories)
mcpBridge: null
capabilities:
  - prompt:inject
  - file:read
  - file:write
limitations:
  - 与 Qoder 内置命令同名的工作流会被 Qoder 自动重命名(如 /plan1),属宿主冲突处理
  - MCP config 路径未公开 — manual
pilot: null
last_verified: 2026-08-20
---

# Qoder

## 1. Overview

MiniMax 的 Qoder IDE / CLI。M-026 已 ship 符号链接集成(`cortex-agent add qoderclicn`);MCP bridge 安装为 manual。

## 2. Installation

```bash
# 一键安装(MCP server)
cortex-agent add qoderclicn (M-026) + manual MCP
# open-design 上游安装
od mcp install qoder
```

## 3. MCP Configuration

```json
{
  "command": "qoder",
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

集成: M-026 platform-integration 已 ship `cortex-agent add qoderclicn`(创建 .qoder/commands|agents|skills 符号链接)。MCP config 路径未公开,安装为 manual。

## 4. Verified Capabilities

| Capability | 验证状态 |
| :--- | :--- |
| prompt:inject | 未实测 — reference 契约 |
| file:read | 未实测 — reference 契约 |
| file:write | 未实测 — reference 契约 |

## 5. Known Limitations

- 与 Qoder 内置命令同名的工作流会被 Qoder 自动重命名(如 /plan1),属宿主冲突处理
- MCP config 路径未公开 — manual

## 6. Pilot Project

```text
(null — 待验证; 跑通后更新 status → shipped)
```

## 7. References

- open-design README "Platform Compatibility" / docs/agent-adapters.md
- M-026 platform-integration 提案(docs/platform-integration.md)
- open-design docs/agent-adapters.md
