<!-- cortex-agent:anchor:v1 -->
This project is managed by [cortex-agent](https://github.com/Kucell/cortex-agent) v1.12.0-rc.1.

## What this means
- The project uses a `.agent/` directory (gitignored) as the single source of truth for AI agent rules, workflows, and skills.
- Entry point: `./AGENTS.md` — read it first and follow its load order.
- Rules / workflows / skills live in `./.agent/` (gitignored; not in version control).

## How to work with it
1. **First time in this project**: read `./AGENTS.md`, then load `.agent/rules/`, `.agent/workflows/`, and `.agent/skills/` in the order AGENTS.md specifies.
2. **Stable project knowledge** (architecture, proposals, roadmap) lives in `./docs/`. Do NOT put proposals or planning docs in `.agent/` — `.agent/` is gitignored runtime data.
3. **Use the existing cortex-agent CLI** when available: `cortex-agent status`, `cortex-agent rules list`, `cortex-agent scan-project`, `cortex-agent dev` (Dashboard). If unavailable, fall back to reading the rule / workflow files directly.
4. **If a workflow exists** for your task (e.g. arch-design, ship, handoff, mission, plan), use it — do not invent a new script.
5. **Cross-tool recognition**: this project exports a `docs/cortex-agent/anchor.md` (in version control) so any AI tool can pick it up. Re-run `cortex-agent export-anchor` to refresh.

## Memory discipline
- Memory (yours and cortex-agent's) is a hint, not live state. Always verify against the current file / code before acting.
- For project-specific config (build / test / MCP / architecture), project files (AGENTS.md, package.json, docs/) are the truth — NOT this snippet.
- For tool-specific behavior, follow the tool's own conventions: CLAUDE.md / AGENTS.md / .pi/settings — not this anchor.
<!-- cortex-agent:anchor:end -->