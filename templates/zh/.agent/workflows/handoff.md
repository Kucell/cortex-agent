---
name: handoff
description: 创建或恢复轻量 Markdown 与 JSON 任务交接产物，用于在不同 Agent、会话或 sub-agent 之间转移工作。
---

# Handoff 工作流 (/handoff)

当任务需要交给另一个 Agent、另一个会话或隔离的 sub-agent 上下文继续时，使用 `/handoff`。

T-C06 handoff 输出为双格式：

- Markdown 用于 `HUMAN_RESUME`。
- JSON 用于 `AGENT_RESUME`。
- 当 `.agent/artifacts/scripts/artifact-bus.js` 存在时，发布 Artifact Bus 条目（`kind: handoff`）供 coordinator 索引。

## 使用方式

```text
/handoff create "short task focus"
/handoff resume .agent/handoffs/YYYYMMDD-HHMMSS-short-task-focus.md
/handoff resume .agent/handoffs/H-YYYYMMDD-HHMMSS-short-task-focus.json
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
5. 按 `.agent/handoffs/handoff.schema.json` 语义写入配套 JSON payload。
6. 对已有产物使用路径或 URL 引用，不复制正文。
7. 验证 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
   ```
8. 当 Artifact Bus 存在时，发布 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json --markdown-path .agent/handoffs/YYYYMMDD-HHMMSS-focus.md --agent-id coordinator
   ```
9. Markdown 以 `Resume Prompt` 结尾，让下一个 Agent 可以直接继续。

## RESUME

1. 读取 `AGENTS.md` 和必需的 `.agent/rules/` 文件。
2. 如果输入是 Markdown，读取指定 handoff 文档。
3. 如果输入是 JSON，运行：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>
   ```
4. 修改文件前先检查 `git status --short`。
5. 读取 handoff 引用的计划、Artifact Bus state、源码、测试和文档。
6. 对比 handoff 与当前仓库状态。
7. 对需要写入的续接工作，在可用时获取必要的 Progress Lock scopes。
8. 从 `Next Steps` 或 `next_action` 继续；如果 handoff 已过期，先报告冲突。

## 质量标准

- 即使没有上一轮对话，handoff 也必须可用。
- handoff 应足够小，必要时可以直接粘贴到新 Agent 上下文。
- handoff 必须保留决策、约束、验证状态和下一步动作。
- handoff 不得重复复制 plan、PRD、commit、diff、ADR 和 API 文档。
- JSON handoff payload 必须先通过验证再发布。
- 只有 Artifact Bus 未安装，或任务明确保持 human-only 时，才跳过 Artifact Bus 发布。
