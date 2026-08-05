---
name: memory-curator
description: Distill raw session / conversation state into structured memory records across 3 categories (episodic / semantic / procedural). Wraps the memory-curator sub-agent for callable use from host agents (Claude Code / Codex / Cursor). Writes to .agent/memory/{episodic,semantic,procedural}/.
mode: general
schema_version: 1
authoritative_subagent: sub-agents/memory-curator.md
related_workflow: workflows/memory-distill.md
---

# memory-curator (L1 — general 模式记忆蒸馏 CLI shell)

general 模式下,记忆蒸馏的核心责任在 sub-agent `sub-agents/memory-curator.md`(RFC §6.6 §12 #5 拍板的**唯一** general 模式首发 sub-agent)。但 host(Claude Code / Codex / Cursor)无法直接 spawn sub-agent 定义,本 skill 把它包装成 CLI 接口,让任何 host 都能调起同一套蒸馏流程。

> 权威协议在 `sub-agents/memory-curator.md`。
> 本文件**不**重定义协议,只声明 CLI 调用面 + 入口示例。

## When to Use

- 用户在 general 模式项目中说"总结一下今天的对话" / "记住这件事" / "把这次会议的关键决策记下来" → dispatch `memory-distill` workflow,实际由本 skill 调起 memory-curator sub-agent
- 在 conversation / session 收尾时,自动触发 /memory distill(频率可配 `config/general-config.yaml` 的 `memory.auto_distill_on_session_end`)
- 主动回忆"我之前是不是说过 X" → 配合 `workflows/memory-recall.md` 调起 recall,**不**需要本 skill

## CLI Surface

```text
node .agent/skills/memory-curator/memory-curator.js distill \
    --source sessions|conversations \
    --since <ISO> \
    --max-records 20 \
    --type episodic,semantic,procedural \
    [--dry-run]

node .agent/skills/memory-curator/memory-curator.js list \
    [--type episodic,semantic,procedural] \
    [--limit 20]

node .agent/skills/memory-curator/memory-curator.js inspect \
    --memory-id <M-XXX> \
    [--show-content]
```

## CLI → Sub-agent 委托

```text
memory-curator.js distill --source sessions --since 2026-08-01
   ↓
[CLI surface] 解析 args + 校验 .agent/sessions/ 或 .agent/conversations/ 存在
   ↓
spawn sub-agent(.agent/sub-agents/memory-curator.md via runtime-adapters/spawn-subagent.js)
   ↓
[sub-agent] 拉源数据 + 提取关键事件/事实/习惯 + schema 校验 + 落 .agent/memory/{type}/<id>.md
   ↓
[CLI surface] 等 sub-agent 完成 → 写 .agent/runs/<run_id>/result.json
   ↓
inbox 通知父 agent
```

## 边界与不变量

- **不** 直接读 .agent/memory/(只读由 `memory-recall` workflow 负责,本 skill **只**写)
- **不** 跨 project 写 memory(per-project 隔离)
- **必** schema 校验通过才落盘(`memory.schema.json` 是 M-001 契约)
- **必** 失败时 rollback draft 文件 + 通知父 agent(失败回滚规则见 `workflows/memory-distill.md` §3)
- **不** 处理 procedural memory 写(目前 procedural 走 `memory-curator --type procedural`,v1.12 推后;RFC §12 #6 拍板)

## 实现状态

本 skill 的**CLI 入口**(`memory-curator.js`)在 MS-002 收口。

本任务(MS-001)只 publish skill 骨架,作为 general 模式 init 后的 skill 之一,放在 `templates/general/.agent/skills/memory-curator/` 让用户在 init 后能发现。

## 关联

- 权威 sub-agent: [`sub-agents/memory-curator.md`](../../sub-agents/memory-curator.md)
- 触发 workflow: [`workflows/memory-distill.md`](../../workflows/memory-distill.md)
- RFC: `docs/architecture/general-mode-design.md` §6.6 §12 #5 拍板
- Schema: `templates/_base/.agent/memory/memory.schema.json`(M-001 publish)
- 实现:MS-002
