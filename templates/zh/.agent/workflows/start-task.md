---
description: 开始新开发任务的工作流
---

# 任务启动工作流 (/start-task)

## Task Pipeline Gate 所有权

当 `.agent/tasks/<task-id>.json` 存在时，`/start-task` 是唯一可以写入 `plan -> implement` gate 的工作流。开始任何实现编辑前必须：

1. 读取任务文件与 `.agent/tasks/README.md`，确认当前 stage 为 `plan`。
2. 确认所有依赖任务为 `done`，final `plan` 与条件性的 final `architecture` 工件均存在，且其引用文件真实存在。
3. 确认可写范围、不可写范围和验证命令已经记录。
4. 条件满足时由 `/start-task` 把已验证的工件引用加入 gate `evidence_refs`，将 gate 标为 `passed`、stage 设为 `implement`，并同步任务文件、`.agent/tasks/index.json`、`updated_at` 和 stage history。
5. 条件不满足时保持 stage 为 `plan`，由 `/start-task` 将 gate 标为 `blocked` 并记录缺失证据；不得开始实现编辑。

`/start-task` 不创建 final `implementation` 工件，也不得推进 `implement -> validate`；这些动作由 `/ship` 独占。旧任务没有 Task Pipeline 记录时保留传统流程，但必须在报告中注明未启用 Task Pipeline。

1. **环境准备与上下文同步**:
    - 查阅任务进度文档（如 `.agent/plans/task-progress.md`）了解当前项目的开发状态。
    - 确保工作空间是最新的，并运行必要的环境检查。
    - 若 `.agent/skills/management-api/scripts/index.js` 存在，为本次任务创建或更新 Run journal：
      ```bash
      node .agent/skills/management-api/scripts/index.js runs checkpoint \
        --run-id R-<task-id> \
        --task-id <task-id> \
        --kind implement \
        --status running \
        --phase briefing \
        --type state_changed \
        --activity "Starting task context sync"
      ```

2. **上下文预算选择**（调用 `context-budget` skill）:
    - 读取 `.agent/context-index.json`，基于任务描述进行关键词匹配和相关性评分。
    - 选出 Tier 1（高相关）和 Tier 2（中相关）的 reference 文档，确保总注入量不超过上下文窗口的 40%。
    - 在 `.agent/plans/` 下生成 `context-manifest.json`，记录本次上下文分配情况。
    - 如果 `context-index.json` 不存在，提示用户先运行 `/scan-project`，并回退到读取所有 references（旧行为）。

3. **需求分析与影响评估**:
    - 深入理解需求，明确验收标准 (Acceptance Criteria)。
    - **影响范围分析**: 评估改动对现有系统模块、依赖包或上游/下游服务的影响（基于 context-manifest 选出的相关模块）。
    - 识别潜在的技术风险或需要重构的部分。

4. **架构审计与路径选择**:
    - **调用审计技能**: **调用 `architecture-guard` 技能**，结合 `.agent/rules/architecture-design.md` 进行架构预审。
    - 确定逻辑存放的最佳位置（如：通用层 vs 平台特定层）。

5. **制定详细计划**:
    - **委托 `planner` 子代理**: **将”为当前任务制定详细的、分步骤的实施计划”这个目标委托给 `planner` 子代理**。
    - planner 只接收 context-manifest 选中的上下文（Tier 1 完整文档 + Tier 2 完整文档 + Tier 3 摘要首行）。
    - planner 应在 `.agent/plans/` 目录下创建具体的任务实施文档，并包含接口定义、测试规划等。
    - 计划生成后追加 Run event：
      ```bash
      node .agent/skills/management-api/scripts/index.js runs checkpoint \
        --run-id R-<task-id> \
        --type task_decomposed \
        --phase planning \
        --message "Task plan created"
      ```

6. **方案评估**:
    - 对设计方案进行评估，重点关注可扩展性、性能及复杂性。

7. **方案沟通 (若有必要)**:
    - 与用户沟通核心实现思路，特别是涉及重大架构变动时。

8. **编码实施**:
    - 遵循 `.agent/rules/` 下的编码标准。
    - 保持代码的简洁性与一致性。
    - 开始实际编辑前追加 `file_edited` 或 `state_changed` Run event，便于 dashboard 显示当前活动。

9. **验证与回归**:
    - 编写并运行测试用例。
    - 运行类型检查及 Lint 检查。
    - 每个关键验证命令开始/结束时追加 `command_started` / `command_finished`，最终追加 `validation_passed` 或 `validation_failed`。

10. **任务收尾**:
    - 同步更新相关的技术文档或 README。
    - 更新任务进度文档，记录已完成的工作及遗留问题。
    - 任务完成、阻塞或失败时更新 Run journal：
      ```bash
      node .agent/skills/management-api/scripts/index.js runs checkpoint \
        --run-id R-<task-id> \
        --status completed \
        --phase completed \
        --type completed \
        --activity "Task completed"
      ```
