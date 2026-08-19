# P-006：DSH Host Adapter (first-class)

> **状态**: `done`（M-029 COMPLETE，2026-08-19；MS-001～MS-004 PASS + MS-005 WAIVED-OPTIONAL）
> **执行载体**: `M-029`（`/approve` mission 调度后建立）  
> **创建日期**: `2026-08-19`  
> **批准日期**: `2026-08-19`  
> **批准证据**: `D-ARI-P006-promote-dsh-firstclass.json`（architecture / approved / interactive-user）  
> **关联决策**: `D-TCP-004-add-dsh-host`（已 approved，仅授权 shadow usage + backfill，本提案接续授权 dispatch）  
> **关联 Waitpoint**: `WP-rsl-dsh-host-shadow-20260819`（已 released，仅覆盖 shadow scope）+ `WP-ari-p006-impl`（pending，由 M-029 在 CONTRACT 阶段 release）  
> **核心目标**: 把 DeepSeek Harness (DSH) 从"Token Control Plane 第三 governed shadow host"提升为"与 Pi / Claude Code / Codex CLI 同等地位的 first-class dispatch adapter"，补齐 `discover/health/invoke/cancel/report` 五方法契约、模板、文档、测试、注册与决策门禁。  
> **范围**: 同 M-003 MS-001 / MS-002 的 Pi / Codex / Claude Code adapter 模式；与 P-003 (Pi Reference Adapter Pilot) 是兄弟提案而非替代关系。

## 1. 背景与现状

### 1.1 已有支持

| Host | dispatch adapter | 模板集成 | 文档 | 测试 |
| :--- | :--- | :--- | :--- | :--- |
| Claude Code | `lib/agents/adapters/claude-code.js`（MS-001 F-002，582 行） | `templates/{zh,en}/integrations/claude/CLAUDE.md` | `docs/platform-integration.md` §Claude Code + `docs/architecture/adapter-authoring.md` | `tests/agent/agent-adapter-claude-code.test.js` |
| Codex CLI | `lib/agents/adapters/codex.js`（MS-002 F-003，602 行） | `templates/{zh,en}/integrations/codex/.codex/{config.toml,README.md}` | 同上 + `docs/host-codex-integration.md` | `tests/agent/agent-adapter-codex.test.js` |
| Pi | `lib/agents/adapters/pi.js`（MS-002 F-005，614 行）+ `codey-pi-bootstrap.js` | `templates/{zh,en}/integrations/pi/settings.json` | `docs/architecture/agent-runtime-interoperability` + `docs/platform-integration.md` | `tests/agent/agent-adapter-pi.test.js` |
| Minimax | `lib/agents/adapters/minimax.js`（MS-003） | （待 P-006 完成对照） | 同上 | `tests/agent/agent-adapter-minimax.test.js` |

### 1.2 DSH 当前状态

DSH 已经是 Token Control Plane（TCP）的第三个 governed shadow host（`D-TCP-004`），但**只是 usage measurement 维度**：

- `lib/host-adapter/shadow-usage/dsh-shadow.js`（104 行）—— `DshShadowAdapter` 提供 `detectUsage / normalizeUsage / createShadowReceipt`，仅写入 `token-attempt` ledger，不发起 dispatch。
- `scripts/dsh-usage-sync.js`（390 行）—— 流式 backfill `~/.dsh/sessions/<slug>/session-*/session.jsonl.zstd`，把 `assistant/chunk.usage` 映射为 MS-001 canonical receipt。
- 测试 24/24 PASS（`tests/host-adapter/shadow-usage/dsh-shadow.test.js` 13 + `tests/scripts/dsh-usage-sync.test.js` 11），回放 832 receipts。
- 真实数据已写入 `~/.dsh/sessions/<slug>/session-*/session.jsonl.zstd`，DSH 具备可审计的 session envelope。

### 1.3 缺口

