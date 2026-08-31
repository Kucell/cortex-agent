# Runtime Adapters — 26-Agent 契约

> **项目**: open-design-integration (P-004)
> **状态**: MS-003 shipped (2026-08-20)
> **机器可读索引**: [`_index.json`](./_index.json) · **文档规范**: [`_schema.md`](./_schema.md)
> **配套**: [P-002 MCP bridge](../../plans/proposals/projects/open-design-integration/proposals/P-002-mcp-bridge-proposal.md) · `P-006 dsh first-class adapter` · [docs/architecture/runtime-adapter.md](../../../docs/architecture/runtime-adapter.md)

## 1. 这是什么

open-design 上游 ship 了 **27 runtime definitions × 26 distinct coding-agent CLIs**(Claude Code / Codex / Cursor / dsh / Hermes / Kimi / Pi / Kiro / Mistral Vibe / OpenCode / OpenClaw / Copilot / Cline / Trae / Raven / Reasonix / Qwen / Qoder / Aider / Amp / CodeBuddy / Mimo / AtomCode / Devin / Antigravity ...),其中 **DeepSeek Harness (dsh) 是 first-class native runtime**(P-006 已 ship)。

本目录把 open-design 的 runtime-adapter 契约翻译成 cortex-agent 的 **26 份 `<agent>.md` 契约文档** + 机器可读 `_index.json`,让 cortex-agent 用户在 26 个 agent 之间切换时,能快速了解每个 agent 的 CLI 名称 / 协议 / MCP 安装方式 / 已知限制 / pilot 验证状态。

**分层(L1 = 已 ship,L2 = 待 reference,不阻塞)**:`status: shipped` 表示已被 P-002 / P-006 覆盖并实际可安装;`status: reference` 表示契约已文档化,安装方式为 best-effort 或 manual。

## 2. 26-Agent 矩阵

| # | Agent | CLI | Protocol | Status | cortex-agent 集成 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | [claude](./claude.md) | `claude` | stdio-mcp | ✅ shipped | `cortex-agent mcp install claude` (P-002) |
| 2 | [claude-desktop](./claude-desktop.md) | `claude-desktop` | stdio-mcp | 📄 reference | `cortex-agent mcp install claude-desktop` (macOS/Win) |
| 3 | [codex](./codex.md) | `codex` | stdio-mcp | ✅ shipped | `cortex-agent mcp install codex` (P-002, TOML) |
| 4 | [dsh](./dsh.md) | `dsh` | native | ✅ shipped | `cortex-agent mcp install dsh` (P-006 first-class) |
| 5 | [reasonix](./reasonix.md) | `reasonix` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 6 | [raven](./raven.md) | `raven` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 7 | [cursor](./cursor.md) | `cursor` | stdio-mcp | ✅ shipped | `cortex-agent mcp install cursor` (P-002) |
| 8 | [copilot](./copilot.md) | `copilot` | stdio-mcp | ✅ shipped | `cortex-agent mcp install copilot` (P-002) |
| 9 | [opencode](./opencode.md) | `opencode` | stdio-mcp | 📄 reference | `cortex-agent mcp install opencode` (best-effort) |
| 10 | [openclaw](./openclaw.md) | `openclaw` | stdio-mcp | 📄 reference | `cortex-agent mcp install openclaw` (best-effort) |
| 11 | [antigravity](./antigravity.md) | `antigravity` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 12 | [cline](./cline.md) | `cline` | stdio-mcp | 📄 reference | `cortex-agent mcp install cline` (best-effort) |
| 13 | [trae](./trae.md) | `trae` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 14 | [kimi](./kimi.md) | `kimi` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 15 | [kiro](./kiro.md) | `kiro` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 16 | [pi](./pi.md) | `pi` | stdio-mcp | 📄 reference | manual (待 P-004 pilot;M-003 dispatch adapter 已 ship) |
| 17 | [vibe](./vibe.md) | `vibe` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 18 | [hermes](./hermes.md) | `hermes` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 19 | [qoder](./qoder.md) | `qoder` | stdio-mcp | 📄 reference | `cortex-agent add qoderclicn` (M-026) + manual MCP |
| 20 | [qwen](./qwen.md) | `qwen` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 21 | [aider](./aider.md) | `aider` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 22 | [amp](./amp.md) | `amp` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 23 | [codebuddy](./codebuddy.md) | `codebuddy` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 24 | [mimo](./mimo.md) | `mimo` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 25 | [atomcode](./atomcode.md) | `atomcode` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |
| 26 | [devin](./devin.md) | `devin` | stdio-mcp | 📄 reference | manual (待 P-004 pilot) |

> **图例**: ✅ shipped = P-002 / P-006 已覆盖,`cortex-agent mcp install <agent>` 可直接写入配置;📄 reference = 契约已文档化,安装为 best-effort(`mcp install` 会警告)或 manual。

## 3. 快速使用

```bash
# 查看某个 agent 的契约
cortex-agent agent show dsh          # 等价 cat .agent/references/runtime-adapters/dsh.md

# 一键安装 cortex-agent MCP server 到 agent(已 ship 的 agent)
cortex-agent mcp install claude --dry-run --print   # 先预览 JSON
cortex-agent mcp install claude                     # 写入 ~/.claude/mcp_servers.json

# 验证
cortex-agent mcp ping --timeout 5s
```

## 4. Status 提升路径

1. `reference` → 用户实际跑通 `cortex-agent mcp install <agent>` + pilot 调用
2. 更新 `<agent>.md` 的 `status: shipped` + `pilot` + `last_verified`
3. 同步更新 `_index.json`(文档是真相,index 由文档生成)

## 5. 非目标(P-004 §3)

- **不重写每个 agent 的 adapter**: open-design 上游 `apps/daemon/src/runtimes/defs/` 已实现,本目录只沉淀契约
- **不 ship BYOK providers**: 8 个 BYOK(openai/anthropic/azure/google/ollama/lmstudio/vllm/atlas-cloud)留在 open-design 上游
- **不强制 26 个 agent 都 ship Cortex 集成**: `reference` 状态不阻塞任何使用
