---
id: 0007-mission-task-decomposition
target: workflows/mission.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## Mission 拆分规则联动

创建 mission 时必须读取 `.agent/rules/task-decomposition.md`，并可使用 `.agent/resources/templates/task-breakdown.md` 辅助判断：

- 哪些工作必须作为前置架构、接口或迁移里程碑
- 哪些 milestone 可以并行做只读调研、验证或文档
- 哪些实现任务必须串行，避免同文件或同契约冲突
- 每个 milestone 的验收标准是否足够独立、可恢复、可验证
