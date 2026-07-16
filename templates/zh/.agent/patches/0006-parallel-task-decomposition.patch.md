---
id: 0006-parallel-task-decomposition
target: workflows/parallel.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## 任务拆分规则联动

调度前必须读取 `.agent/rules/task-decomposition.md`，并按其中规则判断批次：

- 修改同一文件、配置、公共类型、数据库迁移或接口契约的任务默认串行
- 只读调研、验证、文档整理可与实现并行
- 上游接口契约未确认时，不允许多个实现任务并行消费猜测接口
- 每个 sub-agent 上下文包必须包含验收标准、可写范围、不可写范围和冲突检查点
