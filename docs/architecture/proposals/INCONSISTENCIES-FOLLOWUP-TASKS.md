---
status: open
title: cortex-agent .agent/plans/proposals/ inconsistencies follow-up tasks
created_at: 2026-08-06
topic: proposal-governance
owner: cortex-agent
related:
  - docs/architecture/proposals/INCONSISTENCIES-REPORT.md
  - .agent/plans/proposals/
---

# Follow-up Tasks — `.agent/plans/proposals/` Inconsistencies

> **Purpose**: This is the work list for the inconsistencies documented
> in [`INCONSISTENCIES-REPORT.md`](./INCONSISTENCIES-REPORT.md). Each
> task has an owner suggestion, an estimate, a priority, and an
> explicit "do / don't" boundary so the next agent can pick it up
> without re-investigating.
>
> **Conventions**:
> - Estimates assume a single agent (codex or pi) on a fresh
>   worktree. Wall-clock assumes no user interaction.
> - "Owner" is **suggested**, not assigned. The user (`Eric`) makes
>   the final call.
> - Priority: 🔴 High / 🟡 Medium / 🟢 Low
> - All work happens on `main` or a fresh
>   `chore/...` branch from `main`. No edits to other worktrees.

---

## T-001 · Finish YAML `status:` frontmatter migration for the remaining 24 P-NNN/FAE-NNN files

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.2 in the report |
| Priority | 🟡 Medium |
| Estimate | 1–2 hours (mechanical sed + manual review) |
| Suggested owner | codex (mechanical), then user spot-check |
| Blocker | none |
| Pre-condition | T-001 in this commit validated the YAML schema on AWO/P-001..P-007 |

### Scope

- 18 remaining P-NNN files (25 - 7 already done in this commit)
- 5 FAE-NNN files in
  `projects/full-automation-evolution/proposals/`
- = **24 files** total

### Do

1. Branch from `main`: `git switch -c chore/proposal-frontmatter-migration main`.
2. For each file:
   - Read the existing `> **状态**: \`<value>\`` annotation.
   - Prepend a YAML block:
     ```yaml
     ---
     title: <derive from the existing H1 title>
     status: <inferred>
     created_at: <existing 创建日期 in YYYY-MM-DD, or the file mtime>
     topic: <project slug>
     owner: cortex-agent
     ---
     ```
   - Keep the body annotation as-is (do not delete; downstream
     grep may still use it). Optionally add a comment
     `<!-- status: mirrors YAML frontmatter; do not edit both -->`
     to discourage double-source drift.
3. Commit per project (e.g. one commit per
   `projects/<slug>/`).
4. Push branch and request user review.

### Don't

- Do not edit `runtime-continuity-recovery/P-001-session-cli-completion.md`
  — it already has the canonical frontmatter; sync style, don't
  rewrite.
- Do not invent `created_at` dates that don't exist. If the file
  has no `创建日期` annotation, use the file mtime (preserved by
  Git) or omit the field.
- Do not batch the migration in a single mega-commit; project-level
  commits make review and rollback clean.

### Validation

- `grep -L "^status:" $(find .agent/plans/proposals -name "P-*.md")` should
  return zero files.
- `grep -L "^status:" $(find .agent/plans/proposals -name "FAE-*.md")` should
  return zero files.
- Visual spot-check on 3 random files to confirm the YAML is valid
  (no unclosed quotes, no YAML-only chars in the title).

---

## T-002 · Add `D-M011` clarification to `proposal-structure.md`

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.1 in the report |
| Priority | 🟡 Medium (clarity, not code) |
| Estimate | 15 min |
| Suggested owner | codex |
| Blocker | none |

### Scope

- File: `docs/architecture/proposal-structure.md`
- Add a 3-line note under §1 (or wherever decision ID conventions
  are defined):

  > **Note**: M-NNN is a **milestone** identifier. D-M-NNN is a
  > **decision** identifier. They share a number space but a missing
  > D-M-NNN does not imply a missing decision — milestones don't
  > always require a decision record. The current sequence jumps
  > M-010 → M-012 because the team chose to skip M-011 as a
  > decision-bearing milestone (M-011 exists as a milestone in the
  > ARI project for "Cursor/Pi Optional Adapters", but no formal
  > architecture decision was required for it).

### Do

- Edit `proposal-structure.md` to add the clarification.
- Reference this report (`INCONSISTENCIES-REPORT.md` §3.1) in a
  "see also" footnote.

### Don't

- Do not create a `D-M011` decision JSON file. There is no
  governance event to back it.

### Validation

- `git grep "D-M011" docs/` shows the new clarification, no other
  changes.

---

## T-003 · Add policy clarification on umbrella decisions

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.3 in the report |
| Priority | 🔴 High (governance policy) |
| Estimate | 30 min |
| Suggested owner | user (Eric) writes the policy wording, codex adds it |
| Blocker | user approval on policy text |

### Scope

- File: `docs/architecture/proposal-structure.md` §3 (or wherever
  decision granularity is described).
