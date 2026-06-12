---
name: handoff
description: 创建或恢复人可读与机器可读的轻量任务交接产物，用于在不同 Agent、会话或 sub-agent 之间转移工作，同时避免复制大型产物。
---

# Handoff Skill

## 目标

当任务需要从一个 Agent、会话或执行上下文切换到另一个上下文时，使用本技能。交接文档必须保留任务状态，同时让下一个上下文保持轻量、可执行。

本技能面向任务级交接。长会话时间存档仍由 `session-manager` 负责。

T-C06 handoff 使用双产物协议：

- Markdown 是人可读交接文档。
- JSON 是面向 `AGENT_RESUME` 的 agent 可读交接文档。
- Artifact Bus 将 JSON payload 保存为 `kind: handoff`，coordinator 不需要解析 Markdown 也能恢复。

## 模式

### CREATE

在 `.agent/handoffs/` 下创建 Markdown 文件，命名格式为：

```text
YYYYMMDD-HHMMSS-{short-focus}.md
```

同时在旁边创建 JSON payload：

```text
H-YYYYMMDD-HHMMSS-{short-focus}.json
```

文件必须足够自包含，让新 Agent 能开始工作；但不得重复复制已有 plan、PRD、ADR、commit、diff、issue 或 API 文档中的内容。应通过路径、commit 或 URL 引用这些产物。

当 Artifact Bus 存在时，验证并发布 JSON payload：

```bash
node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json --markdown-path .agent/handoffs/YYYYMMDD-HHMMSS-focus.md --agent-id coordinator
```

### RESUME

从人可读 handoff（`HUMAN_RESUME`）恢复时：

1. 先读取 `AGENTS.md` 和必需的 `.agent/rules/` 文件。
2. 读取 handoff 文档。
3. 默认只读取 handoff 引用的文件，除非代码搜索显示 handoff 已过期。
4. 执行前对比 handoff、`git status` 和当前代码。
5. 如果 handoff 与仓库状态冲突，以仓库状态为准，并报告冲突。

### AGENT_RESUME

从 JSON 恢复时：

1. 先读取 `AGENTS.md` 和必需的 `.agent/rules/` 文件。
2. 运行 `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>`。
3. 读取 `artifacts.context_snapshot_ref` 和被引用的 Artifact Bus 条目。
4. 如果 Progress Lock 可用，在写入前获取必要的 task/file locks。
5. 从 `task_progress.current_step` 和 `next_action` 继续。
6. 如果 JSON、Artifact Bus state 和仓库状态不一致，停止并报告 `blocked`。

## 交接模板

```markdown
# Handoff: {task or focus}

## Current Goal

{一句话说明下一个 Agent 要完成什么。}

## Confirmed Facts

- {已经确认的需求、决策、约束或事实。}

## Current Progress

- Done: {已完成工作}
- In progress: {任务停在哪一步}
- Not started: {剩余工作}

## Key References

- Plan: `.agent/plans/...`
- Context manifest: `.agent/plans/context-manifest.json`
- Source files: `src/...`
- Tests: `tests/...`
- Docs: `docs/...`

## Open Questions

- {下一个 Agent 必须回答或向用户确认的问题。}

## Engineering Constraints

- 不复制已有 PRD、plan、ADR、issue、commit 或 diff 内容；只用路径或 URL 引用。
- mock 与 real API 任一侧变化时，必须保持契约同步。
- 新增或修改 public contract 时，必须同步接口或 API 文档。
- 不修改任务边界外文件；如必须修改，需在此记录原因。

## Verification State

- Commands already run: `{command}` -> {result}
- Commands still needed: `{command}`
- Known failures: {failure or "none"}

## Next Steps

1. {第一个具体步骤}
2. {第二个具体步骤}
3. {第三个具体步骤}

## Resume Prompt

Read this handoff and the referenced files, verify the repository state, then continue from "Next Steps". Do not redo completed work. If the handoff and code disagree, report the mismatch before changing files.
```

## JSON Payload 模板

```json
{
  "handoff_id": "H-YYYYMMDD-HHMMSS-focus",
  "mode": "AGENT_RESUME",
  "from": {
    "agent_id": "implementer-001",
    "model": "claude-sonnet",
    "session_id": null
  },
  "to": {
    "role": "implementer",
    "model_pref": ["codex", "claude-sonnet"],
    "required_capabilities": ["code_generation", "test_writing"]
  },
  "task_id": "T-xxx",
  "mission_id": null,
  "task_progress": {
    "current_step": "step-3",
    "completed_steps": ["step-1", "step-2"],
    "in_progress": "short description of stopped work",
    "remaining_steps": ["step-3", "step-4"]
  },
  "artifacts": {
    "completed": [".agent/artifacts/T-xxx/001-plan.json"],
    "context_snapshot_ref": ".agent/artifacts/T-xxx/state.json",
    "markdown_ref": ".agent/handoffs/YYYYMMDD-HHMMSS-focus.md",
    "artifact_refs": []
  },
  "next_action": "First concrete action for the next agent.",
  "constraints": ["Do not modify files outside the task boundary."],
  "verification": {
    "commands_run": [
      {
        "command": "node .agent/skills/knowledge-lint/scripts/index.js",
        "exit_code": 0,
        "summary": "passed"
      }
    ],
    "commands_needed": ["run task-specific tests"],
    "known_failures": []
  },
  "graphify_context": null,
  "context_budget_hint": 12000,
  "produced_at": "2026-06-12T00:00:00.000Z"
}
```

## 规则

- 优先使用路径、commit hash、issue 链接和命令名，不复制大段内容。
- 保持交接文档简洁；如果文档变长，用引用替代叙述。
- 在 `Open Questions` 中显式记录不确定性，不要藏在摘要里。
- 即使没有运行检查，也必须记录验证状态。
- 所有接手 Agent 使用同一个通用模板。如确实需要目标环境说明，只在 `Engineering Constraints` 中添加一条短说明。
- JSON handoff payload 必须符合 `.agent/handoffs/handoff.schema.json` 语义并通过验证后再发布。
- `graphify_context` 是可选字段，可以为 `null`；只有存在知识图谱子图 artifact 时才使用。
