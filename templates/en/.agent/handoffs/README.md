# Handoffs

This directory stores human-readable Markdown handoffs and optional machine-readable JSON handoff payloads.

T-C06 introduces the dual-artifact protocol:

- Markdown handoff: optimized for human review and compact copy/paste.
- JSON handoff: optimized for `AGENT_RESUME` and Artifact Bus indexing.

## Commands

```bash
node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-001.json
node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-001.json --markdown-path .agent/handoffs/H-001.md --agent-id coordinator
node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file .agent/handoffs/H-001.json
```

`publish` validates the JSON payload, then appends it to Artifact Bus as `kind: handoff`.

## Rules

- Do not duplicate source, diffs, plans, PRDs, ADRs, issues, or long logs.
- Reference existing artifacts by path, URL, or commit.
- Keep `task_progress.current_step`, `next_action`, and `verification` concrete enough for a new agent to resume without previous conversation context.
- Use `graphify_context` only when a knowledge-graph subgraph exists; otherwise set it to `null` or omit it.
