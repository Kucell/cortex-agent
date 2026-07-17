---
name: handoff
description: Create or resume compact Markdown and JSON task handoff artifacts for transferring work between agents, sessions, or sub-agents.
---

# Handoff Workflow (/handoff)

Use `/handoff` when a task should continue in another agent, another session, or an isolated sub-agent context.

T-C06 handoff output is dual-format:

- Markdown for `HUMAN_RESUME`.
- JSON for `AGENT_RESUME`.
- Artifact Bus entry (`kind: handoff`) for coordinator indexing when `.agent/artifacts/scripts/artifact-bus.js` exists.

## Usage

```text
/handoff create "short task focus"
/handoff resume .agent/handoffs/YYYYMMDD-HHMMSS-short-task-focus.md
/handoff resume .agent/handoffs/H-YYYYMMDD-HHMMSS-short-task-focus.json
```

## CREATE

1. Read the current task source:
   - `AGENTS.md`
   - `.agent/rules/core-principles.md`
   - `.agent/rules/code-standards.md`
   - `.agent/plans/task-progress.md` when it exists
   - `.agent/plans/context-manifest.json` when it exists
2. Inspect repository state:
   - `git status --short`
   - current branch
   - relevant changed files
3. Create `.agent/handoffs/` if it does not exist.
4. Write a compact Markdown handoff using the `handoff` skill template.
5. Write the matching JSON payload using `.agent/handoffs/handoff.schema.json` semantics.
6. Reference existing artifacts by path or URL instead of copying their contents.
7. Validate the JSON payload:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
   ```
8. When Artifact Bus exists, publish the JSON payload:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json --markdown-path .agent/handoffs/YYYYMMDD-HHMMSS-focus.md --agent-id coordinator
   ```
9. End the Markdown with a `Resume Prompt` that the next agent can follow directly.
10. If Management API exists, append a `handoff_created` Run event for the active task:
    ```bash
    node .agent/skills/management-api/scripts/index.js runs checkpoint \
      --run-id R-<task-id> \
      --status running \
      --phase handoff \
      --type handoff_created \
      --message "Handoff artifact created"
    ```

## RESUME

1. Read `AGENTS.md` and required `.agent/rules/` files.
2. If the input is Markdown, read the requested handoff document.
3. If the input is JSON, run:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>
   ```
4. Check `git status --short` before changing files.
5. Read the referenced plans, Artifact Bus state, source files, tests, and docs.
6. Compare the handoff with current repository state.
7. For writable continuation, acquire required Progress Lock scopes when available.
8. Continue from `Next Steps` or `next_action`, or report conflicts if the handoff is stale.
9. If Management API exists, update Run journal with `status=running`, `phase=handoff`, and a `state_changed` event before writable continuation.

## Quality Bar

- The handoff must be useful without access to the previous conversation.
- It must be small enough to paste into a new agent context if needed.
- It must preserve decisions, constraints, verification state, and next actions.
- It must avoid duplicating plans, PRDs, commits, diffs, ADRs, and API docs.
- JSON handoff payloads must be valid before publish.
- Artifact Bus publish is skipped only when the bus is not installed or the task deliberately stays human-only.

## Session Transition

- After publishing a handoff, pause the source owner session with `sessions pause --session-id <id> --gate handoff --activity "Handoff published"`.
- On resume, the target opens its own session or heartbeats an existing owner-matched session; it must not refresh the source owner heartbeat.
- Session transition evidence must reference the handoff and active Run; stale remains a read-time derived status.
