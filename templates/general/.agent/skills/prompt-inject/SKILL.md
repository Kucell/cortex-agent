---
name: prompt-inject
description: Assemble the general-mode system prompt from P-006 layered templates (core/domain) plus project memory and conversation summary. Zero dependency; used at session_start / per_turn / on_demand per general-config.yaml.
---

# prompt-inject (P-006 template-side injection)

Hosts (Claude Code / Codex / Cursor) assemble their own system prompt. This skill
provides the cortex-agent-controlled **content layer**: it picks the right P-006
prompt layer (`core` always-on, `domain` on-demand), then appends distilled
memory and the latest conversation summary when present.

> The layer contract is owned by P-006 (§3.1) and the prompt templates under
> `.agent/prompts/`. This script only assembles; it never rewrites Host prompts.

## When to Use

- `session_start` → `--layer core` (identity, mode, principles, routing).
- `per_turn` → `--layer core` (same minimum, no summary).
- `on_demand` → `--layer domain` (long references only when needed).
- Legacy single-prompt equivalent → `--layer all`.

## Command

```bash
node .agent/skills/prompt-inject/scripts/inject.js \
  --lang zh|en --layer core|domain|all \
  [--memory-top-n 5] [--include-summary true|false]
```

Set `CORTEX_PROJECT_ROOT` to target another project (defaults to cwd).

## Output Contract

- Sections joined with `---` separators; always ends with a newline.
- Missing memory / summary dirs are skipped, never fatal.
- Missing core layer fails with exit 2 (template not installed) — fail closed,
  so a host never silently runs without the mandatory identity layer.

## Source of Truth

- Layer design: `.agent/plans/proposals/projects/token-control-plane/proposals/P-006-host-side-context-optimization-proposal.md`
- Prompt templates: `.agent/prompts/system-prompt-{core,domain}.{md,zh.md}`
- Config: `.agent/config/general-config.yaml#system_prompt`
