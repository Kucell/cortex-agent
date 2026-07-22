---
name: agent-review-benchmark
description: Generate evidence-linked Guided Review artifacts and deterministic local Agent benchmark summaries. Use when reviewing Agent-produced diffs by intent, recording structured follow-ups, comparing multiple Agent/model/configuration runs against versioned repository assertions, or preparing reproducible review and benchmark evidence for /ship or Mission validation.
---

# Agent Review Benchmark

Generate structured review or benchmark artifacts from explicit local JSON inputs. Do not use an external LLM judge by default.

## Guided Review

1. Collect task, Run, Session, workspace, base revision, head revision, changed-file groups, risks, validation refs, and follow-ups.
2. Validate the input against `references/guided-review.schema.json` semantics.
3. Run:

```bash
node .agent/skills/agent-review-benchmark/scripts/index.js review \
  --input <review-input.json> --output <guided-review.json>
```

4. Check that every group explains intent, impact, risk, files, validation evidence, and follow-ups.
5. Attach the output to `/ship`, Artifact Bus, or the owning Mission milestone. Treat missing evidence as incomplete, not passed.

## Benchmark

1. Create a versioned dataset of cases and blocking assertions. Record candidate identity, passed/total assertions, cost in integer microunits, duration in milliseconds, and evidence refs.
2. Run:

```bash
node .agent/skills/agent-review-benchmark/scripts/index.js benchmark \
  --input <benchmark-input.json> --output <benchmark-summary.json>
```

3. Compare `quality_basis_points`, `cost_microunits`, and `duration_ms` separately. Do not collapse them into an opaque subjective score.
4. Re-run with the same input and require byte-identical output.

## Integrity rules

- Require `generated_at` in the input; never inject the current clock into deterministic output.
- Sort groups, files, refs, follow-ups, cases, and candidates before writing.
- Keep scoring integer-only and derived from explicit assertion counts.
- Preserve Run, Session, workspace, task, dataset version, and revision identities.
- Do not infer correctness from prose or Worker self-report.
- Never include credentials, raw environment files, or unredacted terminal output.
- Keep quality, cost, and duration visible as independent dimensions.
