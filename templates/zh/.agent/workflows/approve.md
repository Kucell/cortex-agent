---
name: approve
description: 批准架构提案，按规模自动调度到 /plan（小任务）或 /mission（大任务），并建立双向链接。
---

# 提案批准与调度工作流 (/approve)

将已确认的架构设计提案从 `draft` 推进到执行阶段。
本命令是 `/arch-design` 与 `/plan` / `/mission` 之间的唯一衔接点。

## 使用方式

```
/approve <提案文件路径>
/approve .agent/plans/proposals/xxx-proposal.md
```

## 前置条件

- 提案文件存在于 `.agent/plans/proposals/`。
- 提案状态字段为 `draft`（已是 `approved` 或更高状态时给出提示并停止）。
- 提案中有明确的 `落地计划` 或 `Phase` 章节（用于规模判断）。

---

## 执行步骤

### 第一步：读取并校验提案

1. 读取指定的提案文件。
2. 确认 `> **状态**:` 字段存在且值为 `draft`。
   - 若状态已是 `approved` 或更高：提示"提案已批准，无需重复操作"并停止。
   - 若状态字段缺失：提示用户在提案头部补充标准状态字段，停止。
3. 提取提案信息：
   - 核心目标（一句话）
   - Phase 数量（扫描 `### Phase` 标题计数）
   - 是否有跨会话/跨天的工作量描述

### 第二步：规模判断

根据以下规则输出规模建议（供用户确认，不强制执行）：

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

用户确认后，将提案文件头部的状态字段从 `draft` 改为 `approved`：

```markdown
> **状态**: approved
```

### 第四步：调度执行

**路径 A：/plan（小任务）**

执行 `/plan --from-proposal <提案文件路径>`：
- 读取提案的 Phase 列表作为任务拆解输入
- 将 Task ID 回填到提案 `执行载体` 字段
- 将提案状态从 `approved` 改为 `in-progress`

**路径 B：/mission（大任务）**

执行 `/mission create --from-proposal <提案文件路径>`：
- 读取提案的 Phase 列表，按 Phase 映射 milestone
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
