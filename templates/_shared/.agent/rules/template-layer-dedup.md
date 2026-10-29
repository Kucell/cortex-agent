---
title: "Template Layer Dedup"
description: '> The template tree has three layers: `_shared` is the language-neutral base, `zh` and `en` are language overlays that only override. `upgrade` lays them down in that order, so a byte-identical copy in a language layer is pure duplication — maintained twice and drifting silently. A template file belongs in exactly one layer.'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-29
status: stable
---

# Template Layer Dedup — one file, one layer

> **Core rule**: a template file belongs in **exactly one layer**.
> Language-neutral content goes in `_shared`; only content that genuinely
> differs by language goes in `zh` / `en`.

---

## How the layers stack

`cortex-agent upgrade` lays them down in a fixed order:

```
1. templates/_shared/.agent/   ← the base (language-neutral)
2. templates/{zh,en}/.agent/   ← language overlays (only where needed)
```

The language layer **only overrides**. The single reason it exists is that a
file's content differs by language.

---

## Where a file belongs

| Kind of content | Layer | Why |
|---|---|---|
| Code, scripts, schemas, config | `_shared` | language-neutral; identical behaviour in every language |
| A document / SKILL / rule / workflow **body** | `_shared` | unless the body itself differs by language |
| User-facing prose, error text, examples | `zh` / `en` | this is what genuinely needs language separation |
| Language-dependent frontmatter fields | `zh` / `en` | same |

**The distinction that matters**: a `SKILL.md` body can be language-neutral
(→ `_shared`) while one frontmatter field needs per-language text (→ language
layer). Those are **two different dimensions** — do not conflate them.

---

## Why a duplicate copy is a defect

The same content stored in `_shared` and in `zh` looks harmless and costs three
things:

1. **One copy gets forgotten.** The most common failure. `_shared` is updated,
   `zh` is not, and downstream projects receive the older of the two — while
   the gate only complains when the layers *disagree*, so nothing complains
   until the difference matters.
2. **The distributed package grows.** Every duplicate is real bytes on every
   install.
3. **Drift reports become unreadable.** When `check:l1-distribution` reports a
   divergence you cannot tell whether the language layer or the shared layer
   is the stale one.

The first one is the dangerous one. The five divergences this repository's
`check:l1-distribution` currently reports all come from the shared surface
not being updated alongside the framework — and three of those files were
byte-identical across all three layers, which means the copying bought no
isolation at all, only a second thing to forget.

---

## The gate

```bash
node scripts/check-template-dedup.js
```

It reports a path that appears in more than one layer with byte-identical
content. A language-layer copy that genuinely **differs** is a legitimate
override, and the gate stays quiet about it.

**The gate runs in CI** (`.github/workflows/full-test.yml`).

---

## How the gates divide the work

| Gate | What it protects |
|---|---|
| `check:parity` | the specified paths agree wherever they appear |
| `check:l1-distribution` | the distribution surface is complete and not drifting from L3 |
| `check:template-dedup` (this one) | the layering itself is healthy — no file maintained twice |

They are complementary: `parity` looks at agreement, `l1-distribution` at
completeness and drift, `template-dedup` at structure.

---

## Fixing a duplicate

1. Confirm the content really is language-neutral (use the table above).
2. **Delete the language-layer copy** and keep the `_shared` one. The upgrade
   order guarantees users still receive identical content.
3. If the content **does** need to differ by language, make the language copy
   genuinely different rather than a placeholder copy.
4. Run `node scripts/check-template-dedup.js` and confirm it is clean.
5. Run `node scripts/check-l1-distribution.js` and confirm no new divergence.

---

## Self-check

- [ ] Does this file really differ by language, or was a copy made "just in
      case"?
- [ ] Would `_shared` be enough? (Code / schema / config always are.)
- [ ] After editing `_shared`, are the language-layer files that genuinely
      differ still in sync?
- [ ] Did you run `pnpm check:template-dedup`?
