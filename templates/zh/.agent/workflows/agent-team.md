---
name: agent-team
description: 将当前目标整理为可验证的 Agent 执行批次，并按现有工作流完成预检、派发与独立验收。
type: procedure
applicable_to:
  - all
owner: Cortex Agent Runtime / Workflow
status: draft
last_verified: 2026-10-16
---

# 多 Agent 任务入口（/agent-team）

`/agent-team` 是面向用户的组合入口，不是新的 CLI 调度器或运行态 owner。它选择
`/start-task`、`/plan`、`/mission`、`/parallel` 等已有工作流；需要跨宿主受管启动时，
任务再由 `/agent-orchestration` 检查启动与结算证据。Task、Lease、Operation、
Run、Decision、Waitpoint、worktree 和宿主进程仍由各自原有 owner 管理。

本 L1 入口只规定通用顺序。模型、provider、宿主参数、分支命名、包管理器、设备
和绝对路径由当前项目的 L2/L3 规则与实测能力决定，不从其他项目复制。

## 输入与入口选择

用户可提供任务描述、提案路径、Task ID 或 handoff；无参数时，从当前对话及项目
状态中恢复唯一可识别的目标。先读取项目 `AGENTS.md`、当前任务计划及相关
Proposal、Mission、Decision、Waitpoint、handoff。无法确定目标或多个候选互相
冲突时，报告候选和缺失信息，不自行选择。

1. 需求或共享契约仍为草案：进入 `/arch-design` 或 `/plan`，只做评审与任务拆解。
2. 一个已批准且范围明确的任务：进入 `/start-task`。
3. 多个互不依赖的任务：先依 `task-decomposition` 规则分批，再进入 `/parallel`。
4. 多阶段或跨会话任务：进入 `/mission`；恢复时以正式 handoff 和 owner 状态为准。
5. 规则、工作流或技能维护：进入 `/agent-update`，先核对层级与模板归属。

执行权限以用户本次授权、现有 Decision/Waitpoint 和目标工作流为准。若用户指定 `--dry-run`，只
输出预检和批次，不创建 Task、Lease、worktree、Run 或子进程。

## 任务包与并行预检

每项任务写明目标、验收断言、依赖、`ownedFiles`、不可写范围、共享资源、验证
命令、推荐宿主及其能力证据。先检查同文件、公共契约、运行资源和现有 Task、
Lease、Lock、worktree 的冲突；共享契约未冻结或所有权重叠时按依赖串行。

当前宿主可直接调用的子 Agent 依 `/parallel` 的隔离和验收规则执行，不伪装成
Cortex 受管运行。对受管多宿主任务，调用 `/agent-orchestration` 的只读
`OrchestrationPlan` 预检；每个 blocker 指明 owner 和安全下一步。缺少该工作流
或 `result=blocked` 时停止受管启动，不改用裸进程或手写运行态绕过。

## 模型选择

模型不凭偏好指定，只能从当前宿主实际可用的能力中选取。派发前先探测，再选择。

1. 读取 `.agent/config/reasoning-config.yml`，取得 provider、模型别名
   （如 `fast` / `standard` / `premium`）与角色映射。
2. 读取当前宿主可用的模型清单：Codex 与 Claude Code 以本会话实际提供的模型
   为准，不从配置臆测，也不照抄其他项目的模型 ID。
3. 按 `.agent/sub-agents/*.md` 的既有角色绑定选择模型；该绑定与
   `reasoning-config.yml` 冲突时以本节规则裁决，不静默取其一。

选择规则：

- 别名与宿主实际模型对不上时（例如配置写 `claude-sonnet-4-6` 而宿主只提供
  `gpt-5`），不得直接使用该 ID。标记为 `unverified`，并在首批输出中说明
  可用模型与建议映射，请用户确认后再继续。
- 项目配置中出现宿主不再提供的过时模型 ID 时，指出具体条目，不静默替换。
- 无可用模型证据时，停在选择前报告缺口，不用默认模型顶替。

每项任务的模型选择写入任务包：`model`（实际模型 ID，非别名）、
`model_evidence`（探测来源）、`unverified` 标记。模型不可用时该任务标为
`blocked`，不得降级为默认模型执行。

## 启动与监督

受管多宿主启动只有在既有 owner 确认精确 Decision/Waitpoint、可跨进程读回的
Task、Lease 与 fencing token、worktree identity、`ownedFiles`、
`/dispatch dry-run` 和宿主能力全部匹配后，才交给实际支持启动的 owner 工作流。
`/dispatch` 当前只完成受控派发，不代表宿主进程已启动；具体启动及 receipt
必须由所选宿主的公开能力提供。只读调研及当前会话工作仍按其所属工作流执行，
不伪造受管 Task。

主 Agent 收集真实进度、失败和终态回执，随后独立核对 diff、文件 ownership、
验收命令与 `AttemptSettlement`。进程退出、Worker 自述或 worktree 中出现改动
都不代表完成。验收失败时由原 owner 建立明确后续任务；不得绕过 owner 自动
重试、接管或释放 Lease。提交、推送、创建 PR、合并和清理 worktree 依用户授权
与相应工作流执行。

## 首次输出

首先给出目标、所选入口、依赖批次、每项任务的 owner/宿主能力状态、隔离方式、
所选模型及探测来源、门禁和 blocker；没有实测证据的字段写“待验证”。模型别名
无法映射到宿主实际模型时，先报告可用模型与建议映射，等用户确认再继续。只有
前置条件满足，才继续调用各 owner 工作流。结算时区分 `assigned`、`running`、
`ready_for_review`、`settled` 与 `blocked`，并引用可复查证据。

## 相关工作流

- 任务拆解与并行：`/plan`、`/parallel`、`.agent/rules/task-decomposition.md`
- 指令维护：`/agent-update`
- 长任务与隔离：`/mission`、`/worktree`、`/handoff`
- 受管预检与启动：`/agent-orchestration`、`/dispatch`、宿主实际启动工作流
- 独立验收与收口：`/agent-supervise`、`/ship`
