---
name: handoff
description: Create or resume a compact task handoff document for transferring work between agents, sessions, or sub-agents.
---

# Handoff Workflow (/handoff)

Use `/handoff` when a task should continue in another agent, another session, or an isolated sub-agent context.

## Usage

```text
/handoff create "short task focus"
/handoff resume .agent/handoffs/YYYYMMDD-HHMMSS-short-task-focus.md
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
5. Reference existing artifacts by path or URL instead of copying their contents.
6. End with a `Resume Prompt` that the next agent can follow directly.

## RESUME

1. Read `AGENTS.md` and required `.agent/rules/` files.
2. Read the requested handoff document.
3. Check `git status --short` before changing files.
4. Read the referenced plans, source files, tests, and docs.
5. Compare the handoff with current repository state.
6. Continue from `Next Steps`, or report conflicts if the handoff is stale.

## Quality Bar

- The handoff must be useful without access to the previous conversation.
- It must be small enough to paste into a new agent context if needed.
- It must preserve decisions, constraints, verification state, and next actions.
- It must avoid duplicating plans, PRDs, commits, diffs, ADRs, and API docs.

