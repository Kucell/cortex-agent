# Core Principles

1.  **Adhere to Language Settings**: Always communicate in the language defined in `.agent/rules/language.md`.
2.  **Architecture First**: Always check `.agent/rules/architecture-design.md` before suggesting any code changes.
3.  **Follow Workflows**: When a user runs a command (e.g., `/start-task`), strictly follow the corresponding workflow defined in `.agent/workflows/`.
4.  **Skills First**: For specialized tasks (e.g., architecture audits), prefer using the skills defined in `.agent/skills/`.
5.  **Plan-Driven**: All tasks should be guided by the plans in `.agent/plans/`.