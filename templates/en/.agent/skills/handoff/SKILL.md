---
name: handoff
description: Create or resume compact human-readable and machine-readable task handoff artifacts for transferring work between agents, sessions, or sub-agents without copying bulky artifacts.
---

# Handoff Skill

## Purpose

Use this skill when work needs to move from one agent, session, or execution context to another. The handoff must preserve the task state while keeping the next context small and actionable.

T-C06 handoffs use a dual-artifact protocol:

- Markdown is the human-readable handoff.
- JSON is the agent-readable handoff for `AGENT_RESUME`.
- Artifact Bus stores the JSON payload as `kind: handoff` so coordinator can resume without parsing Markdown.

This is for task-level transfer. Long-session time archiving remains the responsibility of `session-manager`.

## Modes

### CREATE

Create a Markdown file under `.agent/handoffs/` named:

```text
YYYYMMDD-HHMMSS-{short-focus}.md
```

Also create a JSON payload beside it:

```text
H-YYYYMMDD-HHMMSS-{short-focus}.json
```

The file must be self-contained enough for a new agent to start, but it must not duplicate content that already exists in plans, PRDs, ADRs, commits, diffs, issue trackers, or API docs. Reference those artifacts by path, commit, or URL instead.

Validate and publish the JSON payload when Artifact Bus exists:

```bash
node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json --markdown-path .agent/handoffs/YYYYMMDD-HHMMSS-focus.md --agent-id coordinator
```

### RESUME

When resuming from a human-readable handoff (`HUMAN_RESUME`):

1. Read `AGENTS.md` and the required `.agent/rules/` files first.
2. Read the handoff document.
3. Read only the files referenced by the handoff unless code search shows the handoff is stale.
4. Compare the handoff with `git status` and the current code before acting.
5. If the handoff conflicts with the repository state, trust the repository state and report the conflict.

### AGENT_RESUME

When resuming from JSON:

1. Read `AGENTS.md` and the required `.agent/rules/` files first.
2. Run `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>`.
3. Read `artifacts.context_snapshot_ref` and any referenced Artifact Bus entries.
4. Acquire required task/file locks before writing when Progress Lock is available.
5. Continue from `task_progress.current_step` and `next_action`.
6. If JSON, Artifact Bus state, and repository state disagree, stop and report `blocked`.

## Handoff Template

```markdown
# Handoff: {task or focus}

## Current Goal

{One sentence describing what the next agent should accomplish.}

## Confirmed Facts

- {Requirements, decisions, constraints, or facts already confirmed.}

## Current Progress

- Done: {completed work}
- In progress: {where the task stopped}
- Not started: {remaining work}

## Key References

- Plan: `.agent/plans/...`
- Context manifest: `.agent/plans/context-manifest.json`
- Source files: `src/...`
- Tests: `tests/...`
- Docs: `docs/...`

## Open Questions

- {Questions the next agent must answer or ask the user about.}

## Engineering Constraints

- Do not duplicate existing PRD, plan, ADR, issue, commit, or diff content; reference it by path or URL.
- Keep mock and real API contracts in sync when either side changes.
- Update interface/API documentation when adding or changing public contracts.
- Do not modify files outside the task boundary unless the reason is recorded here.

## Verification State

- Commands already run: `{command}` -> {result}
- Commands still needed: `{command}`
- Known failures: {failure or "none"}

## Next Steps

1. {First concrete step}
2. {Second concrete step}
3. {Third concrete step}

## Resume Prompt

Read this handoff and the referenced files, verify the repository state, then continue from "Next Steps". Do not redo completed work. If the handoff and code disagree, report the mismatch before changing files.
```

## JSON Payload Template

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

## Rules

- Prefer paths, commit hashes, issue links, and command names over copied content.
- Keep the handoff concise. If it grows large, replace narrative with references.
- Record uncertainty explicitly in `Open Questions`; do not hide it in the summary.
- Include verification state even when no checks have been run.
- Use one generic template for all target agents. If a target-specific note is unavoidable, add it as a short bullet under `Engineering Constraints`.
- JSON handoff payloads must validate with `.agent/handoffs/handoff.schema.json` semantics before publish.
- `graphify_context` is optional and may be `null`; use it only when a subgraph artifact exists.
