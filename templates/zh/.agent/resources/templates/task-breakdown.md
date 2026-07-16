# 任务拆分预览

## 背景

- 需求：{用户需求或方案名称}
- 推荐入口：{/arch-design | /plan | /mission | /parallel | /start-task}
- 判断理由：{为什么选择该入口}

## 拆分策略

- 拆分维度：{模块边界 / 接口边界 / 数据流阶段 / 风险等级 / 其他}
- 串行原因：{必须先做的任务和原因}
- 并行机会：{可并行任务和原因}

## 任务列表

| 任务 ID | 优先级 | 目标 | 范围 | 依赖 | 可并行 | 推荐 Agent |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| T-xxx | P1 | {一句话目标} | `{path}` | 无 | 是/否 | `implementer` |

## 任务详情

### T-xxx {任务名称}

- 目标：{明确结果}
- 输入上下文：{需要读取的 references、proposal、代码路径}
- 预期产出：{代码 / 文档 / 测试 / 配置 / 验证报告}
- 验收标准：
  - {可执行或可检查的 done condition}
- 依赖关系：{依赖哪些任务完成}
- 并行判断：{为什么可以或不可以并行}
- 推荐 Agent：`{planner|researcher|implementer|code-reviewer|documenter|coordinator}`
- 风险与阻断条件：{风险、需要用户确认的点}

## 批次建议

```text
批次 1：
  - T-xxx：{原因}

批次 2：
  - T-yyy：依赖 T-xxx
```

## 下一步

- 建议命令：`{下一条 cortex-agent 工作流命令}`
