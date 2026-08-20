# Runtime Adapter — 26-agent registry architecture (P-004 MS-003)

> **目的**: 把 open-design 上游的 runtime adapter 矩阵(27 runtime definitions × 26 distinct coding-agent CLIs)沉淀为 cortex-agent 结构化的 26 份契约文档 + 机器可读索引,让用户在 26 个 agent 之间切换时快速了解每个 agent 的 CLI / 协议 / MCP 安装 / 已知限制。
> **状态**: P-004 MS-003 shipped (2026-08-20)
> **版本**: v1.0
> **关联**: [P-004-runtime-adapter-proposal.md](../../.agent/plans/proposals/projects/open-design-integration/proposals/P-004-runtime-adapter-proposal.md) · [MS-003.md](../../.agent/missions/M-ODI-001/milestones/MS-003.md) · [mcp-bridge.md](./mcp-bridge.md)
> **位置**: `.agent/references/runtime-adapters/`

---

## 1. 背景与动机

cortex-agent 的用户在 16+ agent 之间切换时,缺少统一的"每个 agent 与 `.agent/` 的兼容性"契约:

- **dsh** 已被 M-029 / P-006 ship 为 first-class native runtime
- **Qoder** 已被 M-026 ship(符号链接集成)
- **Claude Code / Cursor / Codex / Copilot** 通过 P-002 间接覆盖(stdio MCP)
- 其余 agent 只有零散支持,没有结构化的 runtime-adapter 契约

P-004 沉淀 26 份 `<agent>.md` 契约文档 + `_index.json` 机器可读索引,作为 P-002(stdio MCP bridge)与 P-006(dsh first-class)的**上层目录**。

---

## 2. 目标 / 非目标

### 目标

| # | Goal |
| :--- | :--- |
| G1 | `.agent/references/runtime-adapters/<agent>.md` 26 份契约文档 |
| G2 | `_schema.md` 统一 frontmatter + sections 规范(CI 可校验) |
| G3 | `_index.json` 机器可读索引(`agents[]`,被 `cortex-agent agent list --json` 消费) |
| G4 | dsh.md 引用 P-006,不重新发明 |
| G5 | 至少 3 个 agent(dsh / claude / cursor)有真实 pilot 验证 |

### 非目标(P-004 §3)

- ❌ 不重写每个 agent 的 adapter — open-design 上游 `apps/daemon/src/runtimes/defs/` 已实现
- ❌ 不 ship 8 个 BYOK provider 文档(openai/anthropic/azure/google/ollama/lmstudio/vllm/atlas-cloud)— 留在 open-design 上游
- ❌ 不接管 open-design 的 BYOK proxy / provider registry

---

## 3. 核心设计

### 3.1 目录结构

```text
.agent/references/runtime-adapters/
├── README.md        # 总览 + 26 agent 矩阵表
├── _schema.md       # frontmatter schema + 7-section 模板 + 校验规则
├── _index.json      # machine-readable 索引 (agents[])
├── claude.md        # Claude Code (shipped, P-002)
├── claude-desktop.md
├── codex.md         # Codex CLI (shipped, P-002)
├── dsh.md           # DeepSeek Harness (shipped, P-006, native)
├── cursor.md        # (shipped, P-002)
├── copilot.md       # (shipped, P-002)
├── reasonix.md / raven.md / opencode.md / openclaw.md / antigravity.md
├── cline.md / trae.md / kimi.md / kiro.md / pi.md / vibe.md / hermes.md
├── qoder.md / qwen.md / aider.md / amp.md / codebuddy.md / mimo.md
├── atomcode.md / devin.md
└── ... 共 26 个 <agent>.md
```

### 3.2 Schema(`_schema.md`)

每个 `<agent>.md` 的 frontmatter 必填字段:

| 字段 | 类型 / 枚举 | 说明 |
| :--- | :--- | :--- |
| `agent` | string | canonical id,与文件名一致 |
| `cli` | string | CLI 二进制名 |
| `displayName` | string | 人类可读名 |
| `status` | `shipped` / `reference` / `pending` | shipped = P-002/P-006 已覆盖 |
| `protocol` | `stdio-mcp` / `http` / `native` / `byok` / `private` | dsh 唯一 native |
| `homepage` | string | 官方主页(未知显式标注) |
| `installCommand` | string | `cortex-agent mcp install <agent>` / `manual` |
| `configPath` | path / `null` | agent 配置文件路径 |
| `mcpBridge` | `P-002` / `P-006` / `null` | 引用提案 |
| `capabilities` | string[] | 能力声明(冻结词汇) |
| `limitations` | string[] | 已知限制 |
| `pilot` | slug / `null` | pilot 验证 |
| `last_verified` | `YYYY-MM-DD` | 最近验证日期 |

