---
name: handoff
description: 创建或恢复轻量任务交接文档，用于在不同 Agent、会话或 sub-agent 之间转移工作。
---

# Handoff 工作流 (/handoff)

当任务需要交给另一个 Agent、另一个会话或隔离的 sub-agent 上下文继续时，使用 `/handoff`。

## 使用方式

```text
/handoff create "short task focus"
/handoff resume .agent/handoffs/YYYYMMDD-HHMMSS-short-task-focus.md
```

## CREATE

1. 读取当前任务来源：
   - `AGENTS.md`
   - `.agent/rules/core-principles.md`
   - `.agent/rules/code-standards.md`
   - `.agent/plans/task-progress.md`，如果存在
   - `.agent/plans/context-manifest.json`，如果存在
2. 检查仓库状态：
   - `git status --short`
   - 当前分支
   - 相关变更文件
3. 如果 `.agent/handoffs/` 不存在，则创建它。
4. 使用 `handoff` skill 模板写入紧凑 Markdown 交接文档。
5. 对已有产物使用路径或 URL 引用，不复制正文。
6. 以 `Resume Prompt` 结尾，让下一个 Agent 可以直接继续。

## RESUME

1. 读取 `AGENTS.md` 和必需的 `.agent/rules/` 文件。
2. 读取指定 handoff 文档。
3. 修改文件前先检查 `git status --short`。
4. 读取 handoff 引用的计划、源码、测试和文档。
5. 对比 handoff 与当前仓库状态。
6. 从 `Next Steps` 继续；如果 handoff 已过期，先报告冲突。

## 质量标准

- 即使没有上一轮对话，handoff 也必须可用。
- handoff 应足够小，必要时可以直接粘贴到新 Agent 上下文。
- handoff 必须保留决策、约束、验证状态和下一步动作。
- handoff 不得重复复制 plan、PRD、commit、diff、ADR 和 API 文档。

