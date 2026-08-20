---
description: 开始新开发任务的工作流
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules: []
linked_workflows:
  - spec.md
owner: Kucell
last_verified: 2026-08-19
status: stable
---

<!-- EN translation pending: structural English skeleton; detailed Chinese body below is the source of truth. TODO: translate the gate-ownership rules, the clarification checklist (step 3), and steps 4–11 fully into English. -->

# Task Startup Workflow (/start-task)

## Task Pipeline Gate Ownership

When `.agent/tasks/<task-id>.json` exists, `/start-task` is the only workflow allowed to write the `plan -> implement` gate. Before any implementation edit begins:

1. Read the task file and `.agent/tasks/README.md`, and confirm that the current stage is `plan`.
2. Confirm that every dependency is `done`, final `plan` and any conditional final `architecture` artifacts exist, and each referenced file exists.
3. Confirm that writable scope, non-writable scope, and validation commands are recorded.
4. When all conditions pass, `/start-task` adds the verified artifact refs to gate `evidence_refs`, marks the gate `passed`, sets stage to `implement`, and synchronizes the task file, `.agent/tasks/index.json`, `updated_at`, and stage history.
5. When a condition fails, keep stage at `plan`; `/start-task` marks the gate `blocked` and records the missing evidence. Do not begin implementation edits.

`/start-task` does not create a final `implementation` artifact and must not advance `implement -> validate`; `/ship` exclusively owns those actions. Preserve the legacy flow for tasks without a Task Pipeline record, but report that the Task Pipeline is not enabled.

1. **环境准备与上下文同步 (Environment prep & context sync)**:
    - 查阅任务进度文档（如 `.agent/plans/task-progress.md`）了解当前项目的开发状态。
    - 确保工作空间是最新的，并运行必要的环境检查。
    - Run `cortex-agent dashboard ensure --project . --reason start-task`; when automation is disabled it must succeed with zero writes and zero processes.
    - If `cortex-agent help --json` is available, create or update the Run journal for this task:
      ```bash
      cortex-agent runs checkpoint --project . \
        --run-id R-<task-id> \
        --task-id <task-id> \
        --kind implement \
        --status running \
        --phase briefing \
        --type state_changed \
        --activity "Starting task context sync"
      ```

2. **上下文预算选择 (Context budget selection)**（调用 `context-budget` skill）:
    - 读取 `.agent/context-index.json`，基于任务描述进行关键词匹配和相关性评分。
    - 选出 Tier 1（高相关）和 Tier 2（中相关）的 reference 文档，确保总注入量不超过上下文窗口的 40%。
    - 在 `.agent/plans/` 下生成 `context-manifest.json`，记录本次上下文分配情况。
    - 如果 `context-index.json` 不存在，提示用户先运行 `/scan-project`，并回退到读取所有 references（旧行为）。

3. **需求澄清清单 (Requirement clarification checklist)**（前置 `/spec` 检查，详见 `workflows/spec.md`）:
    - 若任务产出非代码（文档/报告/分析/调研），或属于编程任务但范围/边界未明确，先检查 `.agent/specs/` 是否存在对应 `spec.md`：
        - **存在**：读取完整 Spec，确认所有必填字段已填齐；缺失字段回到 `/spec CLARIFY` 补齐，禁止 AI 自行猜测后继续。
        - **不存在**：触发 `/spec start "<spec-id>" "<需求>"` 引导用户走轻量澄清流程；澄清完成后再回到本工作流的"需求分析与影响评估"。
    - 对编程任务，Spec 的"范围与边界"+"禁止事项"字段必须与 `architecture-design.md` §8 / `test-policy.md` §3 对齐后再进入实现。
    - 此步骤不创建 Task Pipeline gate 也不创建 `.agent/specs/<id>` 之外的产物；与 `/spec` 工作流职责分工：`/spec` 负责轻量 Spec，`/start-task` 负责 Task Pipeline gate 推进。

4. **需求分析与影响评估 (Requirement analysis & impact assessment)**:
    - 深入理解需求，明确验收标准 (Acceptance Criteria)。
    - **影响范围分析**: 评估改动对现有系统模块、依赖包或上游/下游服务的影响（基于 context-manifest 选出的相关模块）。
    - 识别潜在的技术风险或需要重构的部分。

5. **架构审计与路径选择 (Architecture audit & placement)**:
    - **调用审计技能**: **调用 `architecture-guard` 技能**，结合 `.agent/rules/architecture-design.md` 进行架构预审。
    - 确定逻辑存放的最佳位置（如：通用层 vs 平台特定层）。

6. **制定详细计划 (Detailed planning)**:
    - **委托 `planner` 子代理**: **将”为当前任务制定详细的、分步骤的实施计划”这个目标委托给 `planner` 子代理**。
    - planner 只接收 context-manifest 选中的上下文（Tier 1 完整文档 + Tier 2 完整文档 + Tier 3 摘要首行）。
    - planner 应在 `.agent/plans/` 目录下创建具体的任务实施文档，并包含接口定义、测试规划等。
    - 计划生成后追加 Run event：
      ```bash
      cortex-agent runs checkpoint --project . \
        --run-id R-<task-id> \
        --type task_decomposed \
        --phase planning \
        --message "Task plan created"
      ```

7. **方案评估 (Solution evaluation)**:
    - 对设计方案进行评估，重点关注可扩展性、性能及复杂性。

8. **方案沟通 (Solution communication, if needed)**:
    - 与用户沟通核心实现思路，特别是涉及重大架构变动时。

9. **编码实施 (Implementation)**:
    - 遵循 `.agent/rules/` 下的编码标准。
    - 保持代码的简洁性与一致性。
    - 开始实际编辑前追加 `file_edited` 或 `state_changed` Run event，便于 dashboard 显示当前活动。

10. **验证与回归 (Verification & regression)**:
    - 编写并运行测试用例。
    - 运行类型检查及 Lint 检查。
    - 每个关键验证命令开始/结束时追加 `command_started` / `command_finished`，最终追加 `validation_passed` 或 `validation_failed`。

11. **任务收尾 (Task wrap-up)**:
    - 同步更新相关的技术文档或 README。
    - 更新任务进度文档，记录已完成的工作及遗留问题。
    - 任务完成、阻塞或失败时更新 Run journal：
      ```bash
      cortex-agent runs checkpoint --project . \
        --run-id R-<task-id> \
        --status completed \
        --phase completed \
        --type completed \
        --activity "Task completed"
      ```
