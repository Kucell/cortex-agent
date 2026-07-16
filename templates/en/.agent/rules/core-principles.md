# Core Principles

1.  **Adhere to Language Settings**: Always communicate in the language defined in `.agent/rules/language.md`.
2.  **Architecture First**: Always check `.agent/rules/architecture-design.md` before suggesting any code changes.
3.  **Behavior Rules**: Read `.agent/rules/ai-behavior.md` at session start — it governs Git discipline, edit scope, code exploration strategy (including Graphify-first when `graphify-out/graph.json` exists), and staged-commit protocol.
4.  **Follow Workflows**: When a user runs a command (e.g., `/start-task`), strictly follow the corresponding workflow defined in `.agent/workflows/`.
5.  **Skills First**: For specialized tasks (e.g., architecture audits), prefer using the skills defined in `.agent/skills/`.
6.  **Plan-Driven**: All tasks should be guided by the plans in `.agent/plans/`.
7.  **Explicit Maintenance**: When adding instructions that are general-purpose, prefer storing them in the global configuration `~/.agent/`; when involving project-specific business or private logic, they must be stored in the local `.agent/` directory. Use `/agent-update` to maintain these configurations.
8.  **Single Source Boundary**: `.agent/` is the only maintained Cortex Agent source. External compatibility folders such as `.agents/skills/source-command-*` are generated adapters and must not be edited as rules, workflows, or skills.
