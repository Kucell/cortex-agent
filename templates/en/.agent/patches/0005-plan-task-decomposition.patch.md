---
id: 0005-plan-task-decomposition
target: workflows/plan.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## Multi-Agent Breakdown Addendum

Before decomposing tasks, read:

- `.agent/rules/task-decomposition.md`
- `.agent/resources/templates/task-breakdown.md`

In addition to ID, priority, description, acceptance criteria, and dependencies, each task must state:

- Whether it can run in parallel, and why
- Recommended agent (planner / researcher / implementer / code-reviewer / documenter / coordinator)
- Writable scope, non-writable scope, and conflict checkpoints

If the requirement is suitable for multi-agent collaboration, first output a preview using the task-breakdown template, then ask whether to write it to the plan.
