# Cortex Agent Memory Mechanism

> This directory is the standard layout for `.agent/memory/` in the cortex-agent framework. The mechanism is defined in `templates/{zh,en}/.agent/memory/`, actual data is held by each project's L2 instance.

## What This Is

`memory/` is a **lightweight note layer** for the Agent, used to retain "facts to be recalled" across sessions. It is **not** a place for facts/skills/rules/replayable history (those belong to `decisions/`, `experiences/`, `references/`).

## Four Memory Types

| type | meaning | per-project cap | expiry |
|---|---|---|---|
| `user/` | user preferences, work style | 10 entries | permanent |
| `feedback/` | lightweight observations from sessions | 30 entries | auto-archive to `feedback/_archive/` after 90 days |
| `project/` | project-level fact notes | 20 entries | permanent |
| `reference/` | pointers to existing content (does not duplicate `.agent/references/`) | 50 entries | permanent |

## File Layout

```
.agent/memory/
├── MEMORY.md          # index (auto-loaded by SessionStart; ≤200 lines / 25KB cap)
├── memory.schema.json # JSON schema for topic file frontmatter
├── user/              # type=user
├── feedback/          # type=feedback
├── project/           # type=project
└── reference/         # type=reference
```

## Write Conventions

- Each topic file **must** contain YAML frontmatter (`name` / `description` / `type` / `created` / `tags`)
- `MEMORY.md` index groups by 4 types; each line format: `- [Title](<type>/<file>.md) — trigger/keyword`
- When over the cap, **auto-archive** (not an error; agent decides)
- Detailed rules: see `.agent/rules/memory-protocol.md`

## Boundary with Existing Systems

- **Does not replace** `.agent/experiences/` (commit-anchored lessons + relapse prevention)
- **Does not replace** `.agent/decisions/` (schema-enforced gate authorization)
- **Does not replace** `.agent/references/` (full architecture docs)
- **Does not replace** `.agent/context-index.json` (module routing metadata)
- **Does not replace** the session-continuity skill (session short-term archive)

memory is "notes for recall", not "long-term archival".
