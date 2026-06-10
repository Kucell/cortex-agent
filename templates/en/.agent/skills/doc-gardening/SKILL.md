---
name: doc-gardening
description: Turn knowledge-health.json into low-risk documentation maintenance recommendations and emit doc-gardening-report.json.
---

# Doc-Gardening

## Goal

Convert structural findings from knowledge lint into concrete maintenance suggestions so knowledge upkeep becomes visible, low-risk, and repeatable.

## Input

- `.agent/metrics/knowledge-health.json`

If knowledge health has not been generated yet, run:

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

## Output

The script writes:

```text
.agent/metrics/doc-gardening-report.json
```

and prints a short recommendation summary to the terminal.

## Usage

```bash
node .agent/skills/doc-gardening/scripts/index.js
```

## Design Principles

- Suggestions only; no large automatic rewrites
- Prefer high-return, low-risk maintenance actions
- Stay decoupled from knowledge lint while reusing its output
- Persist results into repository metrics, not just the conversation

## Typical Actions

- Repair broken links and invalid anchors
- Add missing README entry points
- Flag plan lifecycle migration work
- Flag architecture documentation that drifted from reality