| 缺口 | 影响 | 备注 |
| :--- | :--- | :--- |
| `lib/agents/adapters/dsh.js` 不存在 | `cortex-agent agent dispatch-execute dsh:<id>` 无目标，无法把 DSH 提升为可执行宿主 | 当前仅有 shadow usage 路径 |
| `VALID_ADAPTER_TYPES_EXT` 不含 `"dsh"` | agent 注册或运行时校验 `external.adapter_type === "dsh"` 会被 `validateAdapterType()` 拒为 `ERR_INVALID_ADAPTER_TYPE` | 当前只加了 `"minimax"` |
| `_seed()` 未注册 DSH | `adapters.list()` 不出现 `dsh`，`agent adapter health dsh` 404 | 与 codex 走同一 try/catch 注入即可 |
| `templates/{zh,en}/integrations/dsh/` 不存在 | 用户 `cortex-agent add dsh` 没有可下发的模板；DSH agent 用户需手工拼装 `~/.dsh/AGENTS.md` | 与 claude / codex / pi / minimax 的 `cortex-agent add <host>` 流程不对称 |
| `docs/platform-integration.md` 没有 DSH 行 | 平台集成对照表把 DSH 排除在"受治理的宿主"之外 | 文档滞后于事实（DSH 已经在测量层 governed） |
| 无 `docs/host-dsh-integration.md` | DSH 用户缺少与 `docs/host-claude-code-integration.md` / `docs/host-codex-integration.md` 同体量的集成手册 | 与 P-002 follow-up §R-3 期望"3 份 host 文档"一致 |
| `tests/agent/agent-adapter-dsh.test.js` 不存在 | dispatch 契约无单测，与 codex/pi/minimax 不可比 | P-002 follow-up §SC-2 期望 host 文档 + 测试对齐 |
| `lib/agents/adapters/dsh-bootstrap.js`（可选） | 显式加载入口；参照 `codey-pi-bootstrap.js` 模式 | 给不需要改 `_seed()` 的保守场景用 |
| `lib/coordination/adapter-core.js` 未注册 DSH `adapterId` | 协调运行时的 host registry 仍然只认 Codex / Claude / Pi / Cursor / MiniMax | 需新增一节 `HostAdapter.dsh` 注册 |

### 1.4 关键约束继承

继承 `agent-runtime-interoperability` 项目级 `index.md` §2 / §6 与 `relations.md` 的全部约束：

- 不实现 DSH 的 LLM Provider SDK、不代理 agent loop、不复制 DSH 的完整 session JSONL storage。
- 不要求 DSH 暴露 message body、prompt、思维过程、私有对话或凭证。
- 不把 DSH 变成 Cortex 的必选依赖；缺省安全（未安装时 fail closed）。
- 不新建第二套 Task / Run / Operation / Dispatch / Lease / Decision / Waitpoint 状态机。
- 默认不保存 prompt / tool 参数全文 / 文件内容 / secret / 绝对私有路径；事件只存 digest / 计数 / URI / tier / 原因与脱敏摘要。
- 核心实现只用 Node.js 内置模块（`fs` / `path` / `child_process` / `crypto`），零 npm 依赖（继承 `bin/cli.js` 零依赖原则）。
- `cortex-agent upgrade` 纯加法，不覆盖用户对 `.agent/` 的任何改动。
- 双语模板（`templates/zh` + `templates/en`）必须同步。

## 2. 目标

1. **把 DSH 提升为 first-class dispatch adapter**：在 `lib/agents/adapters/dsh.js` 中实现 `DshAdapter extends BaseAdapter`，五方法契约与 pi/codex/claude-code 一致。
2. **补齐注册路径**：把 `"dsh"` 加入 `lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT`，并在 `lib/agents/adapters/index.js#_seed()` 用 try/catch 注入（参考 codex 路径）。
3. **提供显式 bootstrap**：新增 `lib/agents/adapters/dsh-bootstrap.js`（参考 `codey-pi-bootstrap.js`），满足"不改 `_seed()`" 的保守部署场景。
4. **模板与 `cortex-agent add dsh` CLI 入口**：在 `templates/{zh,en}/integrations/dsh/` 下放 `README.md`、`AGENTS.md`、`settings.json` 等产物，与 claude / codex / pi / minimax 对齐。
5. **文档升级**：
   - `docs/platform-integration.md` 增加 DSH 行；
   - 新增 `docs/host-dsh-integration.md`（与 `docs/host-claude-code-integration.md` / `docs/host-codex-integration.md` 同体量）；
   - `docs/architecture/adapter-authoring.md` §9 加 DSH register 模式条目。
6. **测试对等**：新增 `tests/agent/agent-adapter-dsh.test.js`，覆盖 health / invoke / cancel / report / discover 五方法，覆盖所有 6 类失败模式（与 pi/codex 一致）。
7. **决策与 Waitpoint**：通过 `D-ARI-P006-promote-dsh`（`type=architecture`）批准后，再用 `WP-ari-p006-impl` 跟踪实施；批准证据归档到本提案 §13。
8. **可执行面配置**：`lib/runtime-adapters/host-runtime-snapshots.js` 与 `execution-surface-matcher.js` 增补 DSH capability snapshot；不动 `dispatch-policy.js` / `capability-aware-dispatch.js` 的对外契约。
9. **coordination 适配**：在 `lib/coordination/adapter-core.js` 注册 `HostAdapter.dsh`（与 Codex / Claude / Pi / Cursor / MiniMax 同位置）；不改 wakeup / handshake / structured-context 主流程。
10. **token 控制面复用**：DSH 已在 TCP 第三 governed host 中（`D-TCP-004`），本提案**只**复用 `lib/host-adapter/shadow-usage/dsh-shadow.js` 作为 measurement sidecar，**不**重新实现 token 抓取。

