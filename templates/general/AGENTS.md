# AGENTS.md — Project Entry (general mode)

This project is managed by [cortex-agent](https://github.com/Kucell/cortex-agent) in **general mode**.

The `.agent/` directory (gitignored) is the single source of truth for agent
workflows, skills, and long-term memory. This file is the documented entry
point — read it first.

Global Cortex Agent memory lives in `~/.agent/`; project memory lives in this
project's `.agent/`. When switching agent hosts, use the project memory index
instead of relying on host-private memory alone.

## Load order

When you start a session in this project, load in this order:

1. `.agent/general/config/general-config.yaml` — mode + memory + agent settings
2. `.agent/general/prompts/` — system prompt templates for general mode
3. `.agent/general/workflows/` — available workflows:
   - `/memory recall` — recall distilled memory
   - `/memory distill` — distill current session into memory
   - `/agent discover` — discover registered agents
   - `/agent invoke` — invoke a registered agent
4. `.agent/general/skills/` — capability implementations backing the workflows
5. `.agent/general/sub-agents/` — long-running sub-agents (e.g. `memory-curator`)
6. `.agent/general/domains/` — scenario-specific configuration

## Data layer (shared, 11 directories)

`.agent/` also holds the shared data layer used at runtime:

- `conversations/` — long-term conversation archive (cross-agent continuity)
- `memory/{episodic,semantic}/` — distilled cross-session memory
- `agents/` — project-level agent registry
- `inbox/` · `decisions/` · `waitpoints/` · `runs/` · `sessions/`
- `missions/` · `handoffs/` · `tasks/`

## Working in this project

- If a workflow exists for your task, use it — do not invent a new script.
- Stable project knowledge (docs, notes, proposals) lives in the repo itself
  (e.g. `docs/`, `README.md`), **not** in `.agent/` (which is runtime data).
- For project-specific config, project files are the truth — `.agent/` is a
  hint, not live state. Always verify against current files before acting.
- To refresh the cross-tool anchor, run `cortex-agent export-anchor`.

## Cross-tool recognition

This project exports `docs/cortex-agent/anchor.md` (version-controlled) so any
AI tool can recognise it as cortex-agent-managed. Paste the anchor snippet into
your tool's long-term memory:

- Claude Code → `CLAUDE.md`
- Codex / Cursor → `AGENTS.md` (append below this file)
- Pi agent → `.pi/agent.md` or system prompt

---

_Edit this file to describe your project's context, conventions, and any
project-specific guidance agents should follow._
