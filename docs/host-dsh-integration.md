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

> probe 执行三条有界命令：`dsh --version`、`dsh --help`（各 5s）、`dsh --profile headless --help`（15s，超时重试一次）；最坏情况会阻塞约 40s（5+5+15+15），CLI 同步等待。最后一条用于证明 profile 真能启动——help 文本里出现 "headless" 只是示例，不能作为可用性证据；成功还要求 stdout 含 `Usage: dsh --profile headless`，防止包装器转发 launcher help 蒙混。probe 结果回报 `profile.exit_code` / `profile.ok`。注意：启动 profile 会让 dsh 初始化自己的 `$DSH_HOME/profiles/headless/cordis.yml`（实测 mtime 变化），适配器本身不解析任何 dsh 配置，但不要假设 probe 对 `$DSH_HOME` 零写入。

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

## 4. 会话续接与多会话批调度

DSH headless 的一次运行就是一个**会话**。每次运行的第一个事件是
`{"type":"session","sessionId":"..."}`；把该 id 交给下一次运行即可**续接同一段对话**：

```bash
# 1) 首次派发：适配器把 session 事件里的 id 记进结果
cortex-agent agent dispatch-execute dsh:Worker-A "先把 schema 读一遍" --output json
# → result.session_id = "session-b9ed020a-5ac4-40f3-a7d3-b4fb089451b2"

# 2) 续接同一会话（等价于 dsh --profile headless --json --session-id <id> -）
cortex-agent agent dispatch-execute dsh:Worker-A "现在给出改动清单" \
  --session-id session-b9ed020a-5ac4-40f3-a7d3-b4fb089451b2 --output json
```

> 实测（dsh 0.2.1-rc.5）：续接时运行流里的 `turn` 递增（turn 1 → turn 2），说明恢复的是同一段会话上下文，而不是新会话。

**批调度**（多个会话并行）：把任务写成 JSON 交给 `agent dispatch-batch`：

```json
{
  "tasks": [
    { "label": "first",  "agent_id": "dsh:Worker-A", "task": "reply with exactly: FIRST-OK" },
    { "label": "second", "agent_id": "dsh:Worker-A", "task": "reply with exactly: SECOND-OK" },
    { "label": "followup", "agent_id": "dsh:Worker-A", "task": "继续上一轮",
      "session_id": "session-b9ed020a-5ac4-40f3-a7d3-b4fb089451b2" }
  ]
}
```

```bash
cortex-agent agent dispatch-batch --tasks ./tasks.json --concurrency 2 --output json
```

要点：

- **每个任务一个 run_id、一个 journal**，汇总写在同一个 dispatch 目录下（目录由 `base.js#dispatchDir` 决定：默认 `.agent/runtime/dispatch/<runId>/`，若工作区使用 legacy 布局则是 `.agent-runtime/dispatch/<runId>/`，除非存在 `.agent/runtime/layout.json` 另有约定）。
- **每个任务一个独立 DSH 会话**（除非显式给 `session_id` 续接）。汇总里同时给出两个字段：`session_id` 是**实际观测到的**会话 id，`requested_session_id` 是任务文件里**请求续接**的 id——两者分开，避免"请求的 id"被当成"已验证的续接"。
- **并发默认 1**：`--concurrency N` 显式开启并行（上限 16）。多个 worker 在同一工作树写文件会互相干扰，并行任务请放在各自的 worktree 里。`--concurrency` 传入非正整数会**直接报错退出 2**，不会悄悄退回串行。
- **状态如实汇总**：`ok / blocked / timeout / failed` 逐条统计；任一条 `failed` / `timeout` 时整体为 `failed`，只有 `blocked` 时为 `partial`，全绿才是 `ok`。批次退出码：全绿 0，否则 3（任务文件本身有问题时 2）。
- 任务文件可用裸数组或 `{"tasks":[...]}`；每项必须有 `agent_id`，以及 `task` 或 `input` 之一；`label` 唯一（默认 `task-NN`）。
- `--session-id` 只被 `dsh` 适配器翻译成命令行参数；其他适配器会忽略它并打印一行 stderr 警告（不中断运行）。

## 5. 定时触发（cortex 内置 schedule）

不需要外部 cron 直接调 CLI：调度定义、到期判定和运行记录都在 cortex 里，执行仍走正常的 dispatch 路径。

```bash
# 每 30 分钟让同一个 DSH agent 做一次巡检（每次新会话）
cortex-agent schedule add --id nightly-audit --agent dsh:worker \
  --task "检查 .agent/runtime/dispatch 下最近一次失败并给出结论" --every 30m

# 工作日 09:00 触发（5 段 cron：分 时 日 月 周）
cortex-agent schedule add --id morning-brief --agent dsh:worker \
  --tasks ./briefs/tasks.json --cron "0 9 * * 1-5"

# 续接固定会话（同一个 session 上反复追问）
cortex-agent schedule add --id followup --agent dsh:worker \
  --task "继续上一轮的方案，给出下一步" --session-id session-b9ed020a-... --every 2h

cortex-agent schedule list
cortex-agent schedule run            # 单次到期检查（外部 cron/launchd 可驱动它）
cortex-agent schedule daemon --interval 60   # cortex 自带循环，前台常驻
cortex-agent schedule remove nightly-audit
```