## 3. 非目标（Out of Scope）

1. 不实现 DSH 的 LLM Provider SDK、agent loop、TUI、IDE、聊天界面。
2. 不修改 `lib/agents/registry.js` 主体（M-002 5/5 ship 完整性约束）；DSH 走 `VALID_ADAPTER_TYPES_EXT` 与 `_seed()` try/catch 注入。
3. 不复制 DSH 完整 session JSONL 解析、compaction、fork；只消费 `assistant/chunk.usage` 等脱敏 envelope 字段（与 shadow adapter 一致）。
4. 不引入自动 daemon / 跨 host fallback / 未授权的工具阻断；保留默认关闭，需用户按 frozen revision 单独批准。
5. 不修改 `lib/coordination/adapter-core.js` 的 wakeup / handshake / structured-context 主流程；DSH adapter 只新增一个 `register("dsh", ...)`。
6. 不重写 token 控制面（TCP）DSH 测量逻辑；shadow adapter 与 backfill 脚本已落地（`D-TCP-004`）。
7. 不在本提案阶段启用 DSH 自动 dispatch 默认值；DSH agent 注册保持 opt-in。
8. 不修改 `bin/cli.js` 与 `lib/agents/m003-cli.js` 的对外签名；DSH dispatch 通过 `agent dispatch-execute dsh:<id>` 走既有 CLI。
9. 不在 Cortex 主 npm 包里依赖任何 `@deepseek/*` 私有模块；adapter 通过 spawn + stdio 与 `dsh` CLI 交互。
10. 不引入对 DSH 会话存储（`~/.dsh/sessions/...`）的写入；adapter 只读 envelope 与 usage sidecar，影子数据继续由 `dsh-usage-sync` 维护。

## 4. 设计

### 4.1 模块布局

新增（pure-add）：

```text
lib/agents/adapters/
  dsh.js                          # ~600 行：BaseAdapter + 5 方法实现
  dsh-bootstrap.js                # ~70 行：require("./dsh") side-effect + 标记
lib/agents/registry-adapter-types.js   # 修改 VALID_ADAPTER_TYPES_EXT 加入 "dsh"
lib/agents/adapters/index.js            # _seed() try/catch 注册 dsh（同 codex）
lib/coordination/adapter-core.js        # 注册 HostAdapter.dsh
lib/runtime-adapters/host-runtime-snapshots.js  # 增补 dsh capability snapshot
templates/zh/integrations/dsh/
  README.md
  AGENTS.md
  settings.json
templates/en/integrations/dsh/
  README.md
  AGENTS.md
  settings.json
docs/
  host-dsh-integration.md
  architecture/adapter-authoring.md    # §9 register 模式条目
  platform-integration.md              # 表格新增 DSH 行
tests/agent/
  agent-adapter-dsh.test.js
```

不修改（pure-add 约束保留）：

```text
bin/cli.js
lib/agents/registry.js                 # M-002 frozen
lib/agents/adapters/{base,claude-code,codex,codey,pi,minimax}.js
templates/_shared/.agent/             # 升级保持 additive-only
```

### 4.2 `DshAdapter` 五方法契约

继承 `BaseAdapter` 五方法契约，命名与 Pi / Codex / Claude Code adapter 完全对齐：

```js
// 伪代码片段 — 实际实现参照 pi.js / codex.js
class DshAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.bin = options.bin || process.env.DSH_BIN || "dsh";
    this.shell = options.shell !== undefined ? options.shell : true;
    this.defaultTimeout = options.defaultTimeout || 300;
    this._subprocesses = new Map();    // runId -> child handle（与 pi/codex 一致）
  }

  discover() {
    return {
      adapter_type: "dsh",
      version: "0.1.0",
      protocol: "external_v1",
      capabilities: [
        "text_generation",
        "code_review",
        "tool_use",
        "multi_turn",
        "long_context",
      ],
      schema: { request: 1, response: 1, journal: 1 },
      transport: "stdio-json-rpc",
      cli: { bin: this.bin, shell: this.shell },
      // 新增：标记这是 first-class，与 P-003 Pi 的 pilot 区分
      maturity: "stable",
      host: "deepseek-harness",
      receipt_contract: "ms-001",
    };
  }

  async health() { /* which/where 同 pi.js 模板 */ }
  async invoke(payload, options = {}) {
    // spawn dsh --json --run-id <id> --task <task> ...
    // 解析 stdout JSON-RPC，原子写入 dispatch journal
  }
  async cancel(runId, options = {}) { /* child.kill(SIGTERM) + 写 rollback */ }
  async report(runId, options = {}) { /* 走 base.js 默认读 journal */ }
}
```

