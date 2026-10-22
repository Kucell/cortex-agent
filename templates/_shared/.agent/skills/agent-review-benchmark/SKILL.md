---
name: agent-review-benchmark
description: Generate evidence-linked Guided Review artifacts and deterministic local Agent benchmark summaries. Use when reviewing Agent-produced diffs by intent, recording structured follow-ups, comparing multiple Agent/model/configuration runs against versioned repository assertions, or preparing reproducible review and benchmark evidence for /ship or Mission validation.
---

# Agent Review Benchmark

Generate structured review or benchmark artifacts from explicit local JSON inputs. Do not use an external LLM judge by default.

## Reviewer Backend

A reviewer backend turns raw review findings into a Guided Review artifact.

> **finding 的产出格式由 schema 固定，谁产出都行。**

The *proposal* may come from anywhere — the `/code-review` workflow, the `code-reviewer` sub-agent, an operator-supplied external reviewer. The *enforcement* never leaves the backend. Every finding is validated before it reaches the artifact, and the artifact is validated before it is written.

1. Produce findings that conform to `references/guided-review-finding.schema.json`. One finding is one reviewed concern; its field names are identical to the artifact's group definition.
2. Hand the findings to a backend:

```bash
node .agent/skills/agent-review-benchmark/scripts/reviewer-backend.js \
  --backend builtin \
  --input <raw-findings.json> \
  --output <guided-review.json> \
  [--workspace <dir>]
```

3. Read `<guided-review.json>.diagnostics.json`. It lists every rejected finding with its reason — a dropped finding is never dropped silently.

A finding is accepted only when it is:

| Rule | Reason code | Why |
|---|---|---|
| conforms to `guided-review-finding.schema.json` | `schema_invalid` | A finding the contract rejects cannot be reported as evidence. |
| cites only files from the reviewed `changed_files` | `file_not_in_changeset` | Enforces input isolation: a reviewer may not report outside the changeset it was given. |
| cites only files present in the workspace | `file_not_found` | Catches a hallucinated file path. |

One rejected finding does not discard the rest. The artifact carries the accepted findings; the diagnostics carry the rejected ones.

### External backend

`--backend external --adapter <module>` loads an operator-supplied adapter. The interface is here on purpose; **no adapter implementation ships, and no external reviewer is a dependency**.

```js
module.exports = {
  review(context) {
    // context is the parsed review input envelope
    return { findings: [/* proposed findings */] };
  },
};
```

An adapter only *proposes* findings. It cannot bypass the schema, the changeset check or the file-existence check — those run in the backend regardless of who proposed the finding.

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

### Finding assertions

A reviewer backend is judged on the finding set it produces, not on prose. Three assertion kinds cover it:

| Assertion | Passes when |
|---|---|
| `finding_present` | The artifact exists and contains a finding matching every stated constraint (`group_id`, `file`, `risk`, `category`, `title_contains`). |
| `finding_absent` | The artifact exists and contains **no** finding matching the stated constraints. |
| `artifact_schema_valid` | The artifact validates against `references/guided-review.schema.json`. |

A missing artifact fails every finding assertion. "The backend rejected this finding" and "the backend never ran" are different outcomes, and only the first one is a pass — otherwise a candidate that does nothing would collect the absent-assertion points.

## Integrity rules

- Require `generated_at` in the input; never inject the current clock into deterministic output.
- Sort groups, files, refs, follow-ups, cases, and candidates before writing.
- Keep scoring integer-only and derived from explicit assertion counts.
- Preserve Run, Session, workspace, task, dataset version, and revision identities.
- Do not infer correctness from prose or Worker self-report.
- Never include credentials, raw environment files, or unredacted terminal output.
- Keep quality, cost, and duration visible as independent dimensions.
- A rejected finding must be reported in the diagnostics, never dropped silently.
