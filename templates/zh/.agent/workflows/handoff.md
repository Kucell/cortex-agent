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
3. 写 handoff 前先记录 Runtime Continuity checkpoint：
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   node .agent/skills/runtime-continuity/scripts/index.js checkpoint \
     --project "$PROJECT_NAME" \
     --gate agent \
     --type handoff \
     --phase handoff \
     --message "Creating handoff for <task-or-focus>"
   ```
4. 如果 `.agent/handoffs/` 不存在，则创建它。
5. 使用 `handoff` skill 模板写入紧凑 Markdown 交接文档。
6. 按 `.agent/handoffs/handoff.schema.json` 语义写入配套 JSON payload。
7. 对已有产物使用路径或 URL 引用，不复制正文。
8. 验证 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
   ```
9. 当 Artifact Bus 存在时，发布 JSON payload：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json --markdown-path .agent/handoffs/YYYYMMDD-HHMMSS-focus.md --agent-id coordinator
   ```
10. Markdown 以 `Resume Prompt` 结尾，让下一个 Agent 可以直接继续。
11. 若 Management API 存在，为当前任务追加 `handoff_created` Run event：
    ```bash
    cortex-agent runs checkpoint --project . \
      --run-id R-<task-id> \
      --status running \
      --phase handoff \
      --type handoff_created \
      --message "Handoff artifact created"
    ```

## RESUME

1. 读取 `AGENTS.md` 和必需的 `.agent/rules/` 文件。
2. 先运行 Runtime Continuity resume bundle：
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project "$PROJECT_NAME"
   ```
3. 如果输入是 Markdown，读取指定 handoff 文档。
4. 如果输入是 JSON，运行：
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>
   ```
5. 修改文件前先检查 `git status --short`。
6. 读取 handoff 引用的计划、Artifact Bus state、源码、测试和文档。
7. 对比 handoff、Runtime Continuity archive 与当前仓库状态。
8. 对需要写入的续接工作，在可用时获取必要的 Progress Lock scopes。
9. 从 `Next Steps` 或 `next_action` 继续；如果 handoff 已过期，先报告冲突。
10. 若 Management API 存在，在可写续接前将 Run journal 更新为 `status=running`、`phase=handoff`，并追加 `state_changed` event。

## 质量标准

- 即使没有上一轮对话，handoff 也必须可用。
- handoff 应足够小，必要时可以直接粘贴到新 Agent 上下文。
- handoff 必须保留决策、约束、验证状态和下一步动作。
- handoff 不得重复复制 plan、PRD、commit、diff、ADR 和 API 文档。
- JSON handoff payload 必须先通过验证再发布。
- 只有 Artifact Bus 未安装，或任务明确保持 human-only 时，才跳过 Artifact Bus 发布。

## Session 转换

- handoff 发布后，使用 `sessions pause --session-id <id> --gate handoff --activity "Handoff published"` pause 来源 owner session。
- resume 时由目标 Agent 打开自己的 session，或 heartbeat 与其 owner 匹配的 session；不得刷新来源 owner heartbeat。
- Session 转换证据必须引用 handoff 和 active Run；`stale` 仍然只在读取时派生。
