---
name: session-triage
description: 决定是否开 Mission + Run (基于会话信号:turns / debug 关键词 / 工具失败)。open / observe / record-tool / step 四个动作。让活跃任务持久化按 `runtime-state-required` 自动执行。
---

# session-triage (L1 audit-trail — Phase 1)

根据会话信号(turns / 排查关键词 / 工具失败),自动决定是否要开
活跃任务持久化记录(mission + run + 结构化 events)。开好后,
agent 任何 observation / tool failure 都可即时登记 — 让下次 agent /
会话切回来时能从 `.agent/` 看到上下文。

## 何时用

- SessionStart hook 触发,且会话已有 3+ turn 的排查/调试工作 → 自动跑 `triage`
- 任何时候用户出口新 observation → 跑 `observe --message "…"`
- 工具失败后 → 跑 `record-tool --tool <name> --exit <n> --stderr "…"`

## 命令

### 0. `triage` — 决定 + 自动开

```bash
node .agent/skills/session-triage/scripts/index.js triage \
  --threshold 3 \
  --signal-file /tmp/session-signals.json  # optional,默认 stdin
```

读 JSON `{ turns: N, text: "...", tool_failures: N, user_questions: N }`。
输出 `{ open: bool, mission_id?: "M-NNN", run_id?: "R-...", reason }`。
当 `open: true` 时副作用:调 `management-api` 创建 mission 与 run(走
`missions/M-NNN/`、`runs/R-...json` 既有路径)。信号弱时只输出
`open: false`,exit 0(不报失败)。

### 1. `observe` — 登记用户观察

```bash
node .agent/skills/session-triage/scripts/index.js observe \
  --run-id <id> --message "用户观察到画布渲染区域消失" \
  [--phase triage|investigation]
```

追加 `human_observation` 事件到 run 的 events[]。

### 2. `record-tool` — 登记工具失败

```bash
node .agent/skills/session-triage/scripts/index.js record-tool \
  --run-id <id> --tool bash --exit 1 --stderr "ENOENT: no such file" \
  [--phase investigation]
```

追加 `tool_failure` 事件。

### 3. `investigation-step` — 登记排查步骤

```bash
node .agent/skills/session-triage/scripts/index.js step \
  --run-id <id> --message "读了 .agent/missions/M-012/follow-ups.md"
```

追加 `investigation_step` 事件。

## 实现注意

- 纯 CLI;无 daemon、无网络。
- 复用 `management-api runs event`(同一事件 type enum 单一源)。enum 详见 `templates/{zh,en}/.agent/runs/run.schema.json` 新增字段。
- 自动 `mission_id`:扫 `.agent/missions/` 取 `max(NNN) + 1`(归档 mission 留下序号 gap 自然跳过)。
- 自动 `run_id`:扫 `.agent/runs/` 同理。

## 保证

- **仅追加、不破坏**:所有动作都是 additive;从不覆盖既有数据。
- **重试幂等**:同一信号重跑 `triage` 不会双开(24h 同一 slug 已有 run 跳过)。
- **审计友好**:每个动作输出 `ok: true / action / path`。

## 非目标

- 不自动闭合 mission(由 user / owner resolve)
- 不读 transcript 内容(Phase 2 范畴)
- 不自动 promote 到 `experiences/`

## 关联

- `management-api` — 通过 runs event / runs upsert 写入
- `mission` — open 时新建
- `runtime-state-required` 规则 — 定义触发条件
- Phase 2(`audit-trail-transcript-link`)— 依赖本 skill 输出的事件 type
