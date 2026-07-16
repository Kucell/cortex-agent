---
id: 0005-plan-task-decomposition
target: workflows/plan.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## 多 Agent 任务拆分补充

在任务拆解前读取：

- `.agent/rules/task-decomposition.md`
- `.agent/resources/templates/task-breakdown.md`

每个任务除 ID、优先级、描述、验收标准和依赖外，还必须标明：

- 是否可并行，以及原因
- 推荐 Agent（planner / researcher / implementer / code-reviewer / documenter / coordinator）
- 可写范围、不可写范围和冲突检查点

若需求适合多 Agent 协作，先用 task-breakdown 模板输出拆分预览，再询问用户是否写入计划。