7 个 H2 sections:Overview / Installation / MCP Configuration / Verified Capabilities / Known Limitations / Pilot Project / References。

### 3.3 索引(`_index.json`)

```jsonc
{
  "schemaVersion": "od-runtime-adapter/v1",
  "agents": [
    { "id": "claude", "cli": "claude", "displayName": "Claude Code",
      "protocol": "stdio-mcp", "status": "shipped",
      "mcp_install_cmd": "cortex-agent mcp install claude",
      "config_path": "~/.claude/mcp_servers.json",
      "source": "open-design:agent-adapters", "mcpBridge": "P-002", "pilot": "csm-view-memory" },
    // ... 26 entries
  ]
}
```

- `agents[]` 每个 entry 携带 `{id, cli, protocol, status, mcp_install_cmd, config_path, source}`(外加 displayName / homepage / mcpBridge / pilot)
- **文档是真相,index 由文档生成**(单向)— 修改 `<agent>.md` 必须同步 `_index.json`

### 3.4 状态矩阵(26 agents)

| Status | Agents | 说明 |
| :--- | :--- | :--- |
| ✅ shipped (5) | claude, codex, cursor, copilot (P-002), dsh (P-006) | `cortex-agent mcp install <agent>` 直接可用 |
| 📄 reference (21) | claude-desktop, reasonix, raven, opencode, openclaw, antigravity, cline, trae, kimi, kiro, pi, vibe, hermes, qoder, qwen, aider, amp, codebuddy, mimo, atomcode, devin | 契约已文档化,best-effort 或 manual |

**提升路径**: reference → 跑通 `cortex-agent mcp install <agent>` + pilot → status 改 shipped + 更新 pilot / last_verified。

---

## 4. 与 P-002 / P-006 的关系

| 维度 | P-002 mcp-bridge | P-006 dsh first-class | P-004 runtime-adapter |
| :--- | :--- | :--- | :--- |
| 范围 | 16+ agent stdio MCP 接入 | dsh native runtime 接入 | 26 agent 契约沉淀 |
| 形态 | 代码 + CLI | 代码 + apps/dsh/ | 文档 + index |
| 实现度 | ✅ shipped (MS-003) | ✅ shipped (M-029) | ✅ shipped (MS-003) |
| 关系 | 互补 | 互补 | **横切上层目录** |

---

## 5. 测试与校验

`tests/runtime-adapters/index.test.js`(12 tests,无 agent 特定逻辑):

1. README / _schema / _index 存在
2. `_index.json` schemaVersion = `od-runtime-adapter/v1`
3. `agents[]` 恰好 26 个,id 唯一
4. 每个 id 有对应 `<id>.md`,无孤儿文档
5. frontmatter 含全部必填字段
6. status / protocol / mcpBridge 枚举合法
7. `last_verified` 匹配 `YYYY-MM-DD`
8. 7 sections 齐全
9. index ↔ frontmatter 字段一致(id / cli / protocol / status / pilot)
10. dsh.md 引用 P-006 + `.agent/projects/dsh-*`
11. claude / codex / cursor / copilot 引用 P-002
12. README 矩阵覆盖全部 26 agent

---

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解 |
| :--- | :--- | :--- | :--- |
| R1 | open-design 上游 agent adapter 演进 | 中 | `last_verified` 追踪 + index 由文档生成 |
| R2 | 跨平台配置路径差异 | 中 | `configPath` 显式标注 + install.js per-agent 表 |
| R3 | 部分 agent 未公开 MCP 安装协议 | 低 | `installCommand: "manual"` + 详细 step-by-step |
| R4 | dsh native 与其他 stdio MCP 抽象不一致 | 中 | `protocol` 字段区分;P-006 vs P-002 互斥 |
| R5 | 文档漂移(26 agent × 上游演进) | 中 | `_schema.md` 强制 frontmatter 校验,CI 检测 |

---

## 7. 后续(Out of Scope)

- **Phase 4**: `cortex-agent agent benchmark`(26 agent 全链路 benchmark)
- **Phase 5**: `cortex-agent agent onboard`(自动探测 CLI / MCP 协议 → 生成 `<agent>.md`)
- **Phase 6**: `cortex-agent agent sync`(与 open-design 上游 runtime registry 同步)
- **Phase 7**: runtime-adapter × skill-dispatch quad-layer 整合
