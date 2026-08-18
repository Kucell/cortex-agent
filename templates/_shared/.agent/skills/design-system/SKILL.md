---
name: design-system
description: |
  Read and respect the active DESIGN.md before generating any UI / frontend
  code / dashboard / design artifact. Use the 4-level cascade exposed by
  `cortex-agent design resolved` to find the right spec.

  Use proactively when: generating UI code, dashboards, prototypes,
  prototypes that touch color/typography/spacing, brand-aligned assets, or
  any visual output.

  Don't use when: pure backend / data / logic work with no visual surface.
area: swe
summary: |
---

# Design System

## Goal

Make sure every AI agent (Claude Code / Codex / Cursor / etc.) in a
cortex-agent project respects the project's active visual specification
when producing any UI, frontend, dashboard, prototype, or design asset.

The active specification is read from a **4-level cascade** (see below).
Without this skill, agents fall back to generic defaults that ignore
brand identity, accessibility, and project-specific anti-patterns.

## When to use

Invoke this skill **before** any of:

- Writing or modifying UI / frontend code (React, Vue, Svelte, HTML/CSS, …)
- Generating dashboards, prototypes, or design artifacts
- Suggesting colors, fonts, spacing, motion, or component styles
- Refactoring existing UI to a new brand spec

## The 4-level cascade

`cortex-agent design resolved` prints the cascade (highest priority first):

```
1. <project_root>/DESIGN.md                       ← user override
2. <project_root>/.agent/DESIGN.md                ← agent context
3. <project_root>/.agent/design-systems/<id>/DESIGN.md  ← installed (LIFO)
4. templates/{zh,en}/.agent/DESIGN.md             ← cortex-agent starter
```

The **first** layer is the effective spec. Read it before generating output.

## How to use

1. Run `cortex-agent design resolved` (or read `<cwd>/DESIGN.md` directly).
2. Identify the effective spec and its sections (Visual theme / Color roles /
   Typography / Layout / Components / Motion / Accessibility / Anti-patterns).
3. **Cite** the section name when justifying visual choices
   ("color `var(--accent)` per Color roles section", not "I think this looks good").
4. Avoid every entry in the **Anti-patterns** section.
5. If a value isn't in the spec, **ask the user** or fall back to the
   downstream layer — never invent tokens.

## Output expectations

- Colors / fonts / spacing in code must be **traceable** to a section in
  the effective spec.
- No new visual tokens are introduced that aren't declared in the spec.
- Anti-patterns are respected without exception.
- If the spec is missing or stale, surface that to the user and ask
  whether to update the spec first.

## Common pitfalls

- **Don't skip the cascade check.** Skipping and inferring from context
  produces off-brand output. Always read the effective spec first.
- **Don't invent tokens.** If the spec doesn't define a primary color,
  don't pick one. Surface the gap and ask.
- **Don't ignore anti-patterns.** They're there because past decisions
  went wrong. The anti-patterns list is a hard guardrail.
- **Don't use the cascade the wrong way.** Lower layers (4) are
  **fallbacks** for the absence of higher layers (1-3), not overrides.

## Installing additional design systems

If the project's installed systems don't match the brand you need, install
more:

```bash
cortex-agent design list --available
cortex-agent design install <id>        # prompts for license ack
cortex-agent design resolved            # confirm cascade
```

Always run `cortex-agent design resolved` after install to verify the
cascade is what you expect.

## References

- T-OD-001 architecture: `docs/architecture/design-system.md`
- Upstream: https://github.com/nexu-io/open-design
- Catalog: https://open-design.ai/zh/plugins/systems/
- Cascade: 4 levels (project root → .agent → install LIFO → starter)
- License: Apache-2.0 main repo, per-system license in `manifest.json`
