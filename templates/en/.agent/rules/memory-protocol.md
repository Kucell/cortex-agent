# Memory Protocol Rules

> This rule defines the write/read/expiry/archive protocol for the 4 memory types (user / feedback / project / reference) under `.agent/memory/`.
> Companion mechanisms: `templates/{zh,en}/.agent/memory/` (mechanism) + `templates/{zh,en}/.agent/hooks/hooks.json` (auto-load) + this rule (behavior constraints).

## 1. Scope

Applies only to topic files (`.agent/memory/{user,feedback,project,reference}/*.md`) and the `MEMORY.md` index. **Does not apply** to:

- `.agent/experiences/EXP-*.md` (commit-anchored lessons)
- `.agent/decisions/D-*.json` (gate authorization)
- `.agent/references/*.md` (full architecture docs)
- `.agent/context-index.json` (module routing metadata)
- session-continuity skill's `~/.agent/contexts/<project>/ctx_*.md` (session short-term archive)

## 2. Four-Type Definition

| type | meaning | per-project cap | expiry strategy | primary writer |
|---|---|---|---|---|
| `user` | user preferences, work style | ≤10 entries/project | permanent | user manually / `/configure` |
| `feedback` | lightweight session observations | ≤30 entries/project | auto-archive to `feedback/_archive/` after 90 days | `agent-update` Step 4.5 |
| `project` | project-level fact notes | ≤20 entries/project | permanent | `/plan` `/ship` `/mission` DONE stage |
| `reference` | pointers to existing `.agent/` content | ≤50 entries/project | permanent | `/update-refs` Step 7 |

## 3. Required Frontmatter

Each topic file **must** include YAML frontmatter; field definitions in `memory.schema.json`:

- `name` (slug, matches `^[a-z0-9-]+$`)
- `description` (≤200 chars, trigger keywords placed here)
- `type` (one of 4)
- `created` (ISO 8601 date)
- `tags` (1-10 slug keywords, for future memory-recall)

Optional: `expires` (required for feedback, optional for others), `source`, `related`.

## 4. MEMORY.md Index Convention

- SessionStart hook auto-loads `MEMORY.md` (**index only**, not topic files)
- 200 lines / 25KB dual cap (aligned with Claude Code official Auto Memory)
- Index groups by 4 types; each line format: `- [Title](<type>/<file>.md) — trigger/keyword`
- Each group's first line shows `(<current>/<cap>)`; when approaching the cap, the agent should auto-archive old entries

## 5. Write Triggers

| Trigger | Write Path |
|---|---|
| User says "remember my preference X" | user manually Writes to `user/` |
| Agent observes repeated pattern in a session | `agent-update` Step 4.5 → `feedback/` |
| `/plan` `/ship` `/mission` completed | workflow DONE stage checks "any reusable project facts?" → `project/` |
| `/update-refs` adds/updates references | Step 7 → leave pointer in `reference/` (no content duplication) |

## 6. Explicit Boundaries (Non-Goals)

Things this mechanism **does NOT do** (explicit response to P-006's anti-MEMORY stance):

1. **Does not replace** `.agent/decisions/` (gate authorization)
2. **Does not replace** `.agent/state/` and checkpoint
3. **Does not replace** `.agent/handoffs/`
4. **Does not implement** "unbounded growth of facts/skills/rules/replayable history" — every type has a hard cap
5. **Does not replace** `.agent/docs/` `.agent/rules/`
6. **Does NOT** auto-load topic files (use cap + on-demand Read instead)
7. **Does NOT** implement cross-project memory sync
8. **Does NOT** store personal privacy or credentials (feedback/project strictly prohibit tokens, passwords, internal URLs)

memory is **lightweight notes for Agent recall**, not "long-term archival".

## 7. Capacity and Staleness Control (implementation-level constraints, aligned with Claude Code Auto Memory)

| Constraint | Value | Source |
|---|---|---|
| Per topic file size cap | **102400 bytes** (100 KB) | Claude Code binary internal constant |
| MEMORY.md startup load | 200 lines / 25 KB dual cap | Claude Code Auto Memory public docs |
| `name` slug charset | `^[a-z0-9_-]+$` (underscores allowed) | Claude Code binary internal constant |
| Path segments | ≤20 segments | Claude Code binary internal constant |
| Path bytes | ≤1024 bytes | Claude Code binary internal constant |

## 8. Staleness Risk

**Memory may become stale or conflict with real state** — Claude Code's internal prompt explicitly warns:

> "verify files/functions/flags before recommending because memory can be stale"

Operational rules:
- When the user states "project uses X" / "project doesn't use Y" conflicting with `memory/project/*.md`, **verify first** (`ls`, `cat package.json`, etc.) before adopting
- `memory/user/*.md` preferences have **lower priority than the user's current prompt** (user can override at any time)
- `memory/feedback/*.md` is **auto-down-weighted** after `expires` (Phase 2 skill implementation)
- Major changes (project migration, user work-style shift) should **manually delete** the corresponding memory file, not update it entry by entry

## 9. Implementation Compatibility (parity with Claude Code)

This design is informed by Claude Code v2.1.216 binary internal prompt strings (extracted via `strings` from `/Users/xueyq/.local/bin/claude`), compatible with the official Auto Memory fields (`name` / `description` / `metadata`):

- `metadata` field is optional (cortex-agent's top-level `type` remains canonical)
- slug regex includes underscores (aligned with Claude Code)
- Per-file 100 KB cap (prevents memory files from becoming a performance bottleneck)

**Note**: Claude Code behavior may evolve across versions; this design is aligned only based on v2.1.216 implementation-level evidence — not a public API contract commitment.
