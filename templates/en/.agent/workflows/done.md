---
name: done
description: 快速标记任务完成，更新 task-progress.md 的状态和整体进度百分比。
---

# 任务完成工作流 (/done)

> **推荐使用 `/ship`**：`/ship T-xxx` 在 DONE 阶段自动调用此逻辑。
> 仅在**不经过代码审查直接标记完成**时单独使用（如文档任务、计划更新等）。

用于快速将一个或多个任务标记为完成，并同步更新进度文档。

## 使用方式

```
/done T-001
/done T-001 T-002
/done T-001 T-002 --progress 95
```

## 执行步骤

### 第一步：读取当前进度

读取 `.agent/plans/task-progress.md`，找到指定任务 ID 的当前状态。

### 第二步：更新任务状态

在 **活跃任务表** 中将对应任务行移除或标记为完成。

在 **路线图** 中将对应 `[ ]` 改为 `[x]`。

将完成的任务摘要追加到 **最近完成** 区块，格式：

```
- <任务描述>（完成于 YYYY-MM-DD）
```

### 第三步：重新计算整体进度

根据路线图中已完成条目占比重新估算 `整体进度` 百分比：
- 若用户通过 `--progress` 参数指定了数值，直接使用该值
- 否则按以下方式估算：`已完成条目数 / 总条目数 × 100%`

更新文件头部的 `> **整体进度**` 和 `> **最后更新**` 字段。

### Step 4: Proposal archiving check

Check whether any completed task row in `task-progress.md` has a `Proposal: <path>` reference:

- If so, read the corresponding proposal file.
- If the proposal status is `in-progress` and all linked Tasks are now done:
  1. Prompt the user to distill the architecture output into a clean document and write it to `docs/architecture/<topic>.md`.
  2. Back-fill the proposal file header:
     ```markdown
     > **Status**: done
     > **Archived Doc**: docs/architecture/<topic>.md
     ```
  3. Output: `📚 Architecture design archived to docs/architecture/<topic>.md — proposal status → done.`
- If the proposal still has incomplete Tasks, skip — do not change the proposal status.

### Step 5: Output Confirmation

Show the update summary:

```
✅ Marked complete: T-001 (improve pre-commit-check.sh multilingual support)
📊 Overall progress: 82% → 87%
📅 Last updated: 2026-03-19
```

Ask if the user wants to `/commit` the progress file.
