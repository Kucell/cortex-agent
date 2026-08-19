# DSH (DeepSeek Harness) 集成 — Cortex Agent

本项目通过 `cortex-agent add dsh` 接入 DSH (DeepSeek Harness) 作为 first-class dispatch adapter，与 Pi / Claude Code / Codex CLI 同等地位。

## 前置条件

- 已安装 DSH CLI，且 `dsh` 在 `PATH` 中（`cortex-agent agent adapter health dsh` 应返回 `ready: true`）。
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
cortex-agent agent adapter health dsh    # ready: true
```

## 派发（dispatch）

```bash
# 显式手动派发（需 agent 已注册且 external.adapter_type === "dsh"）
cortex-agent agent dispatch-execute dsh:<agent-id> "review the schema"

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

> 以上为 `discover().capability_descriptor` 的静态声明；真实能力以 `health()` 探测为准。

## 安全边界

- DSH adapter **不读取** `~/.dsh/sessions/` 下的会话存储（shadow usage 由 `scripts/dsh-usage-sync.js` 单独维护）。
- 未安装 DSH CLI 时 fail closed：`health()` 返回 `ready: false`，dispatch 返回 `ERR_ADAPTER_SPAWN`，不影响其他宿主。
- 不自动启用 daemon / 自动 dispatch；`cortex-agent add dsh` 保持 opt-in。
