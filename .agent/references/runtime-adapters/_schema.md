# Runtime Adapter 文档规范 (`_schema.md`)

> 每个 `.agent/references/runtime-adapters/<agent>.md` 必须遵循本 schema。
> 被 `cortex-agent agent list --json` 与 `tests/runtime-adapters/index.test.js` 消费。

## 1. Frontmatter Schema

```yaml
---
agent: <canonical-id>          # 必须: 与文件名一致 (claude | codex | dsh | ...)
cli: <cli-binary-name>         # 必须: 命令行二进制名 (claude | codex | dsh | ...)
displayName: <human-name>      # 必须: "Claude Code" | "Codex CLI" | ...
status: shipped | reference | pending   # 必须: shipped = P-002/P-006 已 ship; reference = 已文档化未 ship; pending = 待办
protocol: stdio-mcp | http | native | byok | private  # 必须
homepage: <url>                # 可选: 官方主页; 未知填 "unknown (see open-design agent-adapters)"
installCommand: <string>       # 必须: "cortex-agent mcp install <agent>" | "od mcp install <agent>" | "od agent setup <agent>" | "manual"
configPath: <path> | null      # 必须: agent 配置文件路径 (~ 开头); 未知填 null
mcpBridge: P-002 | P-006 | null  # 必须: 引用 cortex-agent MCP bridge 提案
capabilities:                  # 必须: 非空数组
  - prompt:inject
  - file:read
  - file:write
  - shell:exec
  # 可选: model:discover / stream:structured / tool:cancel / session:resume / ...
limitations:                   # 必须: 非空数组
  - <known limits>
pilot: <project-slug> | null   # 必须: 已验证 pilot 项目; 未验证填 null
last_verified: <YYYY-MM-DD>    # 必须
---
```

### 字段枚举

| 字段 | 合法值 | 说明 |
| :--- | :--- | :--- |
| `status` | `shipped` / `reference` / `pending` | `shipped` = P-002 MCP bridge 或 P-006 dsh adapter 已 ship;`reference` = 契约已文档化但未集成;`pending` = 待办 |
| `protocol` | `stdio-mcp` / `http` / `native` / `byok` / `private` | `native` 仅 dsh(P-006 first-class native runtime);`byok` 保留给上游 open-design BYOK providers(P-004 §3 N3,不在本仓库 ship) |
| `mcpBridge` | `P-002` / `P-006` / `null` | `P-002` = stdio MCP bridge 覆盖;`P-006` = dsh first-class adapter;`null` = 未覆盖 |

## 2. Section 模板

每个 `<agent>.md` 必须包含以下 7 个 H2 section(顺序固定):

```markdown
# <Display Name>

## 1. Overview
<1-3 句简介: 官方定位 + 在 open-design / cortex-agent 中的角色>

## 2. Installation
```bash
# 一键安装(MCP server)
cortex-agent mcp install <agent>
# open-design 上游安装(如适用)
od mcp install <agent>
```

## 3. MCP Configuration
```json
{
  "command": "<cli>",
  "args": ["mcp", "serve"],
  "env": {
    "CORTEX_AGENT_PROJECT_ROOT": "<cwd>",
    "CORTEX_AGENT_MCP_TOKEN": "<hex32>"
  }
}
```
<configPath 说明; format: json | toml | unknown>

## 4. Verified Capabilities
<测试矩阵: 逐条列出 frontmatter capabilities 的实际验证情况>

## 5. Known Limitations
<跟 open-design / cortex-agent 的差异; 平台限制; 未验证项>

## 6. Pilot Project
```text
<project-slug>: <path>
验证: <YYYY-MM-DD>
```

## 7. References
- open-design README "Platform Compatibility" / docs/agent-adapters.md
- cortex-agent 提案 / 架构文档(P-002 / P-004 / P-006)
- agent 官方文档
```

## 3. 校验规则(`tests/runtime-adapters/index.test.js`)

1. `.agent/references/runtime-adapters/` 下存在 26 个 `<agent>.md`(清单见 `_index.json#agents`)
2. 每个文件 frontmatter 可解析,且含全部必填字段
3. `status` ∈ {shipped, reference, pending};`protocol` ∈ {stdio-mcp, http, native, byok, private}
4. `mcpBridge` ∈ {P-002, P-006, null};`pilot` 允许 null
5. `last_verified` 匹配 `YYYY-MM-DD`
6. `_index.json` 的 `agents[]` 与 `.md` 文件一一对应(id 一致)
7. `dsh.md` 必须引用 P-006 / `.agent/projects/dsh-*`;`claude.md` / `codex.md` / `cursor.md` / `copilot.md` 必须引用 P-002
8. `README.md` 矩阵覆盖全部 26 个 agent

## 4. 维护约定

- **文档是真相**: 修改 `<agent>.md` 后必须同步更新 `_index.json`(单向,index 由文档生成)
- **BYOK 不在此目录**: 8 个 BYOK provider(openai/anthropic/azure/google/ollama/lmstudio/vllm/atlas-cloud)留在 open-design 上游(P-004 §3 N3),cortex-agent 只引用不 ship
- **status 提升路径**: `reference` → 通过 P-002 `cortex-agent mcp install <agent>` 实际跑通 pilot 后 → `shipped`,并更新 `pilot` / `last_verified`
