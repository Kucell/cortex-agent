---
name: mission
description: 通过限定范围的计划、验证契约、结构化交接、命令日志和独立验证，编排长周期多 milestone 工作。
---

# Mission Lite 工作流 (/mission)

当工作超出单次 `/start-task` → `/ship` 循环能稳定承载的范围时，使用 `/mission`：例如多 feature 改造、多天任务，或进入下一阶段前必须完成 milestone 验证的任务。

不要把 Mission Lite 用于小修复、单文件修改或常规文档更新。这类任务继续使用 `/start-task`、`/ship`、`/bug-fix` 或 `/handoff`。

## 使用方式

```text
/mission create "migrate auth module"
/mission status M-001
/mission resume M-001
/mission validate M-001 MS-001
```

## 状态机

```text
SCOPE -> PLAN -> CONTRACT -> EXECUTE_FEATURE -> HANDOFF -> RESUME -> VALIDATE_MILESTONE -> FIX_OR_ADVANCE -> COMPLETE
```

## 核心规则

- 代码修改默认串行。
- 只读研究、验证或文档工作可以并行。
- 每个 milestone 在实现前必须有 validation contract。
- Worker 输出不是证据。Validator 必须基于 contract、diff、命令输出、runtime evidence 和必要源码判断。
- 验证失败时创建 follow-up fix task 或回到规划，不允许 Worker 无限自修。
- 关键命令必须在 `command-log.md` 中记录 exit code。
- Handoff 使用 T-C06 双产物协议：Markdown 面向人，JSON 面向 `AGENT_RESUME`，可用时写入 Artifact Bus 的 `kind: handoff`。

## 文件结构

Mission 状态写入：

```text
.agent/missions/M-xxx/
├── mission-plan.md
├── validation-contract.json
├── command-log.md
├── milestones/
│   └── MS-001.md
└── handoffs/
    ├── YYYYMMDD-HHMMSS-{focus}.md
    └── H-YYYYMMDD-HHMMSS-{focus}.json
```

创建文件时使用这些模板：

```text
.agent/resources/templates/mission/mission-plan.md
.agent/resources/templates/mission/command-log.md
.agent/resources/templates/mission/milestone.md
```

## CREATE

1. 读取项目指令和上下文：
   - `AGENTS.md`
   - `.agent/rules/core-principles.md`
   - `.agent/rules/architecture-design.md`
   - `.agent/rules/code-standards.md`
   - `.agent/plans/task-progress.md`
   - `.agent/plans/context-manifest.json`，如果存在
2. 确认任务确实适合 Mission Lite：
   - 多 feature、多 milestone 或多天范围
   - 有非平凡验证需求
   - 很可能跨 Agent 或跨会话接力
3. 分配下一个 mission ID（`M-001`、`M-002` 等）。
4. 创建 `.agent/missions/M-xxx/` 和子目录。
5. 从 `.agent/resources/templates/mission/mission-plan.md` 创建 `mission-plan.md`，并填写：
   - goal
   - non-goals
   - scope boundaries
   - features
   - milestones
   - sequencing
   - risks
   - exit criteria
6. 使用 `validation-contract` skill 的 CREATE 模式写入 `validation-contract.json`。
7. 从 `.agent/resources/templates/mission/command-log.md` 创建 `command-log.md`。
8. 从 `.agent/resources/templates/mission/milestone.md` 创建第一个 milestone 文件。
9. 在实现前向用户展示 mission plan 和 contract 摘要，等待确认。

## STATUS

1. 读取 `.agent/missions/M-xxx/mission-plan.md`。
2. 读取 `validation-contract.json`。
3. 读取 `command-log.md`。
4. 读取 `milestones/` 下最新 milestone 文件。
5. 汇报：
   - current state
   - current milestone
   - completed work
   - failed or waived assertions
   - commands run and latest exit codes
   - next recommended action

## RESUME

1. 读取项目指令和必需规则。
2. 读取 mission 状态文件。
3. 如果存在 JSON handoff，运行 `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>`。
4. 修改文件前先检查 `git status --short`。
5. 对比 mission 状态、handoff payload、Artifact Bus state 与当前仓库状态。
6. 如果状态过期，报告差异并提出恢复步骤。
7. 从当前状态继续：
   - 如果缺少 contract，回到 CONTRACT
   - 如果存在 pending handoff，进入 RESUME 并执行 `next_action`
   - 如果已有 Worker 输出但尚未验证，进入 VALIDATE_MILESTONE
   - 如果验证失败，进入 FIX_OR_ADVANCE
   - 如果所有 milestone 已通过，进入 COMPLETE

## HANDOFF

1. 按 `/handoff create` 语义写入 Markdown 和 JSON handoff 文件。
2. 验证 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json
   ```
3. Artifact Bus 可用时发布 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json --markdown-path .agent/missions/M-xxx/handoffs/xxx.md --agent-id coordinator
   ```
4. 在 `command-log.md` 或当前 milestone 中记录 handoff 路径。
5. 释放交出方 agent 持有的 Progress Locks；如果 agent 已不可用，则让 TTL 自然过期。

## VALIDATE

1. 读取 `validation-contract.json`。
2. 以 CHECK 模式运行 `validation-contract`。
3. 读取相关 diff 和 command log。
4. 在安全时运行 blocking assertions 要求的命令。
5. 对 runtime assertions 使用 `docs/reliability/` 中的 runtime evidence 模板。
6. 基于 `.agent/resources/templates/mission/milestone.md` 写入或更新 `milestones/MS-xxx.md`：
   - assertions checked
   - evidence
   - command exit codes
   - pass/fail status
   - follow-up fix tasks, if any
7. 进入 `FIX_OR_ADVANCE`。

## FIX_OR_ADVANCE

- 如果 blocking assertions 失败：
  1. 在 `.agent/plans/task-progress.md` 或 mission milestone 文件中创建 follow-up fix task。
  2. 回到 `EXECUTE_FEATURE`。
- 如果验证通过且还有后续 milestone：
  1. 前进到下一个 milestone。
  2. 确认它已有 validation contract。
- 如果所有 milestone 都通过：
  1. 进入 `COMPLETE`。

## COMPLETE

1. 确认所有 milestone 已通过或有明确 waiver。
2. 归档或保留 mission 状态：
   - active 阶段保留 `.agent/missions/M-xxx/`
   - 完成后如有长期价值，将稳定摘要移动到 `docs/exec-plans/completed/`
   - 不删除 command logs 或 milestone evidence
3. 按需运行知识检查：
   - `node .agent/skills/knowledge-lint/scripts/index.js`
   - `node .agent/skills/doc-gardening/scripts/index.js`
4. 更新 `.agent/plans/task-progress.md`。
5. 汇总：
   - mission outcome
   - commits or changed files
   - validation status
   - remaining risks
   - recommended next task

## 质量标准

- 即使没有上一轮对话，mission 状态也必须可恢复。
- milestone 实现前必须存在 validation contract。
- command log 必须包含 exit code，或明确说明命令未运行的原因。
- handoff 必须通过路径引用已有产物，不复制大段内容。
- workflow 必须保持模板驱动和平台无关。
