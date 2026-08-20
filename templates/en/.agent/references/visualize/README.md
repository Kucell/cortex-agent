---
module: visualize-readme
module_path: .agent/references/visualize/README.md
module_type: "Visualize References Index (上游 vendored)"
keywords: [visualize, fragment, reference, dsh-visualize, upstream]
status: stable
owner: cortex-agent
last_verified: 2026-08-20
verified_by: cortex-agent maintainers
sources:
  - https://github.com/Nagi-ovo/dsh-visualize
  - https://github.com/Nagi-ovo/dsh-visualize/blob/main/LICENSE
summary: "Index + scope statement for vendored DSH Visualize references"
---

# Visualize References

> 本目录文档**字面引用自** [Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize)
> （BSD-3-Clause，© 2026 Jesse Zhang）。仅作为 cortex-agent 框架内的契约参考资料，
> **不**附带 dsh-visualize 的运行时（cordis / 工具注册 / sandbox iframe）。

## Upstream License

```text
BSD 3-Clause License

Copyright (c) 2026 Jesse Zhang
```

完整 LICENSE 见 https://github.com/Nagi-ovo/dsh-visualize/blob/main/LICENSE

## Scope

| Borrowed | Status | Path |
|----------|--------|------|
| Fragment authoring contract | ✅ vendored | `contract.md` |
| Design tokens + base classes | ✅ vendored | `design-tokens.md` |
| Charts handbook (Chart.js + SVG) | ✅ vendored | `charts.md` |
| `validateFragment` / `applyFragmentPatch` | ✅ ported to `lib/visualize-fragment.js` (CommonJS) | — |
| cordis plugin registration | ❌ not borrowed (DSH-coupled) | — |
| `SkillProvider` wire format | ❌ not borrowed (DSH-coupled) | — |
| `presentationMeta` projection | ❌ not borrowed (DSH toolview contract) | — |
| Sandboxed iframe renderer + CSP | ❌ not borrowed (DSH client-runtime) | — |
| `extractStreamingFragment` / `trimStreamingScripts` | ❌ not ported (DSH streaming-preview coupled) | — |
| `visualizeMetaFrom` | ❌ not ported (DSH toolview coupled) | — |
| Example HTML files | ❌ not vendored (described in `charts.md` only) | — |

## Usage

Any cortex-agent skill / workflow that produces an "inline interactive card" or
"standalone HTML report" should:

1. Read `contract.md` first to confirm fragment boundaries (no skeleton tags,
   CDN whitelist, size ceiling).
2. Read `design-tokens.md` when styling UI (theme variables + base classes).
3. Read `charts.md` when using Chart.js or hand-rolled SVG.
4. After writing the file, call `validateFragment` from
   `lib/visualize-fragment.js` for byte-level checks (skeleton / size /
   emptiness only — does not validate semantics).

## Drift Policy

This directory vendors upstream content verbatim. When upstream changes:

1. Re-fetch and diff against the vendored copy.
2. If semantic drift is detected, update frontmatter `last_verified` and add a
   brief note describing what changed.
3. If upstream `validateFragment` / `applyFragmentPatch` change signature,
   `/arch-design` review is required before porting.

## See Also

- Upstream repo: https://github.com/Nagi-ovo/dsh-visualize
- Cortex-agent architecture proposal: `docs/architecture/dsh-visualize-fragment-borrow.md`