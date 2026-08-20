# Deck Artifacts — `.agent/artifacts/<task-id>/deck/`

This directory is the output of `cortex-agent deck <task-id>` (P-003 MS-001).

## Files

| File | What | How to use |
| :--- | :--- | :--- |
| `deck.html` | Self-contained HTML with inlined CSS | Open in any browser. Print → PDF via ⌘P / Ctrl+P |
| `deck.pptx` | OOXML PPTX, 17 XML parts, zero-dep | Open in PowerPoint / Keynote / LibreOffice |
| `deck.md` | Markdown summary + speaker notes | Paste into README, Notion, GitHub issue |
| `validation-contract.json` | Workflow validation contract | Consumed by `/ship` and downstream pipelines |

## Quick commands

```bash
# Default (HTML + PPTX + MD)
cortex-agent deck TASK-001

# Single format
cortex-agent deck TASK-001 --format=pptx

# Custom output dir
cortex-agent deck TASK-001 --output-dir=./presentations/launch

# Strict — fail if no brief provided
cortex-agent deck TASK-001 --require-brief
```

## Providing custom content

Create `<project>/.agent/<task-id>/deck-brief.json`:

```json
{
  "title": "Q4 Launch",
  "author": "alice",
  "subject": "Internal review",
  "lang": "zh-CN",
  "slides": [
    { "title": "封面", "subtitle": "副标题", "bullets": ["点 1", "点 2"] },
    { "title": "正文", "body": "段落文本" },
    { "title": "结束", "notes": "speaker notes" }
  ]
}
```

Or place at `<project>/.agent/decks/<task-id>.json` as an alt location.

## Boundaries (per P-003 §3)

- No npm dependencies — `bin/cli.js` stays zero-dep
- No image / video generation models — use `/image` and `/motion` workflows
- No open-design daemon takeover — `html-only` backend only in this MS
- No real-time collaboration — single user, single agent