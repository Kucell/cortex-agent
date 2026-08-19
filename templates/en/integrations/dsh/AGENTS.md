# Cortex Agent Entry for DSH (DeepSeek Harness)

This project uses `.agent/` as the single source of truth for agent rules, workflows, skills, and project knowledge.

Please load and follow these first:

1. `AGENTS.md` (project root)
2. `.agent/rules/core-principles.md`
3. `.agent/rules/ai-behavior.md`
4. `.agent/rules/code-standards.md`
5. `.agent/workflows/`

When switching between agent hosts, use `.agent/memory/MEMORY.md` as the shared project memory index; host-private memory is only a cache — see `.agent/rules/memory-protocol.md` for write and dedupe rules.

Keep project-specific facts in `.agent/references/` and `.agent/rules/tech-stack.md`.
If legacy content was imported, review `.agent/imported_rules/` and migrate useful parts.

If there is any conflict, `.agent/` content takes precedence.

> DSH is a first-class dispatch adapter for Cortex Agent (on par with Pi / Claude Code / Codex CLI).
> See `.dsh/README.md` for install/usage; see `cortex-agent agent adapter discover dsh` for capability boundaries.
