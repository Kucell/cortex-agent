---
name: host-prompt-slim
description: Generic host-side system-prompt slimming for any JSON model catalog (cc-switch, opencodex, custom). Scans every model's prompt fields (base_instructions / instructions_template / system_prompt / ...), classifies segments as protocol-keep / prose-trim / persona-drop, and applies with backup, atomic write, verification and rollback. Zero dependencies; dry-run preview gate by default.
area: agent-tuning
summary: Scan/audit/slim/rollback host system prompts across all models in a catalog, preserving runtime protocols and security rules while cutting persona/fluff prose. Zero-dependency CLI with mandatory human gate.
---

# host-prompt-slim (generic host-side prompt slimming)

Hosts (Codex / opencodex / cc-switch / Claude Code / Cursor) inject a per-model
`base_instructions` / `instructions_template` into every request. Most of that
text is personality & writing-style prose that carries no operational value, but
a model catalog spans many models — hand-editing one model is not a general
solution. This skill generalizes the process into a repeatable, model-agnostic
tool.

## When to use

- A project runs multiple models (e.g. gpt-5.6-terra / luna / sol, MiniMax, Qwen)
  and each request pays a fixed system-prompt tax.
- You want a per-model token report of every prompt field in a catalog.
- You need a safe, versioned, reversible way to slim prompt fields without
  touching unrelated models or non-content fields.

## Safety model

| Classification | Meaning | Example sections |
| --- | --- | --- |
| keep | verbatim preservation | Working with the user, Final answer, Formatting rules, File editing constraints, Autonomy, Using skills, Rules for getting work done |
| trim | sentence-level: rule sentences kept, fluff dropped | Technical communication, Writing style, Visualizations, General |
| drop | removed entirely | Personality, Voice, Tone |

- Unknown sections fall back to **keep** (conservative).
- `slim` runs **dry-run by default**; pass `--yes` explicitly after reviewing
  the per-segment preview.
- A timestamped `.bak-slim-*` backup is created before any write; `rollback`
  restores it.
- Verification after write: JSON parses, other models byte-identical for the
  fields touched, non-content fields untouched (checked by the calling agent).

## Usage

```bash
# 1. report every model's prompt fields + token sizes (largest first)
node <skill>/scripts/index.js scan --catalog ~/.codex/cc-switch-model-catalog.json

# 2. preview per-segment decisions for one model (dry-run, no write)
node <skill>/scripts/index.js audit --catalog ~/.codex/cc-switch-model-catalog.json \
  --model gpt-5.6-terra

# 3. apply (dry-run by default → review → --yes to write, with backup + verify)
node <skill>/scripts/index.js slim --catalog <path> --model <slug>          # preview
node <skill>/scripts/index.js slim --catalog <path> --model <slug> --yes    # apply

# 4. rollback to the most recent .bak-slim-* snapshot
node <skill>/scripts/index.js rollback --catalog <path>
```

Optional `--field model_messages.instructions_template` restricts to one field.

## Catalog shapes supported

- `{ "models": [...] }` arrays (cc-switch / opencodex)
- top-level arrays
- `{ slug: entry }` object maps
- `{ provider: { models: [...] } }` nesting

Prompt fields auto-detected: `base_instructions`, `instructions_template`
(nested), `system_prompt`, `systemPrompt`, `instructions`, `prompt` (only
strings longer than 50 chars).

## Post-apply checklist (agent)

1. `verifyJson` passed and other models' bytes unchanged (compare pre/post).
2. Field count and slugs unchanged; `comp_hash` etc. untouched.
3. Identity line preserved so host routing identification still matches.
4. Note the applied Decision (host-side change) and the backup path.
5. New sessions pick up the new prompt; existing sessions keep the old value.

## Boundaries & risks

- Classification is heuristic (rule-verb sentence detection). Review the
  dry-run report before `--yes`; misclassified sections are fixable in
  `scripts/rules.js` (KEEP_TITLE / TRIM_TITLE / DROP_TITLE).
- Token savings vary by host: official OpenAI-style instructions slim to
  ~40-55% of original; already-minimal entries (e.g. 34 tokens) are skipped
  naturally by the length filter and review.
- The tool writes the catalog JSON; it does not restart hosts or clear caches
  (`models_cache.json` is catalog-derived; `ocx sync` refreshes it).
- Never run `slim --yes` without a reviewed dry-run, and never touch a catalog
  you did not back up.
