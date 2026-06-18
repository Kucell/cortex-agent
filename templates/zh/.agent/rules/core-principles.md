# 核心原则

1.  **遵守语言设定**: 始终遵循 `.agent/rules/language.md` 中定义的语言进行交流。
2.  **架构第一**: 在提出任何代码更改建议之前，请务必检查 `.agent/rules/architecture-design.md`。
3.  **行为规则**: 会话开始时读取 `.agent/rules/ai-behavior.md` —— 它管理 Git 纪律、编辑范围、代码探索策略（含 `graphify-out/graph.json` 存在时优先使用 Graphify）以及分阶段提交协议。
4.  **遵循工作流**: 当用户运行命令（例如 `/start-task`）时，严格遵循 `.agent/workflows/` 中定义的相应工作流。
5.  **技能优先**: 对于专业任务（例如架构审计），优先使用 `.agent/skills/` 中定义的技能。
6.  **计划驱动**: 所有任务都应以 `.agent/plans/` 中的计划为指导。
7.  **显式维护**: 当新增指令具有通用性时，优先存入全局配置 `~/.agent/`；当涉及项目特定业务或私有逻辑时，必须存入本地 `.agent/` 目录。使用 `/agent-update` 维护这些配置。
