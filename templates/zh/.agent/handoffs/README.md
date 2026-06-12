# Handoffs

该目录保存人可读的 Markdown 交接文档，以及可选的机器可读 JSON handoff payload。

T-C06 引入双产物协议：

- Markdown handoff：面向人工审阅和轻量复制粘贴。
- JSON handoff：面向 `AGENT_RESUME` 和 Artifact Bus 索引。

## 命令

```bash
node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-001.json
node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-001.json --markdown-path .agent/handoffs/H-001.md --agent-id coordinator
node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file .agent/handoffs/H-001.json
```

`publish` 会先验证 JSON payload，再将其作为 `kind: handoff` 追加到 Artifact Bus。

## 规则

- 不复制源码、diff、plan、PRD、ADR、issue 或长日志。
- 通过路径、URL 或 commit 引用已有产物。
- `task_progress.current_step`、`next_action` 和 `verification` 必须足够具体，让新 agent 不依赖上一轮对话也能恢复。
- 只有在知识图谱子图已存在时才使用 `graphify_context`；否则设为 `null` 或省略。