错误码与 pi/codex 一致：`ERR_ADAPTER_SPAWN` / `ERR_DISPATCH_FAILED` / `ERR_DISPATCH_TIMEOUT` / `ERR_JSONRPC_PARSE` / `ERR_RUN_ID_REQUIRED` / `ERR_DISPATCH_ARTIFACT_PARSE`。

### 4.3 CLI 协议假设

DSH CLI 真实协议尚未在仓库内固化证据；本提案暂**沿用** Pi / Codex 已稳定的 stdio JSON-RPC 协议形态：

```text
$ dsh --json --run-id <runId> --task "<task>" [--input <input>] [--config <configRef>] [--model <model>]
  stdin  : JSON-RPC 2.0 request body（单行 / LF-terminated）
  stdout : JSON-RPC 2.0 response（单行 / LF-terminated）
  stderr : diagnostics（non-JSON）
```

实现期需用 `tests/agent/agent-adapter-dsh.test.js` 的 fake binary（参照 `tests/agent/agent-adapter-pi.test.js` 模式）覆盖以下协议假设：

- `--json` 启用 stdio JSON-RPC；
- 缺省 `--json` 时 stdout 视为自由文本，仍包装为 JSON-RPC envelope；
- `--model` 接受模型别名（与 Pi 一致）；
- timeout 走 SIGTERM；
- rollback 失败时写 `rollback-failed.json` + `notify_parent: true`。

> **如真实 DSH CLI 不兼容上述协议**，实施期需在 `discover()` 中返回 `transport: "stdio-plain"`，并把 stdio 行格式化为 `claude-code.js` 的 Content-Length framed 路径；本提案不锁定具体协议，把"协议探测" 放在 `health()` 中以 `dsh --version` 探测后写回 `discover()` 的 `transport` 字段。

### 4.4 注册路径

**主路径（与 codex 对齐）**：在 `lib/agents/adapters/index.js#_seed()` 增加：

```js
try {
  const { DshAdapter: _DshAdapter } = require("./dsh");
  _REGISTRY.set("dsh", _DshAdapter);
} catch (_) { /* noop — dsh 是可选 first-class adapter */ }
```

**显式 bootstrap**：新增 `lib/agents/adapters/dsh-bootstrap.js`，参照 `codey-pi-bootstrap.js`：

```js
require("./dsh");

module.exports = {
  loaded: true,
  loadedAt: new Date().toISOString(),
  adapters: ["dsh"],
};
```

加载方式：

```bash
node -r ./lib/agents/adapters/dsh-bootstrap.js bin/cli.js agent adapter list
NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
  cortex-agent agent adapter health dsh
```

**VALID_ADAPTER_TYPES 扩展**：在 `lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT` 加入 `"dsh"`：

```js
const VALID_ADAPTER_TYPES_EXT = Object.freeze(["minimax", "dsh"]);
```

`isKnownAdapterType("dsh") === true` 且 `validateAdapterTypeExt("dsh")` 不再抛 `ERR_INVALID_ADAPTER_TYPE`。

### 4.5 协调运行时注册

`lib/coordination/adapter-core.js` 的现有 `register(adapterId, factory)` 模式（Codex / Claude / Pi / Cursor / MiniMax 已注册），新增：

```js
register("dsh", () => createDshCoordinationAdapter({
  adapterId: "dsh",
  handshake: dshHandshakeProbe,
  buildStructuredContext: dshBuildStructuredContext,
  threadWakeup: dshThreadWakeup,
}));
```

不修改 wakeup / handshake / structured-context 主流程；新工厂仅在 DSH host 存在时被调用，缺省 fail closed。

### 4.6 Capability Snapshot

`lib/runtime-adapters/host-runtime-snapshots.js` 增加 DSH capability snapshot，字段结构与 Codex / Pi 一致：

```js
{
  host_id: "dsh",
  adapter_type: "dsh",
  capabilities: ["text_generation", "tool_use", "multi_turn", "long_context"],
  limits: { max_context_tokens: 128000, tool_timeout_seconds: 300 },
  evidence: { handshake: "capability-v1", measurement: "ms-001" },
  received_at: "<iso>",
}
```

`execution-surface-matcher.js` 自动从 union 里识别 DSH（hard filter：required capability → `tool_use` → "available"），无需修改 `dispatch-policy.js` 主体。

### 4.7 模板与文档

`templates/{zh,en}/integrations/dsh/` 与 claude / codex / pi 同位置：

```text
templates/zh/integrations/dsh/
  README.md        # 简体中文安装与 first-run 说明
  AGENTS.md        # 项目根 AGENTS.md 补章（DSH host 选择）
  settings.json    # DSH CLI 配置（bin path / model / default timeout）
```

`docs/platform-integration.md` 增补 DSH 行（与 claude-code / codex / pi / minimax 同行同列）。

新增 `docs/host-dsh-integration.md`，四节齐备（与 `docs/host-claude-code-integration.md` 对齐）：