要点：

- **定义是配置**：`.agent/schedules/<id>.json`（含 agent、task 或 tasks_file、every/cron、可选 session_id/concurrency/timeout、`last_run_at`/`last_status`），可入库、可 review。
- **运行记录是本地产物**：`.agent/runtime/schedules/<id>/runs/<stamp>.json`，模板 `.gitignore` 已忽略 `runtime/schedules/`。
- **执行复用 `agent dispatch-batch`**：同一个 journal 目录、同一套 `ok/partial/failed` 判定；成功的 tick 退出 0，任一 schedule 运行失败退出 3，定义/参数错误退出 2。
- **到期纪律**：`every` 从上一次运行时间起算；`cron` 一个匹配分钟内只触发一次（daemon 与手动 `schedule run` 同时存在也不会重复跑）。
- **单写者假设**：同一项目不要同时跑两个 `schedule daemon`；`schedule run` 也不适合与 daemon 并发执行（没有跨进程锁）。
- **凭证**：headless 只读启动环境（`DEEPSEEK_API_KEY` 等），不读 `~/.dsh/.credentials.yaml`；daemon 需要带着这个环境启动。
- **不注入运行中的 GUI 会话**：schedule 触发的是新的一次 headless 运行（或按 `--session-id` 续接的历史会话），不会把消息塞进正在跑的 GUI 回合。

## 6. 已知限制

1. **tool gate 未启用**：`tool.before.observe` / `tool.before.block` 标记 `unsupported`（P-001 冻结词汇），待 M-018 验证 DSH 真实 hook 能力后另行接入。
2. **不读取会话存储**：dispatch adapter 不读 `~/.dsh/sessions/`；usage 测量由 `scripts/dsh-usage-sync.js`（shadow）单独维护，两者互不依赖。probe 会启动 headless profile，dsh 可能刷新 `$DSH_HOME/profiles/headless/cordis.yml` 等自身运行时文件（只影响 dsh，不影响 cortex 数据）。
3. **无隐式自动 dispatch**：DSH agent 仍保持 opt-in，`cortex-agent add dsh` 不会启动任何后台循环。定时触发需要显式创建 schedule 并由 `schedule daemon`（或外部计时器调 `schedule run`）驱动；`cortex-agent dispatch` 命令行本身仍是 Phase 0 dry-run 契约面（`dispatch execute` 返回 `PHASE_ZERO_STUB`），真实派发走 `agent dispatch-execute` / `agent dispatch-batch`。
4. **通知泵对 dsh 是显式 deferred**：`notification-cli.js#ADAPTER_WHITELIST` 现在包含 `dsh`，但 `notification-host.js#resolveAdapter("dsh")` 返回经注册的 deferred adapter（`hostAvailable:false`，`deliver` → `status=deferred` / `ERR_NOTIFICATION_ADAPTER_UNAVAILABLE`）。原因：dsh 0.2.1-rc.5 没有 session 注入/唤醒 API（CLI 只有一次性 `--profile headless`），无法在不额外起模型回合的前提下投递通知。该注册让 pump 以明确的能力错误失败关闭，而不是 `ERR_NOTIFICATION_ADAPTER: adapter is not registered`；未来若 dsh 提供注入面，再替换为真实投递。
5. **`.dsh/settings.json` 与 MCP 配置待核实**：`add dsh` 写出的 `.dsh/settings.json` 采用 `{skills,prompts}` 形状，与 DSH 0.2.x 的 `$DSH_HOME/settings.yaml`（`ui-*` / `locale` / `llm-*` 命名空间）不同构；`mcp install dsh` 写入 `~/.config/dsh/mcp.json`，当前未在 DSH 0.2.1 包内找到该路径的消费证据。二者目前按"预留/未证实"对待，接入生产前需实测。
6. **零 npm 依赖**：`dsh.js` / `dsh-bootstrap.js` / `registry-ext.js` 只用 Node.js 内置模块，继承 `bin/cli.js` 零依赖原则。
7. **`--session-id` 是 DSH 专属**：只有 `dsh` 适配器把它翻译成 `dsh --profile headless --json --session-id <id> -`；其他适配器会静默忽略这个参数（不会报错，也不会续接任何会话）。
8. **批调度不做写隔离**：`agent dispatch-batch` 按任务起独立运行与独立 DSH 会话，但**不会**为每个任务创建 worktree，也不做 lease/permit 授权——并发写同一工作树会互相覆盖。需要隔离时请自行给每个任务分配 worktree，并逐个任务派发。

---

> 返回：[平台集成](./platform-integration.md) | [Adapter Authoring](./architecture/adapter-authoring.md) | [DSH 架构决策](./architecture/dsh-host-adapter.md)
