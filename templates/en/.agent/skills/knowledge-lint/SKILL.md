---
name: knowledge-lint
description: Run deterministic knowledge checks for broken links, missing READMEs, plan lifecycle drift, and architecture doc mismatches, then emit knowledge-health.json.
---

# Knowledge Lint

## Goal

Provide a first-pass deterministic audit for the repository knowledge system, focusing on structural problems instead of rewriting documentation.

## What It Checks

- Broken Markdown links and invalid anchors
- Missing README files in key knowledge directories
- Active/completed plan lifecycle drift
- Workflow / sub-agent / skill references in `docs/architecture.md` that no longer match the repo

## Output

The script writes:

```text
.agent/metrics/knowledge-health.json
```

and prints a short summary to the terminal.

## Usage

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

## Design Principles

- Deterministic checks only
- Zero dependencies
- High signal over broad coverage
- Do not automatically rewrite large documentation blocks

## Future Integration

- Let `/briefing` read `knowledge-health.json`
- Run lightweight knowledge lint after `/ship`
- Let doc-gardening use lint output for small maintenance tasks
