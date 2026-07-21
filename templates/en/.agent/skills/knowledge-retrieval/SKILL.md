---
name: knowledge-retrieval
description: Cross-store hybrid lexical retrieval, bidirectional [[wikilink]] backlinks, and rename-tracking over the .agent/ knowledge bases. Zero dependency. Use to find relevant knowledge across memory/experiences/references/decisions, discover who links to a note, or safely rewrite links after renaming a note.
---

# Knowledge Retrieval Skill

Zero-dependency knowledge retrieval for the `.agent/` directory, inspired by
Obsidian CLI (`backlinks` / `search` primitives) and the Claude-Obsidian plugin's
hybrid retrieval — but implemented with pure stdlib (no embeddings on the core
path). Complements `graphify` (forward code topology) with markdown semantic
links, and generalizes `experience-recall` (experiences-only) to every store.

## When to Use

- **Find relevant knowledge** across stores before starting a task → `knowledge-recall`
- **Discover impact / who references a note** (backlinks) → `wikilink-index --backlinks`
- **Rewrite links after renaming/moving a note** (avoid dead links) → `link-rename`

## Commands

### 1. Cross-store recall (BM25 + keyword + link-centrality + tag)

```bash
node .agent/skills/knowledge-retrieval/scripts/knowledge-recall.js --query "postcommit hook" [--stores memory,experiences,references,decisions] [--limit 5]
```

Scores each doc: `0.5·BM25 + 0.2·keywordCoverage + 0.15·linkCentrality + 0.15·tagJaccard`.
`linkCentrality` reads the backlink counts from `wikilink-index.json` (build it
first for the link signal to contribute). Output → `metrics/knowledge-recall-result.json`.

### 2. Bidirectional wikilink index

```bash
node .agent/skills/knowledge-retrieval/scripts/wikilink-index.js              # build → metrics/wikilink-index.json
node .agent/skills/knowledge-retrieval/scripts/wikilink-index.js --backlinks "My Note"   # who links to it
```

Parses `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `[[Target#^block]]`, `![[embed]]`.
Produces `forward` / `backward` / `unresolved` (dead-link candidates → feed to knowledge-lint).

### 3. Rename tracking (auto-repair backlinks)

```bash
node .agent/skills/knowledge-retrieval/scripts/link-rename.js --from "Old Name" --to "New Name" --dry-run
node .agent/skills/knowledge-retrieval/scripts/link-rename.js --from "Old Name" --to "New Name"
```

Rewrites every `[[Old Name]]` → `[[New Name]]` across `.agent/**/*.md`, preserving
`|alias` and `#anchor`. Only edits inside `[[...]]`; never touches other prose.
Idempotent; always `--dry-run` first.

## Guarantees

- **Zero dependency**: fs/path only. No embeddings, no npm packages, no external CLI.
- **Read-only by default**: only `link-rename` writes, and only inside `[[...]]`.
- **Rebuildable**: `wikilink-index.json` / recall results are derived artifacts (metrics/, gitignored).
- **Backward compatible**: a vault with no wikilinks → empty index, recall degrades to pure BM25.

## Non-Goals

- No vector/embedding retrieval on the core path (optional plugin — future Phase 2).
- Does not replace `graphify` (code topology) or `knowledge-lint` (health checks).
- Does not modify `memory/` capacity limits or write protocol.

## Relation to Other Skills

- `graphify` — forward code topology (`calls`/`imports`); this skill = markdown `[[wikilink]]` semantic layer.
- `knowledge-lint` — detects dead links; this skill's `link-rename` repairs them.
- `experience-recall` — experiences-only Jaccard; this skill generalizes to cross-store BM25.
- `memory` — this skill fulfills memory proposal's Phase 2 `memory-recall` promise, extended cross-store.
