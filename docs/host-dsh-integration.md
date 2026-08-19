# DSH (DeepSeek Harness) Integration Guide

> **Status**: `first-class dispatch adapter`（M-029 / P-006，2026-08-19 批准 `D-ARI-P006-promote-dsh-firstclass`）
> **参考实现**: `lib/agents/adapters/dsh.js` + `lib/agents/adapters/dsh-bootstrap.js`
> **注册路径**: `lib/agents/adapters/index.js#_seed()` try/catch + `lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT` + `lib/coordination/adapter-core.js#REGISTERED_ADAPTER_IDS`

DSH（DeepSeek Harness）以与 Pi / Claude Code / Codex CLI 同等地位接入 Cortex Agent：通过 `cortex-agent add dsh` 下发模板，通过 `agent dispatch-execute dsh:<id>` 执行派发。本文档与 `docs/host-claude-code-integration.md` / `docs/host-codex-integration.md` 对齐，共四节。

## 1. 安装与 PATH

```bash
# 1. 安装 DSH CLI（参考 DSH 官方文档；本仓库不内置）
#    确保 `dsh` 在 PATH 中：
which dsh

# 2. 验证 adapter 探测
cortex-agent agent adapter health dsh
# 期望：ready: true（DSH CLI 存在且可解析）

# 3. 可选：DSH_BIN 环境变量覆盖默认 "dsh" 二进制路径（与 PI_BIN / CODEX_BIN 同位）
export DSH_BIN=/custom/path/to/dsh
```

> **fail-closed 语义**：DSH CLI 未安装 / 不在 PATH 时，`health()` 返回 `ready: false`（`ERR_ADAPTER_SPAWN`），`invoke()` 写 `error.json` + `rollback.json` 后返回结构化失败；不影响其他宿主。

## 2. DSH → Cortex agent 注册

```bash
# 1. 项目初始化（生成根 AGENTS.md 与 .agent/）
cortex-agent init

# 2. 添加 DSH 平台集成
cortex-agent add dsh
# 产物：
#   .dsh/settings.json   （skills/prompts 指向 .agent/，merge 保留用户已有配置）
#   .dsh/README.md
#   .dsh/AGENTS.md
#   符号链接：.dsh/skills → .agent/skills、.dsh/workflows → .agent/workflows

# 3. 验证注册
cortex-agent agent adapter list          # 应包含 dsh
cortex-agent list                        # 已安装平台应包含 dsh
```

**Agent 条目**（`.agent/agents/<id>.json`）使用 `external.adapter_type = "dsh"`。该类型经 `VALID_ADAPTER_TYPES_EXT`（additive 扩展）校验通过；`lib/agents/registry.js`（M-002 frozen）保持零修改。

## 3. dispatch / cancel / report 调用范例

```bash
# 显式手动派发（需要 agent 条目已注册且 external.adapter_type === "dsh"）
cortex-agent agent dispatch-execute dsh:Worker-A "review the schema"

# 显式加载 bootstrap（可选，等价于 _seed() 自动注册）
NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
  cortex-agent agent adapter health dsh

# cancel / report 走标准 dispatch journal（.agent-runtime/dispatch/<runId>/）
#   request.json / result.json / error.json / rollback.json / rollback-failed.json
```

**JSON-RPC 协议形状**（P-006 §4.3 假设；MS-003 由 fake binary 测试覆盖）：

```text
$ dsh --json --run-id <runId> --task "<task>" [--input <input>] [--config <configRef>] [--model <model>]
  stdin  : JSON-RPC 2.0 request（单行 / LF-terminated）
  stdout : JSON-RPC 2.0 response（plain JSON 或 Content-Length framing）
  stderr : diagnostics（non-JSON）
```

**6 类失败模式**（全部写 `error.json` + `rollback.json` 或 `rollback-failed.json` + `notify_parent: true`）：

| 场景 | error code |
| :--- | :--- |
| binary 缺失 / spawn 失败 | `ERR_ADAPTER_SPAWN` |
| 非零退出（含 `exit_code` / `signal` / stderr 摘录） | `ERR_DISPATCH_FAILED` |
| 超时（SIGTERM → 1.5s SIGKILL 兜底） | `ERR_DISPATCH_TIMEOUT` |
| stdout 非 JSON / 空 | `ERR_JSONRPC_PARSE` |
| JSON-RPC error envelope | `ERR_DSH_<code>` |
| rollback 写失败 | `rollback-failed.json` + `notify_parent: true` |

## 4. 已知限制

1. **协议假设未固化**：DSH CLI 真实协议与 §3 假设是否一致尚未在仓库内固化证据。实施期 `health()` 只做 binary 探测；`discover().transport` 在验证真实 CLI 前保持 `stdio-json-rpc` 假设。若真实 CLI 不兼容，需在后续提案中把 transport 改为探测结果并调整 `_parseJsonRpc`。
2. **tool gate 未启用**：`tool.before.observe` / `tool.before.block` 标记 `unsupported`（P-001 冻结词汇），待 M-018（P-006 Phase 5）验证 DSH 真实 hook 能力后另行接入。
3. **不读取会话存储**：dispatch adapter 不读 `~/.dsh/sessions/`；usage 测量由 `scripts/dsh-usage-sync.js`（shadow）单独维护，两者互不依赖。
4. **无自动 dispatch**：DSH agent 保持 opt-in；`cortex-agent add dsh` 不启用 daemon / 自动调度。
5. **零 npm 依赖**：`dsh.js` / `dsh-bootstrap.js` 只用 Node.js 内置模块（`node:child_process` / `node:fs` / `node:path`），继承 `bin/cli.js` 零依赖原则。

---

> 返回：[平台集成](./platform-integration.md) | [Adapter Authoring](./architecture/adapter-authoring.md)
