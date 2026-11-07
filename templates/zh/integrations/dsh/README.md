# DSH (DeepSeek Harness) 集成 — Cortex Agent

本项目通过 `cortex-agent add dsh` 接入 DSH (DeepSeek Harness) 作为 first-class dispatch adapter，与 Pi / Claude Code / Codex CLI 同等地位。

## 前置条件

- 已安装 DSH CLI，且 `dsh` 在 `PATH` 中（`cortex-agent agent adapter probe dsh` 应返回 `status=ready`）。
- 已运行 `cortex-agent init`（生成根 `AGENTS.md` 与 `.agent/` 目录）。

## 安装

```bash
cortex-agent add dsh
```

该命令会：

1. 写入 `.dsh/settings.json`（skills / prompts 指向 `.agent/`，与既有配置 merge）。
2. 写入 `.dsh/README.md` 与 `.dsh/AGENTS.md`。
3. 创建符号链接：`.dsh/skills` → `.agent/skills`、`.dsh/workflows` → `.agent/workflows`。

## 验证

```bash
cortex-agent agent adapter list          # 应包含 dsh
cortex-agent agent adapter probe dsh     # status=ready / transport_supported=text-headless-v1
cortex-agent agent adapter health dsh    # status=ok（叠加 probe，不再只做 which）
```

## 派发（dispatch）

```bash
# agent 条目需 external.adapter_type === "dsh"（存放在 .agent/agents/<id>.json）
# `dsh:` 前缀可选；写了会校验条目 adapter_type 与前缀一致
cortex-agent agent dispatch-execute dsh:<agent-id> "review the schema"
cortex-agent agent dispatch-execute <agent-id> "review the schema"

# 显式加载 bootstrap（可选，等价于 _seed() 自动注册）
NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
  cortex-agent agent adapter health dsh
```

## 能力边界（P-001 frozen vocabulary）

| 能力 | 等级 | 说明 |
| :--- | :--- | :--- |
| session.boundary | explicit | DSH session 生命周期可由 envelope 自报 |
| turn.boundary | adapter | chunk 事件携带 turn/step，可由 shadow backfill 推导 |
| message.boundary | unobservable | DSH 当前不暴露 message 级边界事件 |
| tool.before.observe / block | unsupported | 待 M-018 验证 DSH 真实 hook 能力 |
| tool.update | unobservable | 当前不暴露 |
| context.render.observe | unsupported | 当前不暴露 |

> 以上为 `discover().capability_descriptor` 的静态声明；真实启动面以 `agent adapter probe dsh` 为准。

## 传输与结算（dsh 0.2.1-rc.5 实测）

```text
dsh --profile headless [--json] [--session-id <id>] -
  stdin  : 任务正文（`-` 从 stdin 读取，多行安全）
  stdout : NDJSON 运行事件；{"type":"final","text":...} 是唯一结算信号
```

| status | 条件 |
| :--- | :--- |
| `ok` | exit 0 且出现 `{"type":"final"}` |
| `blocked` | exit 0 但无 `final`（`reason=missing_settled_signal`） |
| `failed` | 非零退出 / `{"type":"error"}` / stdout 不可解析 |
| `timeout` | 适配器侧超时终止 |

## 安全边界

- DSH adapter **不读取** `~/.dsh/sessions/` 下的会话存储（shadow usage 由 `scripts/dsh-usage-sync.js` 单独维护）。
- 未安装 DSH CLI / 探针未 `ready` 时 fail closed：`health()` 返回 `ready: false`，dispatch 返回 `ERR_DSH_TRANSPORT_UNSUPPORTED`（绕过门禁时 `ERR_ADAPTER_SPAWN`），不影响其他宿主。
- 不自动启用 daemon / 自动 dispatch；`cortex-agent add dsh` 保持 opt-in。
