---
name: resource-ingest
description: External resource ingestion (inspired by OpenViking's `client.add_resource`). Pull URL / file / git repo into `.agent/resources/external/`, auto-generate L0/L1, register in context-index.json + uri-map.json + MANIFEST.json. Zero LLM dependency.
area: swe
summary: External resource ingestion (inspired by OpenViking's `client.add_resource`). Pull URL / file / git repo into `.agent/resources/external/`, auto-generate L0/L1, register in context-index.json + uri-ma
---

# Resource Ingest

## Goal

Adapt OpenViking's auto-`add_resource` to cortex-agent: external knowledge (API docs, RFCs, vendor READMEs) is no longer hand-pasted. Each resource gets a deterministic source + slug path, automatic L0/L1, and a manifest entry.

## Three Entry Points

```bash
# 1) URL — fetch HTML, strip, markdown
node .agent/skills/resource-ingest/scripts/ingest.js \
  --url https://example.com/api-docs \
  --source example --slug api-docs --write

# 2) Local file — copy
node .agent/skills/resource-ingest/scripts/ingest.js \
  --file ./external-doc.md \
  --source vendor-x --slug doc --write

# 3) git repo — requires pre-clone into .agent/resources/_cache/{source}_{slug}/
git clone --depth 1 https://github.com/foo/bar .agent/resources/_cache/foo_bar
node .agent/skills/resource-ingest/scripts/ingest.js \
  --git https://github.com/foo/bar \
  --source github --slug foo-bar --write
```

## Layout

```text
.agent/resources/
├── MANIFEST.json                         # append-only ingest log
├── external/
│   └── {source}/
│       └── {slug}.md                     # one file per resource
└── _cache/
    └── {source}_{slug}/                  # git clone cache (rebuildable)
```

Each resource file contains:

```yaml
---
name: api-docs
source: example
uri: cortex://resources/example/api-docs
content_hash: db91b93ab1bb13aa           # SHA-256 first 16 chars
ingested_at: 2026-07-24T05:42:11.952Z
origin: https://example.com/api-docs
---
# ... content ...
```

## Side Effects

Each `--write` does four things:

1. Writes the resource file into `.agent/resources/external/{source}/{slug}.md`.
2. Appends an entry to `MANIFEST.json` (ingested_at / content_hash / bytes).
3. Refreshes `uri-map.json` timestamp for the `resources` scope.
4. Adds a module entry to `context-index.json` (with `uri` / `ref_path`).

With `--refresh-l0l1`, also runs `build-l0l1.js --file {target} --inject-index` to generate L0/L1 for the new resource.

## Acceptance

- `MANIFEST.json` gains one entry per ingest.
- `context-index.json` total modules = previous + new.
- `uri-resolver --uri "cortex://resources/example/api-docs"` resolves to `.agent/resources/external/example/api-docs.md`.
- 100% of resources have L0/L1 after `build-l0l1.js --all`.

## Boundaries

- **No deep crawling** (v1: entry page / README only).
- **No copyright check** (user's responsibility).
- **No auto-update** (manual `--write` overwrites).
- **No auto-clone** (git clone is user's responsibility).
- **Does not replace `references/`** — references/ is project-internal architecture; resources/ is external.

## Related

- Depends on: `build-l0l1.js` (L0/L1), `uri-resolver` (URI), `context-budget` (retrieval).
- Storage: `resources/MANIFEST.json` cleaned up by `cleanup-debug`.
- Read by: `skill-selector` and `context-budget` (Tier 2 candidates).
- Audited by: `uri-resolver --check`.
