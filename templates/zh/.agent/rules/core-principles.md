---
title: "核心原则 (Core Principles)"
description: "> **核心原则**：所有协助开发的 AI 必须遵守以下基础约定 —— 语言设定、架构优先、行为红线、运行时产物落盘位置，以及规则、工作流、技能各自的维护边界。"
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-28
status: stable
---

# 核心原则

1.  **遵守语言设定**: 始终遵循 `.agent/rules/language.md` 中定义的语言进行交流。
2.  **架构第一**: 在提出任何代码更改建议之前，请务必检查 `.agent/rules/architecture-design.md`。
3.  **行为规则**: 会话开始时读取 `.agent/rules/ai-behavior.md` —— 它管理 Git 纪律、编辑范围、代码探索策略（含 `graphify-out/graph.json` 存在时优先使用 Graphify）以及分阶段提交协议。
4.  **运行时产物落盘**: 凡需持久化的运行时产物（单次运行 JSON、单样本观测、调试日志、临时 JSON、探针脚本），一律落在 `.agent/` 下，详见 `.agent/rules/runtime-artifacts-location.md`。**不得**写入 `/tmp`、home 目录或项目根——那些位置会随会话或系统清理而丢失。
5.  **Memory 索引**: 会话开始时已由 SessionStart hook 自动加载 `.agent/memory/MEMORY.md`（≤200 行 / 25KB cap）；按需 Read topic 文件（`{user,feedback,project,reference}/*.md`）。详见 `.agent/rules/memory-protocol.md`。
6.  **提案目录结构**: 创建或重组架构提案前读取 `.agent/rules/proposal-structure.md`，尤其是大项目或关联项目提案组。
7.  **遵循工作流**: 当用户运行命令（例如 `/start-task`）时，严格遵循 `.agent/workflows/` 中定义的相应工作流。
8.  **技能优先**: 对于专业任务（例如架构审计），优先使用 `.agent/skills/` 中定义的技能。
9.  **计划驱动**: 所有任务都应以 `.agent/plans/` 中的计划为指导。
10. **显式维护**: 当新增指令具有通用性时，优先存入全局配置 `~/.agent/`；当涉及项目特定业务或私有逻辑时，必须存入本地 `.agent/` 目录。使用 `/agent-update` 维护这些配置。
11. **单一真源边界**: `.agent/` 是 Cortex Agent 唯一维护源。`.agents/skills/source-command-*` 等外部兼容目录属于生成适配层，不得作为规则、工作流或技能的维护入口。
12. **适配器真源回归**: `AGENTS.md` 中的 `## Compatibility Adapter Bootstrap` 受管块规定：当宿主从 `.agents/skills/source-command-<command>` 识别出命令后，**任何任务动作之前必须**加载 `.agent/workflows/<command>.md`。如果该真源工作流缺失，必须显式报告“适配器与真源不一致”并停止执行，不得回退到适配器副本。
