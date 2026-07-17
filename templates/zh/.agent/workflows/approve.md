---
name: approve
description: 批准架构提案并调度执行，或在用户明确选择后解析资源绑定的 Decision。
---

# 提案批准、调度与 Decision 解析工作流 (/approve)

本工作流有两个互斥模式：

- **Proposal 模式**：将已确认的架构设计提案从 `draft` 推进到执行阶段，是 `/arch-design` 与 `/plan` / `/mission` 之间的唯一衔接点。
- **Decision 模式**：把用户对某个资源绑定 Decision 的明确选择写入 Decision Store。它只解析选择，不执行受保护动作，也不释放 Waitpoint。

## 使用方式

```
/approve <提案文件路径>
/approve .agent/plans/proposals/xxx-proposal.md
/approve .agent/plans/proposals/projects/<project-slug>/index.md
/approve decision D-<id> --choice approve|reject|revise
```

输入以 `decision` 开头时进入 Decision 模式；其他输入进入 Proposal 模式。禁止根据 Dashboard 按钮、消息内容、历史偏好、沉默或调用者提供的 `--gate approve` 推断用户选择。

## Decision 模式

1. 运行只读查询并读取目标文件：

   ```bash
   node .agent/skills/management-api/scripts/index.js query decisions
   ```

2. 确认 `.agent/decisions/D-<id>.json` 存在且 `status` 为 `open`。
3. 向用户展示 `prompt`、全部 `options`、`gate.action`、`gate.resource_ref`、请求工作流及关联的 blocking Waitpoint。
4. 用户必须在当前交互中明确选择 `approve`、`reject` 或 `revise`。Dashboard 和只读查询只能展示或请求处理，不能视为批准。
5. 将选择映射为 `approved/approve`、`rejected/reject` 或 `revision_requested/revise`，取得用户身份标识和非空理由后执行：

   ```bash
   node .agent/skills/management-api/scripts/index.js decisions resolve \
     --decision-id D-<id> \
     --gate user \
     --status <approved|rejected|revision_requested> \
     --selected-option <approve|reject|revise> \
     --resolved-by <user-id> \
     --rationale "<用户理由>"
   ```

6. 重新读取 Decision 并报告结果。`/approve` 不得调用 `waitpoints release`，不得执行 merge、release、destructive、credential 或 external side effect；原动作的 owning workflow 必须验证 Decision 的 action/resource 后自行消费。

---

## Proposal 模式

### 前置条件

- 输入是 `.agent/plans/proposals/` 下的单点提案、项目级 `index.md` 或项目级子提案。
- 待批准范围的状态为 `draft`（已是 `approved` 或更高状态时给出提示并停止）。
- 待批准范围有明确的 `落地计划`、`Phase` 或 milestone（用于规模判断）。
- 若提案来自 `/arch-design` 并引用架构 Decision/Waitpoint，Proposal 模式必须验证 Decision 已明确批准且 Waitpoint 已由 `/arch-design` 释放；本模式中的调度确认不能替代该证据。

---

### 执行步骤

### 第一步：读取并校验提案

1. 读取指定的提案文件。若输入是项目级 `index.md`，先读取入口，再读取待批准 milestone 关联的子提案；若输入是子提案，同时读取同项目的 `index.md`。
2. 判断批准范围：单点提案、整个项目、某个 milestone 或某个子提案。项目级输入未明确范围时，必须先请用户选择，禁止默认批准整个项目。
3. 确认待批准范围的 `> **状态**:` 字段或索引状态存在且值为 `draft`。
   - 若状态已是 `approved` 或更高：提示"提案已批准，无需重复操作"并停止。
   - 若状态字段缺失：提示用户在提案头部补充标准状态字段，停止。
4. 提取所选范围的信息：
   - 核心目标（一句话）
   - Phase 数量（扫描 `### Phase` 标题计数）
   - 项目级范围对应的 milestone 与子提案
   - 是否有跨会话/跨天的工作量描述

### 第二步：规模判断

根据所选批准范围按以下规则输出规模建议（供用户确认，不强制执行）：

| 条件 | 建议路径 |
| :--- | :--- |
| Phase 数 ≤ 2 且未提及跨会话 | `/plan`（小任务） |
| Phase 数 ≥ 3 或提及多天/跨会话/需里程碑验证 | `/mission`（大任务） |

输出建议，格式：

```
📋 提案：xxx-proposal.md
🎯 核心目标：[一句话目标]
📊 规模判断：[N] 个 Phase → 建议走 [/plan | /mission]

理由：[Phase 数/跨会话描述/验证需求]

确认调度方式？(plan / mission / 取消)
```

等待用户确认，支持用户覆盖建议（如选择 `plan` 即使建议 `mission`）。

### 第三步：更新提案状态

用户确认后，只更新所选批准范围：

- 单点提案或子提案：将文件头部状态从 `draft` 改为 `approved`；若为子提案，同步更新 `index.md` 中对应行的状态。
- 整个项目：更新 `index.md` 的项目状态，不自动批准仍需独立评审的子提案。
- 某个 milestone：更新 `index.md` 中该 milestone 的状态，并仅更新本次明确包含的子提案。

提案文件状态格式：

```markdown
> **状态**: approved
```

### 第四步：调度执行

**路径 A：/plan（小任务）**

执行 `/plan --from-proposal <提案文件路径>`：
- 项目级范围传入 `index.md`，由 `/plan` 从入口读取所选 milestone 与相关子提案
- 单点提案或子提案读取其 Phase 列表作为任务拆解输入
- 将 Task ID 回填到提案 `执行载体` 字段
- 将提案状态从 `approved` 改为 `in-progress`

**路径 B：/mission（大任务）**

执行 `/mission create --from-proposal <提案文件路径>`：
- 项目级范围传入 `index.md`，按所选 milestone 和相关子提案建立执行里程碑
- 单点提案或子提案按 Phase 映射 milestone
- 将 Mission ID 回填到提案 `执行载体` 字段
- 将提案状态从 `approved` 改为 `in-progress`

### 第五步：输出确认

```
✅ 提案已批准：xxx-proposal.md
📌 执行载体：[T-006~T-008 | M-002]
🔗 双向链接已建立

建议下一步：
  小任务 → /start-task T-006
  大任务 → /mission status M-002
```

---

## 提案头部标准字段参考

```markdown
> **状态**: draft → approved → in-progress → done | superseded
> **执行载体**: 待批准（/approve 后自动回填）
> **沉淀文档**: —（done 后自动回填）
> **创建日期**: YYYY-MM-DD
```

提案完成执行后，请通过 `/done T-xxx` 或 `mission COMPLETE` 触发沉淀流程，
将精炼后的架构描述写入 `docs/architecture/`，提案状态变为 `done`。

## 统一安全边界

- Decision Gate 必须绑定精确的 `gate.action` 和 `gate.resource_ref`；ID 或 `--gate approve` 字符串本身不是授权证据。
- architecture、destructive、credential、external_side_effect 必须先由动作 owning workflow 创建匹配 action/resource 的 Decision 与 Waitpoint，再由用户解析 Decision；架构批准不能替代破坏性操作批准。
- 不自动执行 `reset`、`revert`、`push`、`deploy` 或其他外部副作用。