1. DSH 安装与 PATH
2. DSH → Cortex agent 注册（`cortex-agent add dsh`）
3. dispatch / cancel / report 调用范例
4. 已知限制（协议假设、缺省 fail closed、tool gate 边界）

### 4.8 测试策略

`tests/agent/agent-adapter-dsh.test.js` 至少覆盖：

| 用例 | 期望 | 参照 |
| :--- | :--- | :--- |
| discover 字段完整 | `adapter_type === "dsh"`，capabilities 非空 | claude-code test |
| health() — bin 存在 | `ready: true`, `latency_ms < 1000` | pi test |
| health() — bin 缺失 | `ready: false`, code `ERR_ADAPTER_SPAWN` | codex test |
| invoke() — happy path | stdout JSON-RPC 解析；journal `request.json` + `result.json` 原子写入 | pi test |
| invoke() — spawn 失败 | `ERR_ADAPTER_SPAWN`，error.json 写入 | codex test |
| invoke() — 退出非 0 | `ERR_DISPATCH_FAILED`，stderr 摘录 ≤ 4096 字节 | claude-code test |
| invoke() — timeout | `ERR_DISPATCH_TIMEOUT`，SIGTERM | pi test |
| invoke() — JSON parse 失败 | `ERR_JSONRPC_PARSE`，stdout 摘录 | codex test |
| invoke() — rollback 写失败 | `rollback-failed.json` 写入 + `notify_parent: true` | claude-code test |
| cancel() — 进程中 | child SIGTERM，journal 标记 cancelled | pi test |
| cancel() — 进程已结束 | no-op，结构化结果返回 | pi test |
| report() — result.json 存在 | 读 request / result 拼接返回 | base.js 默认 |
| report() — journal 缺失 | 返回 `not_found` 结构 | base.js 默认 |
| shell: false + 绝对路径 | 测试可重复，无 spawn 漂移 | pi test |

基线回归：`tests/agent/*.test.js` 全部 PASS；`tests/host-adapter/shadow-usage/*.test.js` 全部 PASS（不破坏 shadow 用法）。

### 4.9 治理资产

| ID | 类型 | 内容 |
| :--- | :--- | :--- |
| `D-ARI-P006-promote-dsh` | decision (architecture / approval) | 批准 DSH 由 shadow host 提升为 first-class dispatch adapter，覆盖 §2 全部目标 |
| `WP-ari-p006-impl` | waitpoint (released) | 实施 gate，§4.1 / §4.4 / §4.8 全部 PASS 后释放 |
| `D-ARI-P006-acceptance` | decision (architecture / approval-with-known-issues) | 阶段性 acceptance，对照 §10 验收清单 |
| `WP-ari-p006-doc-sync` | waitpoint (released) | 文档与模板同步 gate（`docs/platform-integration.md` + `docs/host-dsh-integration.md` + 双语模板） |
| `WP-ari-p006-test-baseline` | waitpoint (released) | 测试 baseline gate（`tests/agent/agent-adapter-dsh.test.js` PASS + 既有 5 adapter 回归 PASS） |
| `WP-ari-p006-registry-rollout` | waitpoint (released) | 注册路径 gate（`_seed()` + `VALID_ADAPTER_TYPES_EXT` + `adapter-core.js` 同时生效） |

> **与既有决策的关系**：`D-TCP-004-add-dsh-host` 仅授权 shadow usage + backfill，不含 dispatch；本提案 `D-ARI-P006-promote-dsh` 是**新一层**架构决策，关系为"扩展 / 接续"，不替代前者。

## 5. 架构对比

| 维度 | 维持现状（DSH 仅 shadow） | 复制 Pi 完整链路（不推荐） | 本提案（P-006） |
| :--- | :--- | :--- | :--- |
| 架构合规 | ⚠️ DSH 只在 measurement 层 governed，dispatch 层缺位 | ❌ 全量复制会与 M-003 / P-001 冲突 | ✅ 沿用既有 5 方法契约与 `_seed()` try/catch 模式 |
| 跨 host 真实性 | ⚠️ DSH 与 Codex / Pi 不可比（一个能 dispatch 一个不能） | ⚠️ 高度重复，回归负担重 | ✅ DSH 进入既有 first-class，与 Claude / Codex / Pi / MiniMax 等位 |
| token 治理一致性 | ✅ DSH 已在 TCP 中（`D-TCP-004`） | ⚠️ 复制 token 抓取易引入双源真相 | ✅ 复用 `dsh-shadow.js`，single source of truth |
| 模板与 CLI 对称 | ❌ `cortex-agent add dsh` 无模板 | ⚠️ 不解决模板层 | ✅ 与 claude / codex / pi / minimax 对齐 |
| 文档完整度 | ❌ `docs/host-dsh-integration.md` 缺失 | ⚠️ 重复实现不解决文档 | ✅ 与 P-002 follow-up §R-3 的 3 份 host 文档期望一致 |
| 实施成本 | 0 | 高（多模块重复） | 中（1 个 adapter + 1 个 bootstrap + 模板 + 文档 + 测试） |
| 维护成本 | 隐性 drift 持续 | 多套并行，长期负担 | 与 codex / pi 同维护成本 |
| 迁移风险 | DSH 用户继续手工拼装 | 大 | additive、缺省关闭、可回退（`_seed()` try/catch 失败即 skip） |
| 决策复杂度 | 已 D-TCP-004 通过 | 需新建多重决策 | 1 个 `D-ARI-P006` + 5 个 Waitpoint |

