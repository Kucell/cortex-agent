# 核心原则

1.  **遵守语言设定**: 始终遵循 `.agent/rules/language.md` 中定义的语言进行交流。
2.  **架构第一**: 在提出任何代码更改建议之前，请务必检查 `.agent/rules/architecture-design.md`。
3.  **遵循工作流**: 当用户运行命令（例如 `/start-task`）时，严格遵循 `.agent/workflows/` 中定义的相应工作流。
4.  **技能优先**: 对于专业任务（例如架构审计），优先使用 `.agent/skills/` 中定义的技能。
5.  **计划驱动**: 所有任务都应以 `.agent/plans/` 中的计划为指导。