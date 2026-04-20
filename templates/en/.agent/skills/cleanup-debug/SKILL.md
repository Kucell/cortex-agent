---
name: cleanup-debug
description: Clean temporary debug artifacts under .agent/debug (screenshots, logs, etc.) with age filters; optional .playwright-mcp cleanup.
---

# Cleanup Debug Skill

## Goal

Prune `.agent/debug/` so repos don’t accumulate screenshots/logs forever. Optional: trim `.playwright-mcp/` if your team uses it.

## Default policy (tune per project)

| Path | Keep | Notes |
|------|------|--------|
| `.agent/debug/screenshots/` | 7d | png/jpg |
| `.agent/debug/logs/` | 3d | `*.log` |
| `.agent/debug/temp/` | 1d | scratch files |
| `.playwright-mcp/` (optional) | 3d | only if present |

## Example commands (Unix)

Preview first, then delete:

```bash
find .agent/debug/screenshots -type f \( -name "*.png" -o -name "*.jpg" \) -mtime +7 -delete 2>/dev/null
find .agent/debug/logs -type f -name "*.log" -mtime +3 -delete 2>/dev/null
find .agent/debug/temp -type f -mtime +1 -delete 2>/dev/null
```

Optional Playwright MCP cache:

```bash
find .playwright-mcp -type f -mtime +3 -delete 2>/dev/null || true
```

Skip the Playwright block if unused.

## Invocation

- User asks to “clean debug artifacts” / `cleanup-debug`: run preview-friendly `find`, then delete per policy or flags (`--all`, `--screenshots`, `--logs`, `--temp`, `--days N`).

## Safety

- Prefer **preview** (`find` without `-delete`) first.
- Deletion is irreversible.

## Language

Follow `.agent/rules/language.md` (English template defaults to English unless the project says otherwise).