## 6. Phase 计划

### Phase 1：Read-only Observer 与 capability snapshot（M-014）

- 实施 `lib/runtime-adapters/host-runtime-snapshots.js` 的 DSH 字段；
- `discover()` 字段实现；
- `tests/agent/agent-adapter-dsh.test.js` discover / health / report 用例 PASS；
- 不连 dispatch、tool gate、context。

### Phase 2：Registry 与协调运行时接入（M-015）

- 修改 `lib/agents/registry-adapter-types.js` 加入 `"dsh"`；
- 修改 `lib/agents/adapters/index.js#_seed()` try/catch 注入；
- 新增 `lib/agents/adapters/dsh-bootstrap.js`；
- `lib/coordination/adapter-core.js` 注册 `HostAdapter.dsh`；
- `tests/agent/agent-adapter-dsh.test.js` 增加 registry round-trip 用例。

### Phase 3：Cortex Dispatch Evidence Sink（M-016）

- `invoke()` 实现：spawn `dsh` + JSON-RPC + atomic journal；
- 6 类失败模式全部写 error.json / rollback-failed.json；
- cancel() / report() 完整实现；
- 与 `codex-shadow.js` / `pi-shadow.js` 并行存在，shadow 路径继续工作。

### Phase 4：模板与 `cortex-agent add dsh`（M-017）

- 双语模板 `templates/{zh,en}/integrations/dsh/`；
- `cortex-agent add dsh` CLI 落地（参照 `cortex-agent add codex`）；
- `docs/platform-integration.md` 表格新增 DSH 行；
- `docs/host-dsh-integration.md` 完成四节。

### Phase 5：Tool Gate 与 Context Pilot（M-018，可选 / 与 DSH 真实能力相关）

- 若 DSH CLI 支持 `beforeToolCall` / context hook：接入 P-001 gate 契约；
- 否则记录为 `unsupported`，走 readiness `warning|blocked`；
- 不假设 DSH 一定支持。

> **注**：Phase 5 在 P-006 提案中**显式可选**，因为 DSH 真实 hook 能力尚未在仓库内固化证据。如 Phase 5 不实施，P-006 仍可发布为"first-class dispatch only，不含 tool gate"。

## 7. 验收清单（Acceptance Criteria）

- [ ] **AC-01 注册可见**：`node bin/cli.js agent adapter list` 输出包含 `dsh`。
- [ ] **AC-02 健康检查**：`node bin/cli.js agent adapter health dsh` 在 bin 存在时返回 `ready: true`，bin 缺失返回 `ready: false` 且 code `ERR_ADAPTER_SPAWN`。
- [ ] **AC-03 dispatch 成功**：fake `dsh` binary 跑通 happy path，journal 写入 `request.json` + `result.json`（atomic），可被 `agent dispatch-execute` 读取。
- [ ] **AC-04 失败模式完整**：6 类失败模式（spawn / exit / timeout / parse / rollback / cancel）单测全部 PASS。
- [ ] **AC-05 cancel 工作**：长运行 fake `dsh` 进程被 SIGTERM，journal 标记 cancelled。
- [ ] **AC-06 report 工作**：result.json 存在时返回拼接结果；缺失时返回 `not_found` 结构。
- [ ] **AC-07 模板可下发**：`cortex-agent add dsh` 在测试 fixture 中产出 `AGENTS.md` + `README.md` + `settings.json`，与 `add codex` 同体量。
- [ ] **AC-08 文档齐备**：`docs/platform-integration.md` 含 DSH 行 + `docs/host-dsh-integration.md` 四节齐备。
- [ ] **AC-09 双语同步**：`templates/zh` 与 `templates/en` 内容一致（中英文不要求字符对等，要求结构与覆盖项一致）。
- [ ] **AC-10 零依赖**：`bin/cli.js` 与新文件 `dsh.js` / `dsh-bootstrap.js` 不引入任何 npm 第三方依赖。
- [ ] **AC-11 纯加法**：`upgrade` 命令保持 additive-only；不覆盖既有 `.agent/` 用户改动。
- [ ] **AC-12 影子兼容**：shadow adapter（`dsh-shadow.js`）+ backfill（`dsh-usage-sync.js`）继续工作，已有 24/24 测试 PASS。
- [ ] **AC-13 协调注册**：`adapter-core.js#register("dsh", ...)` 注册成功；缺省 fail closed（DSH 未安装时不影响其他 host）。
- [ ] **AC-14 capability snapshot**：`execution-surface-matcher.js` 把 DSH 视为可执行面候选（hard filter 通过即可）。
- [ ] **AC-15 决策与 Waitpoint**：`D-ARI-P006-promote-dsh.json` 批准 + `WP-ari-p006-impl.json` released + 5 个 Waitpoint 全部 released。
- [ ] **AC-16 测试 baseline**：`npm test` 或 `node --test tests/agent/*.test.js` 全 PASS；既有 287 baseline 不退化。

