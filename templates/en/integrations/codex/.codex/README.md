# Cortex Agent + OpenAI Codex

This folder is created by `cortex-agent add codex` (or selected during `init`).

## What you get

- **`config.toml`** — project-level Codex settings (merged with `~/.codex/config.toml`).
- **`prompts/`** — symlink to `.agent/workflows/`. Each Markdown file is one SOP; Codex does not register them as `/slash` commands like Cursor. Use **`/mention path/to/file.md`** (or attach the file) and ask Codex to follow that workflow.
- **Root `AGENTS.md`** — created by Cortex `init` / `upgrade`; Codex loads it automatically. It should keep pointing at `.agent/rules/` and `.agent/workflows/`.
- **Cross-host memory** — Codex host memory is only a cache. Shared project memory is read from and written to `.agent/memory/`, using `MEMORY.md` as its index and `memory-protocol.md` as its protocol so another agent host can resume.

## References

- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Slash commands in Codex CLI](https://developers.openai.com/codex/cli/slash-commands)
