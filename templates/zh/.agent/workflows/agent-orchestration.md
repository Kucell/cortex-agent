---
description: 受管 Agent 的 L1 组合编排工作流：只读预检、owner-bound launch gate 与 settlement evidence。
---

# 受管 Agent 编排（`/agent-orchestration`）

本 L1 工作流组合既有 `/start-task`、`/plan`、`/mission`、`/parallel`、`/worktree`、`/dispatch` 与 `/launch-governed-agent` owner。它只生成只读 `OrchestrationPlan` 和 `AttemptSettlement` 汇总，绝不成为第二个 Task、Lease、Operation、Run、Decision、Waitpoint 或 host state owner。

## 范围

- 仅用于受管多宿主启动、恢复或结算；单会话工作保留原入口。
- L1 只定义证据、owner 与 fail-closed 顺序。模型、provider、操作系统、包管理器、绝对路径和分支策略属于 L2，不得写入这里。
- 本工作流不得创建 worktree、Task、Lease、Queue、Run 或子进程；既有 owner 通过公开命令负责写入。

## 只读 OrchestrationPlan

`--dry-run` 返回包含 `taskId`、入口、`ownedFiles`、资源、依赖、宿主要求、Decision/Waitpoint gate、结果和 blocker 的 `OrchestrationPlan`。每个 blocker 必须标注 owning workflow 与安全下一步。

当 `result=blocked` 时必须停止；不得用独立进程、手写 runtime state 或替代 Lease 绕过。

## Launch readiness gate

只有以下 gate 按顺序全部通过后，才可调用既有 `/launch-governed-agent` owner：

1. 精确 resource-bound Decision 已批准，且对应 Waitpoint 已释放；
2. Task create 后，新的 CLI 进程可由 `task status` 与 `task list` 读回同一 Task；跨进程读回失败时不得获取 Lease 或 launch；
3. 既有 Lease owner 确认 `task:<id>`、fencing token、worktree identity 与 `ownedFiles` 一致；
4. 既有 `/dispatch dry-run` 无 idempotency、lock、Lease、capability 或 isolation conflict；
5. 既有 host capability owner 已提供 acceptance 与 terminal receipt 所需证据。

本工作流不创建 Task 或 Lease，也不解释或修改其 runtime namespace。

## AttemptSettlement gate

`assigned` 仅表示 coordination 已分派，不代表 host 已运行。只有具备以下全部证据，既有 projection owner 才可报告 `settled`：

| 阶段 | 所需证据 | owner |
| :--- | :--- | :--- |
| accepted | `task.accepted` 与 host receipt | launch / host adapter |
| progressing | active、productive、verified evidence 或明确 blocked | supervision / task owner |
| validating | validation receipt 与独立验证结果 | validator |
| settled | `agent_settled` 或结构化 failed/cancelled receipt，且 Task、Lease、Operation 已对账 | host monitor / coordination owner |

缺少结算证据时，`assigned`、仅有 worktree diff、或 `FAILED` 加存活 Lease 都必须标为 `unsettled`。编排器只报告 owner、到期和允许恢复路径；不得自动 release、retry、takeover、cleanup、commit 或 launch。

## 验证

验证者独立检查 diff、运行契约命令，并读取 owner projection。Worker 描述、进程启动和 worktree 改动都不是结算证明。若下游 pilot 需要启动 host 或影响其他项目，必须创建新的精确 Decision 和 Waitpoint。
