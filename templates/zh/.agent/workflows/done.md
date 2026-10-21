---
name: done
description: 快速标记任务完成，更新 task-progress.md 的状态和整体进度百分比。
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules: []
linked_workflows: []
owner: Kucell
last_verified: 2026-10-21
status: stable
---

# 任务完成工作流 (/done)

> **推荐使用 `/ship`**：`/ship T-xxx` 在 DONE 阶段自动调用此逻辑。
> 仅在**不经过代码审查直接标记完成**时单独使用（如文档任务、计划更新等）。

用于快速将一个或多个任务标记为完成，并同步更新进度文档。

## 任务状态写入契约（T-TS-003 / MS-3）

`.agent/tasks/<task-id>.json`（mission 用 `.agent/missions/<mission-id>/mission.json`）是任务状态的唯一真源；
`.agent/plans/task-progress.md` 是由真源派生的视图。写入顺序固定为：

1. 改 JSON 真源（`stage` / `status` / `gates` / `artifacts`）
2. 跑 `node .agent/tasks/scripts/render-progress.js` 重新生成视图
3. JSON 与视图一起提交

禁止手工编辑视图里的 `<!-- generated:* -->` 区（渲染器拥有它，下次渲染会覆盖）。
提交前用 `node .agent/tasks/scripts/render-progress.js --check` 验证（不一致时退出码 1）。
视图的 `<!-- manual:roadmap --> / <!-- manual:backlog --> / <!-- manual:resume -->` 手工区由人维护，渲染器原样保留。

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

### 第四步：提案沉淀检查

检查 `task-progress.md` 中完成的任务行是否有 `Proposal: <路径>` 引用：

- 若有，读取对应提案文件。
- 若提案状态为 `in-progress` 且所有关联 Task 均已完成：
  1. 提示用户将提案的架构要点提炼为纯净的架构文档写入 `docs/architecture/<主题>.md`。
  2. 在提案文件头部回填：
     ```markdown
     > **状态**: done
     > **沉淀文档**: docs/architecture/<主题>.md
     ```
  3. 输出：`📚 架构设计已沉淀到 docs/architecture/<主题>.md，提案状态 → done。`
- 若提案还有其他未完成 Task，跳过，不修改提案状态。

### 第五步：输出确认

展示更新摘要：

```
✅ 已标记完成：T-001（完善 pre-commit-check.sh 多语言支持）
📊 整体进度：82% → 87%
📅 最后更新：2026-03-19
```

并询问是否需要 `/commit` 提交进度文件。
