---
name: handoff
description: Create or resume a compact, tool-agnostic task handoff document for transferring work between agents, sessions, or sub-agents without copying bulky artifacts.
---

# Handoff Skill

## Purpose

Use this skill when work needs to move from one agent, session, or execution context to another. The handoff must preserve the task state while keeping the next context small and actionable.

This is for task-level transfer. Long-session time archiving remains the responsibility of `session-manager`.

## Modes

### CREATE

Create a Markdown file under `.agent/handoffs/` named:

```text
YYYYMMDD-HHMMSS-{short-focus}.md
```

The file must be self-contained enough for a new agent to start, but it must not duplicate content that already exists in plans, PRDs, ADRs, commits, diffs, issue trackers, or API docs. Reference those artifacts by path, commit, or URL instead.

### RESUME

When resuming from a handoff:

1. Read `AGENTS.md` and the required `.agent/rules/` files first.
2. Read the handoff document.
3. Read only the files referenced by the handoff unless code search shows the handoff is stale.
4. Compare the handoff with `git status` and the current code before acting.
5. If the handoff conflicts with the repository state, trust the repository state and report the conflict.

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

## Rules

- Prefer paths, commit hashes, issue links, and command names over copied content.
- Keep the handoff concise. If it grows large, replace narrative with references.
- Record uncertainty explicitly in `Open Questions`; do not hide it in the summary.
- Include verification state even when no checks have been run.
- Use one generic template for all target agents. If a target-specific note is unavoidable, add it as a short bullet under `Engineering Constraints`.

