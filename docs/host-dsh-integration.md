# DSH (DeepSeek Harness) Integration Guide

> **Status**: `first-class dispatch adapter`（M-029 / P-006，2026-08-19 批准 `D-ARI-P006-promote-dsh-firstclass`）+ **M-034 WP-03 headless 传输修复**（2026-11-07，实测 `dsh 0.2.1-rc.5`）
> **参考实现**: `lib/agents/adapters/dsh.js` · `lib/agents/registry-ext.js` · `lib/agents/adapters/dsh-bootstrap.js`
> **注册路径**: `lib/agents/adapters/index.js#_seed()` try/catch + `lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT` + `lib/agents/registry-ext.js`（additive 读取）+ `lib/coordination/adapter-core.js#REGISTERED_ADAPTER_IDS`

DSH（DeepSeek Harness）以与 Pi / Claude Code / Codex CLI 同等地位接入 Cortex Agent：通过 `cortex-agent add dsh` 下发模板，通过 `agent dispatch-execute dsh:<id>` 执行派发。本文档与 `docs/host-claude-code-integration.md` / `docs/host-codex-integration.md` 对齐，共四节。

## 1. 安装、PATH 与传输探测

```bash
# 1. 安装 DSH CLI（参考 DSH 官方文档；本仓库不内置），确保 `dsh` 在 PATH 中
which dsh

# 2. 严格探测（真实启动面证据：版本 + help 摘要 + headless profile）
cortex-agent agent adapter probe dsh
# 期望：status=ready ready=true transport_supported=text-headless-v1

# 3. 健康检查（现在会叠加 probe 结果，不再只做 which）
cortex-agent agent adapter health dsh
# 期望：status=ok ready=true，details.transport_status=ready

# 4. 可选：DSH_BIN 覆盖默认 "dsh"（与 PI_BIN / CODEX_BIN 同位）
export DSH_BIN=/custom/path/to/dsh
```

**探测四态 + fail-closed**：

| 状态 | 含义 | invoke 行为 |
| :--- | :--- | :--- |
| `ready` | 版本可识别 + help 含 headless + `--profile headless --help` 退出 0 | 允许 spawn |
| `degraded` | 二进制可达但 help 无 headless | 拒绝 spawn |
| `unsupported` | 二进制缺失 / 版本形状不识别 / 参数被拒 / 超时 / headless profile 无法启动 | 拒绝 spawn（`ERR_DSH_TRANSPORT_UNSUPPORTED`） |
| `unknown` | 探测未运行 | 仅当调用方未要求 `verifyTransport` 时可 spawn |

> probe 执行三条有界命令：`dsh --version`、`dsh --help`（各 5s）、`dsh --profile headless --help`（15s，超时重试一次）。最后一条用于证明 profile 真能启动——help 文本里出现 "headless" 只是示例，不能作为可用性证据；成功还要求 stdout 含 `Usage: dsh --profile headless`，防止包装器转发 launcher help 蒙混。probe 结果回报 `profile.exit_code` / `profile.ok`。注意：启动 profile 会让 dsh 初始化自己的 `$DSH_HOME/profiles/headless/cordis.yml`（实测 mtime 变化），适配器本身不解析任何 dsh 配置，但不要假设 probe 对 `$DSH_HOME` 零写入。

> 裸命令 `dsh` 会按 `PATH` 解析（与 shell 行为一致）；解析不到时报 `fail_closed_reasons=["binary_not_found"]`。

## 2. DSH → Cortex agent 注册

```bash
# 1. 项目初始化（生成根 AGENTS.md 与 .agent/）
cortex-agent init

# 2. 添加 DSH 平台集成
cortex-agent add dsh
# 产物（写入当前目录，无 --project 参数）：
#   .dsh/settings.json   （skills/prompts 指向 .agent/，merge 保留用户已有配置）
#   .dsh/README.md
#   .dsh/AGENTS.md
#   符号链接：.dsh/skills → .agent/skills、.dsh/workflows → .agent/workflows

# 3. 验证注册
cortex-agent agent adapter list          # 应包含 dsh
cortex-agent list                        # 已安装平台应包含 dsh
```

**Agent 条目**（`.agent/agents/<id>.json`）使用 `external.adapter_type = "dsh"`：

```json
{
  "schema_version": 1,
  "agent_id": "Worker-A",
  "role": "implementer",
  "model": "deepseek-v4",
  "started_at": "2026-11-07T00:00:00.000Z",
  "status": "running",
  "capabilities": ["code_review"],
  "external": { "adapter_type": "dsh" }
}
```

校验路径：`lib/agents/registry.js`（M-002 frozen）保持不变，其 `VALID_ADAPTER_TYPES` **仍然不含** `dsh`；需要 EXT 类型的调用方走 `lib/agents/registry-ext.js#readAgentExt`（先跑冻结校验，仅在 `ERR_INVALID_ADAPTER_TYPE` 时用 M-002 ∪ EXT 联合表重校验 adapter_type，其余字段仍走原校验）。`agent discover` / `agent invoke` / `agent dispatch-execute` 均使用该 additive 读取器；未知类型依旧 fail closed。

## 3. dispatch / cancel / report 调用范例

```bash
# 显式手动派发。`dsh:` 前缀是可选的 adapter 限定：会校验条目
# external.adapter_type === "dsh"；不写前缀时按条目自身 adapter_type 路由。
cortex-agent agent dispatch-execute dsh:Worker-A "review the schema" --timeout 120
cortex-agent agent dispatch-execute Worker-A "review the schema"     # 等价

# 显式加载 bootstrap（可选，等价于 _seed() 自动注册）
NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
  cortex-agent agent adapter health dsh

# cancel / report 走标准 dispatch journal（.agent-runtime/dispatch/<runId>/）
#   request.json / result.json / error.json / rollback.json / rollback-failed.json
```