## 8. 风险与缓解

| 风险 | 严重度 | 缓解 |
| :--- | :--- | :--- |
| DSH CLI 真实协议与 §4.3 假设不符 | 高 | `discover().transport` 在 `health()` 中探测后写回；fake binary 测试覆盖 6 类失败模式；Phase 1 先固 discover/health 不连 dispatch |
| 引入 npm 第三方依赖（破坏 `bin/cli.js` 零依赖） | 高 | 实施期 PR review 强制 grep；`tests/agent/agent-adapter-dsh.test.js` import 链检查 |
| `_seed()` 修改被误读为破坏 M-002 frozen | 中 | 严格按 codex 路径的 try/catch 注入；不改 `_seed()` 主体，仅末尾追加 |
| `lib/agents/registry.js` 被改 | 中 | 强制只用 `VALID_ADAPTER_TYPES_EXT` 扩展路径；PR review 检查 |
| DSH 用户把 session.jsonl.zstd 拷贝进 `.agent/` | 中 | shadow 路径不变；adapter 不读 session storage；只读 envelope 与 usage sidecar |
| 模板与 CLI 不同步（缺 zh/en） | 中 | CI / scripts 检查双语言模板文件存在 + 行数 ≥ 阈值 |
| DSH 默认开启自动 dispatch | 高 | 不修改 `bin/cli.js` 默认行为；DSH agent 保持 opt-in，需用户显式 `cortex-agent add dsh` |
| 升级覆盖用户 `.agent/` 改动 | 中 | 纯加法约束（`templates/_shared/.agent/` 不动；`templates/{zh,en}/integrations/dsh/` 是新目录） |
| token 测量与 dispatch 重复实现 | 中 | DSH shadow adapter 与 backfill 完全复用；adapter 不读 `~/.dsh/sessions/` |
| DSH 提供 tool gate hook 但与 P-001 契约不符 | 中 | Phase 5 推迟；记录为 `unsupported`，readiness `warning|blocked` |
| `lib/coordination/adapter-core.js` 注册引入副作用 | 中 | 新工厂仅在 DSH host 存在时被调用；不动 wakeup / handshake / structured-context 主流程 |
| DSH 用户把 first-class adapter 误用为必选依赖 | 低 | `cortex-agent add dsh` 不强制；agent entry 校验保持 `unsupported | available` 二元 |

## 9. 停止条件

任一触发即停 P-006，不进入 first-class 发布：

- DSH CLI 必须 patch 核心才能 spawn（违反 §3 非目标 1）。
- DSH CLI 拒绝暴露 `--json` / stdio JSON-RPC / `--task` 任意一个必要 flag。
- `lib/agents/registry.js` 不可不修改的硬约束被破坏（M-002 完整性）。
- DSH 用户必须提供 `.env` / API key / OAuth token 才能 dispatch（破坏默认安全）。
- 6 类失败模式任意一类无法写出 `error.json` 或 `rollback-failed.json`。
- DSH session storage 必须全量复制进 `.agent/` 才能对接（违反 §3 非目标 3）。
- token 控制面（TCP）必须改写 `dsh-shadow.js` 主体才能兼容 dispatch。

## 10. 验收回放

由 `/mission` 实施后回放：

- 测试：`npm test` 全 PASS；新增 `tests/agent/agent-adapter-dsh.test.js` ≥ 14 用例。
- 命令回放：`node bin/cli.js agent adapter list` 输出含 `dsh`。
- 模板下发：`node bin/cli.js add dsh --dry-run` 输出 zh/en 模板路径。
- 文档回放：`docs/host-dsh-integration.md` 四节标题与 P-002 follow-up §SC-2 期望一致。
- 影子兼容：backfill 脚本 dry-run 命中既有 832 receipt 结构（不需重写）。
- 协调注册：`adapter-core.js#list()` 输出含 `dsh`。
- capability snapshot：`node bin/cli.js query host-runtime-snapshots` 输出 DSH 行。
- 决策与 Waitpoint：`D-ARI-P006-promote-dsh.json` approved + 6 个 Waitpoint released。

