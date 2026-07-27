---
name: uri-resolver
description: Resolve `cortex://` URIs and `.agent/` filesystem paths bidirectionally. Audits `.agent/` markdown for relative references. Inspired by OpenViking's `viking://` protocol. All new `.agent/` documentation should prefer `cortex://` form so cross-project copies don't require path rewrites.
---

# URI Resolver

## Goal

Provide a stable URI for every `.agent/` artifact (rules / workflows / skills / references / memory / decisions / experiences / resources). Paths drift across projects and LLM rewrites; URIs don't.

Inspired by OpenViking's `viking://`, but cortex-agent has no separate runtime — `cortex://` is a doc-layer convention resolved by `resolve.js` on demand.

## URI Format

```
cortex://{scope}/{path...}
```

**Registered scopes** (from `registry/uri-map.json`):

| scope | default root | purpose |
|---|---|---|
| `rules` | `.agent/rules` | governance rules |
| `workflows` | `.agent/workflows` | state-machine workflows |
| `skills` | `.agent/skills` | reusable skills |
| `references` | `.agent/references` | project architecture references |
| `memory` | `.agent/memory` | 4-type note layer |
| `decisions` | `.agent/decisions` | decisions + gate authorization |
| `experiences` | `.agent/experiences` | lessons learned |
| `resources` | `.agent/resources` | external resources (Phase 2) |

## Usage

```bash
# URI → path
node .agent/skills/uri-resolver/scripts/resolve.js --uri "cortex://skills/context-budget"

# path → URI
node .agent/skills/uri-resolver/scripts/resolve.js --path ".agent/skills/context-budget/SKILL.md"

# refresh uri-map.json timestamp + scan scope roots
node .agent/skills/uri-resolver/scripts/resolve.js --rebuild

# audit .agent/ markdown for relative refs (dry-run)
node .agent/skills/uri-resolver/scripts/resolve.js --check
```

## Resolution Rules

- Must start with `cortex://`; scope must be registered in `uri-map.json`
- Auto-completion: `.md` / `.json` / `.yml` / `.yaml`
- Directory references auto-try `SKILL.md` / `README.md`
- Resolution failure returns structured `ok: false` + `suggestion` — **never throws**

## Migration Path

1. **New references**: use `cortex://...` directly
2. **Existing references**: keep as-is; run `./resolve.js --check` for a dry-run report
3. **Batch migration**: review then replace; relative paths remain supported

## Boundaries

- **No** runtime injection (OpenViking runs viking:// through a server; cortex-agent is a prompt-layer framework)
- **Does not replace** relative paths — small in-scope references still work
- **Does not copy** content — URIs only point; archives still use the file
- **No** LLM dependency — pure deterministic resolution
