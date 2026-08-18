---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. Inspired by Andrej Karpathy's observations on LLM coding pitfalls. Use whenever the coding agent is writing, reviewing, or refactoring code.
license: MIT
source:
  repo: multica-ai/andrej-karpathy-skills
  ref: main
  file: CLAUDE.md
  synced_from: 2026-08-11
area: swe
summary: Behavioral guidelines to reduce common LLM coding mistakes — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. Inspired by Andrej Karpathy's observations on LLM coding pi
---

# Karpathy-Inspired Coding Behavior Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make them pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Cortex-Agent Integration Notes

- This vendor skill ships via `templates/_shared/.agent/global-shared-skills/`. On project init, it lands under `<project>/.agent/global-shared-skills/karpathy-guidelines/` and is symlinked into the project's `.agent/skills/` by the `sync-global` skill.
- For L1 framework-level enforcement (rules every project must follow), see `.agent/rules/llm-coding-behavior.md` in the state repo.
- Project-level overrides can be added in `.agents/rules/karpathy.md` to narrow scope for specific codebases.
- For trivial tasks (typo fixes, one-liner renames), apply judgment — not every change needs the full rigor.
