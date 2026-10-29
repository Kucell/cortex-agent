---
title: "Core Principles"
description: "> **Core rule**: every AI assisting in development must follow the baseline conventions below — language settings, architecture first, behavior guardrails, where runtime artifacts are written, and the maintenance boundary between rules, workflows, and skills."
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-28
status: stable
---

# Core Principles

1.  **Adhere to Language Settings**: Always communicate in the language defined in `.agent/rules/language.md`.
2.  **Architecture First**: Always check `.agent/rules/architecture-design.md` before suggesting any code changes.
3.  **Behavior Rules**: Read `.agent/rules/ai-behavior.md` at session start — it governs Git discipline, edit scope, code exploration strategy (including Graphify-first when `graphify-out/graph.json` exists), and staged-commit protocol.
4.  **Runtime Artifact Location**: Anything that must persist across the session — per-run JSON, per-sample observations, debug logs, scratch JSON, probe scripts — goes under `.agent/`, per `.agent/rules/runtime-artifacts-location.md`. **Never** write to `/tmp`, the home directory, or the project root: those are reclaimed with the session and the artifact is lost.
5.  **Memory Index**: At session start the SessionStart hook auto-loads `.agent/memory/MEMORY.md` (≤200 lines / 25KB cap); read topic files (`{user,feedback,project,reference}/*.md`) on demand. See `.agent/rules/memory-protocol.md` for details.
6.  **Proposal Structure**: Read `.agent/rules/proposal-structure.md` before creating or reorganizing architecture proposals, especially for large projects or related-project proposal groups.
7.  **Follow Workflows**: When a user runs a command (e.g., `/start-task`), strictly follow the corresponding workflow defined in `.agent/workflows/`.
8.  **Skills First**: For specialized tasks (e.g., architecture audits), prefer using the skills defined in `.agent/skills/`.
9.  **Plan-Driven**: All tasks should be guided by the plans in `.agent/plans/`.
10.  **Explicit Maintenance**: When adding instructions that are general-purpose, prefer storing them in the global configuration `~/.agent/`; when involving project-specific business or private logic, they must be stored in the local `.agent/` directory. Use `/agent-update` to maintain these configurations.
11. **Single Source Boundary**: `.agent/` is the only maintained Cortex Agent source. External compatibility folders such as `.agents/skills/source-command-*` are generated adapters and must not be edited as rules, workflows, or skills.
12. **Adapter Truth-Source Regression**: The `## Compatibility Adapter Bootstrap` managed block in `AGENTS.md` states: after the host uses `.agents/skills/source-command-<command>` to identify a command, **before any task action** it must load `.agent/workflows/<command>.md`. If that truth workflow is missing, report the adapter-vs-truth mismatch and stop; do not silently fall back to the adapter copy.