**真实调用形状**（`dsh 0.2.1-rc.5` 实测）：

```text
$ dsh --profile headless [--json] [--session-id <id>] -
  stdin  : 任务正文（`-` = 从 stdin 读取；多行安全，无 shell 转义风险）
  stdout : --json 时为 NDJSON 运行事件流：
             {"type":"session",...}
             {"type":"status","phase":"turn_start|step_start|step_end|turn_end",...}
             {"type":"thinking","text":...}
             {"type":"text","text":...}
             {"type":"tool_call",...} / {"type":"tool_result",...,"status":...}
             {"type":"final","text":...}        <- 终止/结算信号
             {"type":"error","message":...}      <- 失败
  stderr : diagnostics（non-JSON）
```

> `--model` / `--config` 在 headless 面没有对应参数：适配器把它们记录进 `request.json`（`model_ref` / `config_ref`）供溯源，实际由 DSH profile 决定。

**状态契约**（P-008 / VC-034-001-02）：

| status | 条件 | journal |
| :--- | :--- | :--- |
| `ok` | exit 0 **且** 观测到 `{"type":"final"}` | `result.json` + `rollback.json(status=completed)` |
| `blocked` | exit 0 但无终止事件（`turn_end` 不算结算） | `result.json(status=blocked, reason=missing_settled_signal)` + `rollback.json(status=blocked)` |
| `failed` | spawn 失败 / 非零退出 / `{"type":"error"}` / stdout 不可解析 | `error.json` + `rollback.json` |
| `timeout` | 适配器侧 SIGTERM → 1.5s SIGKILL | `error.json` + `rollback.json` |

**失败码**：

| 场景 | error code |
| :--- | :--- |
| binary 缺失 / spawn 失败 | `ERR_ADAPTER_SPAWN` |
| probe 未通过（`verifyTransport`） | `ERR_DSH_TRANSPORT_UNSUPPORTED` |
| 缺少 task / input | `ERR_DSH_TASK_REQUIRED` |
| 非零退出（含 `exit_code` / `signal` / stderr 摘录） | `ERR_DISPATCH_FAILED` |
| 超时 | `ERR_DISPATCH_TIMEOUT` |
| stdout 无机器可读事件 / 空 | `ERR_DSH_EVENT_PARSE` |
| `{"type":"error"}` 事件（优先于退出码） | `ERR_DSH_<code>` |
| 失败的 turn（`status/phase=turn_end` 且 `reason.kind="error"`） | `ERR_DSH_<reason.error.code>`（如实测的 `ERR_DSH_MISSING_CREDENTIAL`） |
| rollback 写失败 | `rollback-failed.json` + `notify_parent: true` |

## 4. 已知限制

1. **tool gate 未启用**：`tool.before.observe` / `tool.before.block` 标记 `unsupported`（P-001 冻结词汇），待 M-018 验证 DSH 真实 hook 能力后另行接入。
2. **不读取会话存储**：dispatch adapter 不读 `~/.dsh/sessions/`；usage 测量由 `scripts/dsh-usage-sync.js`（shadow）单独维护，两者互不依赖。probe 会启动 headless profile，dsh 可能刷新 `$DSH_HOME/profiles/headless/cordis.yml` 等自身运行时文件（只影响 dsh，不影响 cortex 数据）。
3. **无自动 dispatch**：DSH agent 保持 opt-in；`cortex-agent add dsh` 不启用 daemon / 自动调度。`cortex-agent dispatch` 仍是 Phase 0 dry-run 契约面（`dispatch execute` 返回 `PHASE_ZERO_STUB`），真实派发只走 `agent dispatch-execute`。
4. **通知泵对 dsh 是显式 deferred**：`notification-cli.js#ADAPTER_WHITELIST` 现在包含 `dsh`，但 `notification-host.js#resolveAdapter("dsh")` 返回经注册的 deferred adapter（`hostAvailable:false`，`deliver` → `status=deferred` / `ERR_NOTIFICATION_ADAPTER_UNAVAILABLE`）。原因：dsh 0.2.1-rc.5 没有 session 注入/唤醒 API（CLI 只有一次性 `--profile headless`），无法在不额外起模型回合的前提下投递通知。该注册让 pump 以明确的能力错误失败关闭，而不是 `ERR_NOTIFICATION_ADAPTER: adapter is not registered`；未来若 dsh 提供注入面，再替换为真实投递。
5. **`.dsh/settings.json` 与 MCP 配置待核实**：`add dsh` 写出的 `.dsh/settings.json` 采用 `{skills,prompts}` 形状，与 DSH 0.2.x 的 `$DSH_HOME/settings.yaml`（`ui-*` / `locale` / `llm-*` 命名空间）不同构；`mcp install dsh` 写入 `~/.config/dsh/mcp.json`，当前未在 DSH 0.2.1 包内找到该路径的消费证据。二者目前按"预留/未证实"对待，接入生产前需实测。
6. **零 npm 依赖**：`dsh.js` / `dsh-bootstrap.js` / `registry-ext.js` 只用 Node.js 内置模块，继承 `bin/cli.js` 零依赖原则。

---

> 返回：[平台集成](./platform-integration.md) | [Adapter Authoring](./architecture/adapter-authoring.md) | [DSH 架构决策](./architecture/dsh-host-adapter.md)
