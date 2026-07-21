# 核心原则

1.  **遵守语言设定**: 始终遵循 `.agent/rules/language.md` 中定义的语言进行交流。
2.  **架构第一**: 在提出任何代码更改建议之前，请务必检查 `.agent/rules/architecture-design.md`。
3.  **行为规则**: 会话开始时读取 `.agent/rules/ai-behavior.md` —— 它管理 Git 纪律、编辑范围、代码探索策略（含 `graphify-out/graph.json` 存在时优先使用 Graphify）以及分阶段提交协议。
4.  **Memory 索引**: 会话开始时已由 SessionStart hook 自动加载 `.agent/memory/MEMORY.md`（≤200 行 / 25KB cap）；按需 Read topic 文件（`{user,feedback,project,reference}/*.md`）。详见 `.agent/rules/memory-protocol.md`。
5.  **提案目录结构**: 创建或重组架构提案前读取 `.agent/rules/proposal-structure.md`，尤其是大项目或关联项目提案组。
6.  **遵循工作流**: 当用户运行命令（例如 `/start-task`）时，严格遵循 `.agent/workflows/` 中定义的相应工作流。
7.  **技能优先**: 对于专业任务（例如架构审计），优先使用 `.agent/skills/` 中定义的技能。
8.  **计划驱动**: 所有任务都应以 `.agent/plans/` 中的计划为指导。
9.  **显式维护**: 当新增指令具有通用性时，优先存入全局配置 `~/.agent/`；当涉及项目特定业务或私有逻辑时，必须存入本地 `.agent/` 目录。使用 `/agent-update` 维护这些配置。
10. **单一真源边界**: `.agent/` 是 Cortex Agent 唯一维护源。`.agents/skills/source-command-*` 等外部兼容目录属于生成适配层，不得作为规则、工作流或技能的维护入口。
