---
name: runtime-continuity
description: session-manager 5-mode protocol implemented as a CLI: assess / archive / restore / status / warm. 协议源头是 .agent/sub-agents/session-manager.md(已 ship),本 skill 只把它 CLI 化。归档路径 ~/.agent/contexts/<project>/,与 session-manager 一致。
---

# runtime-continuity (L1 — session-manager CLI 化)

host(Claude Code / Cursor / Codex)无法轻松 spawn 一个 sub-agent 定义文件并等结果。本 skill 把 session-manager 的 5 模式协议包装成 CLI,让任何 host 都能调同一套时间管控纪律。

> 权威协议在 `.agent/sub-agents/session-manager.md`。本文件 **不** 重写协议,只在 CLI 语义必须时记实现差异。

## When to Use

- 命中 5 小时会话时长 → `warm` 先启动计时;每 4 小时整点 → `archive` 做检查点
- 切 host 中途(Claude Code → Codex) → `archive` 然后新 host 跑 `host-switch`(Phase 2)
- 第二天 / 下一会话 / 新 agent 接着干 → `restore`
- "这会话多久没存档了?" → `status`

## Commands

```bash
# 0. assess — 估算任务时间预算
node .agent/skills/runtime-continuity/scripts/index.js assess \
  --task-description "..." --gate user

# 1. archive — 写真到 ~/.agent/contexts/<project>/
node .agent/skills/runtime-continuity/scripts/index.js archive \
  --project <project> --gate user [--note "已完成 X / 进行 Y / 卡点 Z"]

# 2. restore — 加载项目最近一次快照
node .agent/skills/runtime-continuity/scripts/index.js restore \
  --project <project> --gate user [--list | --load latest]

# 3. status — 看上次 archive 时间
node .agent/skills/runtime-continuity/scripts/index.js status \
  --project <project>

# 4. warm — host 应当粘贴的"启动 5h 计时窗口"提示
node .agent/skills/runtime-continuity/scripts/index.js warm
```

## Guarantees

- **路径与协议零偏离**:archive 写真到 session-manager 同款 `~/.agent/contexts/<project>/`,无平行路径、无漂移
- **审计可追溯**:每次 archive / restore / status 调用都写一条 `session_archived` / `session_restored` / `session_status_queried` 事件进 `runs/<active-run>.json#events[]`
- **零依赖**:纯 stdlib + 沿用 management-api 写事件。无 npm install

## Non-Goals

- ❌ 不修改 `.agent/sub-agents/session-manager.md`
- ❌ 不爬 host 私有状态(Claude Code transcript 等)
- ❌ 不做 host 切换拦截(那是 `host-switch`,在 Phase 2/3 draft)

## Source of Truth

- `.agent/sub-agents/session-manager.md` — 协议权威源。**"怎么说"读这里**。
- 本 `SKILL.md` — **"怎么 CLI 化"读这里**。

详细返回值 / helper / 边界看 `scripts/index.js`,单文件 + 充分注释。
