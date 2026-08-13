# Cortex Agent Entry for Claude Code

This project uses `.agent/` as the single source of truth for agent rules,
workflows, skills, and project knowledge.

Please load and follow these first:

1. `AGENTS.md`
2. `.agent/rules/core-principles.md`
3. `.agent/rules/ai-behavior.md`
4. `.agent/rules/code-standards.md`
5. `.agent/workflows/`

When switching agent hosts, use `.agent/memory/MEMORY.md` as the shared project-memory index. Host-private memory is only a cache; follow `.agent/rules/memory-protocol.md` for writes and deduplication.

Keep project-specific facts in `.agent/references/` and `.agent/rules/tech-stack.md`.
If legacy content was imported, review `.agent/imported_rules/` and migrate useful parts.

If there is any conflict, `.agent/` content takes precedence.