## 11. 执行路径选择（`/plan` vs `/mission`）

推荐 **`/mission`** 而非 `/plan`：

- 涉及 `lib/agents/adapters/dsh.js`（新增 600 行）、`dsh-bootstrap.js`（新增 70 行）、`registry-adapter-types.js`（修改 1 行）、`adapters/index.js#_seed()`（追加 try/catch）、`lib/coordination/adapter-core.js`（新增注册）、`lib/runtime-adapters/host-runtime-snapshots.js`（新增 snapshot）、双语模板（6 个新文件）、文档（2 个新文件 + 1 个修改）、单测（1 个新文件），共 ≥ 12 个文件改动。
- 5 个 Phase（M-014～M-018），其中 Phase 5 可选。
- 需要独立验证（`/mission` 的 validation contract）。
- 与 M-009（M-003 MS-002 batch 2）执行风格同源。

`/plan` 适用于本提案规模的下限：本提案**可以**降级为 `/plan`，但需声明 Phase 5 推迟至 P-007 之后的 follow-up 提案。

## 12. 与既有提案 / 项目的关系

| ID | 关系 | 说明 |
| :--- | :--- | :--- |
| `agent-runtime-interoperability/index.md` | 父项目 | 本提案作为 P-006 加入 |
| `P-001-host-capability-runtime-event-contract-proposal.md` | 上游 | capability vocabulary 与 boundary event envelope 直接复用 |
| `P-002-observable-context-pipeline-proposal.md` | 上游 | context trajectory 仅在 DSH 支持 transformContext 时接入；Phase 5 可选 |
| `P-003-pi-reference-adapter-pilot-proposal.md` | 兄弟 | 同样为 optional first-class adapter；DSH 在生产层而非 pilot 层 |
| `P-004-capability-aware-execution-surface-dispatch-proposal.md` | 上游 | matcher 自动识别 DSH；不动 policy 主体 |
| `P-005-governed-agent-semantic-progress-supervision-proposal.md` | 上游 | DSH adapter 不绕过；与 P-005 evidence 接口对齐（不修改 P-005） |
| `token-control-plane` project / `D-TCP-004` | 同源 | shadow usage 复用；本提案**接续**而非**替代** |
| `cross-host-auto-handoff` project | 下游 | DSH 进入 handoff 候选集后，handoff project 自动受益 |
| `skill-dispatch` project | 下游 | DSH skill dispatch 自动可见（`list()` 输出） |

更新计划：

- `agent-runtime-interoperability/index.md` §3 子提案表新增 P-006 行；
- `agent-runtime-interoperability/relations.md` 外部关系表新增 DSH 行；
- `agent-runtime-interoperability/references.md` 新增 §"DSH 实测证据"小节（来自 `scripts/dsh-usage-sync.js` 的回放数据与 `dsh-shadow-host-readiness-20260819.md`）。

## 13. 决策与 Waitpoint（Communication Runtime Integration）

按 `.agent/rules/architecture-design.md` 与 `arch-design` skill 的 Communication Runtime 规范：

```bash
# 资源绑定：open Decision
node .agent/skills/management-api/scripts/index.js decisions request \
  --gate owner --type architecture --gate-action architecture \
  --resource-ref "proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md"

# Waitpoint gate
node .agent/skills/management-api/scripts/index.js waitpoints create \
  --owner-workflow /arch-design \
  --reason "P-006 DSH first-class adapter approval required" \
  --action architecture \
  --resource-ref "architecture:proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md"

# 用户批准
node .agent/skills/management-api/scripts/index.js decisions resolve \
  --gate user --decision-id D-ARI-P006-promote-dsh

# 释放 Waitpoint
node .agent/skills/management-api/scripts/index.js waitpoints release \
  --waitpoint-id WP-ari-p006-impl
```

Checkpoint 状态：pending approval 标记 `Checkpoint`；用户批准后才进入 Phase 1（M-014）。

## 14. 下一步

- [ ] 在 `agent-runtime-interoperability/index.md` 加入 P-006 行（status = draft）。
- [ ] 在 `agent-runtime-interoperability/relations.md` 加入 DSH 外部关系。
- [ ] 创建 `D-ARI-P006-promote-dsh.json`（status = open）通过 management-api。
- [ ] 创建 `WP-ari-p006-impl.json`（status = pending）通过 management-api。
- [ ] 用户批准 `D-ARI-P006` 后，按 Phase 1～4 实施。
- [ ] Phase 5（tool gate）作为可选 follow-up，单列 P-007 提案。
- [ ] 实施完成后 `/publish-docs --architecture`，把 `docs/host-dsh-integration.md` 与本提案同步到公开 `docs/`。