- Add a paragraph:

  > **Policy**: New architecture decisions should reference a single
  > `proposal:P-NNN@sha256` or a single `architecture:<path>@<sha>`
  > per Decision. Umbrella approvals (e.g. "approve the whole
  > project") are allowed but discouraged — they make per-proposal
  > revocation impossible. The historical umbrella decisions
  > `D-ARI-ALL-febe5400`, `D-M005-architecture-cd9bb0a8`, and
  > `D-M008-architecture-92c686cebf1f` are **valid, not bugs** —
  > they reflect the user's explicit preference at the time.
  > Future decisions should default to per-proposal granularity
  > unless the user re-affirms the umbrella style.

### Do

- Edit `proposal-structure.md` with the policy text above.
- Cross-link `INCONSISTENCIES-REPORT.md` §3.3.

### Don't

- Do not retroactively change the historical decision files.

### Validation

- `git grep "umbrella"` in `docs/architecture/` shows the new
  policy text.

---

## T-004 · Cross-project P-NNN reference convention

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.4 in the report |
| Priority | 🟡 Medium |
| Estimate | 1 hour (doc + lint script) |
| Suggested owner | codex |
| Blocker | none |

### Scope

- Document a convention in `proposal-structure.md`:

  > **Convention**: When a decision or proposal body refers to a
  > P-NNN in a *different* project, the reference MUST use the
  > project-qualified form, e.g.
  > `agent-workspace-orchestration/P-006` rather than bare
  > `P-006`. Same-project references can stay bare. The full path
  > form (`proposal:.agent/plans/proposals/projects/<slug>/proposals/P-NNN-name.md`)
  > is required for `resource_ref` in Decision JSON.

- Add a lint helper in
  `.agent/skills/proposal-governance/scripts/check-cross-project-refs.sh`
  (or equivalent) that greps `.agent/plans/proposals/projects/*/proposals/*.md`
  for bare `P-NNN` references where the referenced P-NNN exists
  in *another* project directory, and warns.

### Do

- Add the convention to `proposal-structure.md`.
- Add the lint script (if the skill exists; otherwise document it
  as a follow-up).

### Don't

- Do not modify the existing `D-M010-P006-c2e7b17a` decision — its
  `resource_ref` already uses the full path form, which is the
  correct convention. The new policy is forward-looking.

### Validation

- `git grep -E "[^a-z-]P-00[0-9]"` in
  `projects/agent-runtime-interoperability/` should show only
  project-internal references or full-path forms. Cross-project
  bare references get flagged.

---

## T-005 · Top-level dirs under `proposals/` layout decision

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.6 in the report |
| Priority | 🟢 Low |
| Estimate | 30 min doc + 1-2 hours migration (if user picks Option A) |
| Suggested owner | user (Eric) picks the option, codex executes |
| Blocker | user choice between Option A (re-home) vs Option B (add index.md) |

### Scope

Two clean options:

- **Option A (recommended in the report)**: move
  `openviking-borrow/` to `docs/architecture/references/openviking-borrow.md`
  (or promote it to `projects/openviking-borrow/` if it becomes a
  live project). Same for other "single-file dirs".
- **Option B**: add `index.md` to each top-level dir so tooling
  can discover them uniformly.

### Do

1. Open a question to the user with `ask_user` (or in a
   follow-up turn) to pick A or B.
2. Once chosen, execute the migration in a single
   `chore/proposal-layout-convention` branch.

### Don't

- Do not silently move `openviking-borrow/` or rename it; it is
  referenced from `docs/architecture/development-order.md` and
  possibly `docs/architecture/multi-agent-coordinator.md`.
  Re-path requires a `git grep` audit first.

### Validation

- After migration, all references in `docs/` resolve to existing
  paths (run `git grep` for each old path before deleting).

---

## T-006 · AWO/P-008 .MIGRATED.md marker — **NO-OP**

| Field | Value |
| :---- | :---- |
| Source inconsistency | §3.5 in the report |
| Priority | 🟢 Low (no work needed) |
| Estimate | 0 (verified absent) |
| Suggested owner | n/a |
| Blocker | n/a |

### Scope

- Verified: AWO has only P-001 to P-007 on disk.
  `grep -rli "MIGRATED" .agent/plans/proposals/` returns nothing.
- The user's task description referenced "AWO/P-008 MIGRATED 还在
  文件系统" but the file does not exist.

### Do

- Nothing. The task is closed by the report.

### Don't

- Do not create an empty `AWO/P-008.MIGRATED.md` marker just to
  satisfy the original task wording. That would be content
  fabrication.

### Validation

- Already validated; this task is informational.

---

## Summary table

| ID | Title | Priority | Estimate | Status |
| :-- | :---- | :------- | :------- | :----- |
| T-001 | YAML frontmatter for remaining 24 files | 🟡 Medium | 1-2h | open |
| T-002 | D-M011 clarification in `proposal-structure.md` | 🟡 Medium | 15min | open |
| T-003 | Umbrella-decision policy clarification | 🔴 High | 30min | open |
| T-004 | Cross-project P-NNN reference convention + lint | 🟡 Medium | 1h | open |
| T-005 | Top-level dirs layout decision | 🟢 Low | 30min+1-2h | blocked on user |
| T-006 | AWO/P-008 .MIGRATED.md | 🟢 Low | 0 (verified absent) | closed |

**Total work estimate**: ~3-5 hours of agent time, plus
user-input gates on T-003 (policy text) and T-005 (layout choice).

**Suggested execution order**: T-002 → T-001 → T-004 → T-003 →
T-005. T-006 is closed.
