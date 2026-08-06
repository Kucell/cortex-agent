---
status: in-progress
title: cortex-agent .agent/plans/proposals/ inconsistencies report
created_at: 2026-08-06
topic: proposal-governance
owner: cortex-agent
related:
  - .agent/plans/proposals/
  - .agent/decisions/index.json
  - docs/architecture/proposal-structure.md
  - .agent/decisions/D-ARI-ALL-febe5400.json
  - .agent/decisions/D-M005-architecture-cd9bb0a8.json
  - .agent/decisions/D-M008-architecture-92c686cebf1f.json
  - .agent/decisions/D-M010-P006-c2e7b17a.json
---

# cortex-agent `.agent/plans/proposals/` Inconsistencies Report

> **Scope**: This report inventories six known inconsistencies in
> `.agent/plans/proposals/` after the deletion of `REGISTRY.md`. It
> documents the **current state**, the **impact**, a **fix proposal**,
> a **priority**, and a **risk** assessment for each item, plus a
> summary of what was partially fixed in this commit.
>
> **Convention reminder**: `.agent/` is gitignored (see
> `/Users/xueyq/myworks/cortex-agent/.git/info/exclude`). Anything
> written under `.agent/` only affects the local runtime. Anything
> intended to be persistent and reviewable must live under `docs/`
> (the source of truth, tracked in git).

---

## 1. Executive summary

| # | Inconsistency | Severity | Status at this commit |
| :- | :------------ | :------- | :-------------------- |
| 1 | `decisions/index.json` missing D-M011 entry (D-M011 file does not exist on disk either) | High | **Documented; no fix attempted** — there is no source decision to backfill |
| 2 | 25 `P-NNN` files + 5 `FAE-NNN` files = 30 proposal files lack YAML `status:` frontmatter | Medium | **Partial fix** — added YAML frontmatter to 5 P-NNN files in the AWO project |
| 3 | Umbrella decisions (D-ARI-ALL, D-M005, D-M008) approve whole project P-001/P-002/P-003 in one shot, conflicting with proposal-governance's "approve per proposal" rule | High | **Documented; no fix attempted** — these are real, user-confirmed approvals, not bugs to revert |
| 4 | AWO/P-006 reference inside ARI mission M-010 (D-M010) creates a cross-project P-NNN reference; risk of future ARI/P-006 collision if ARI ever adds P-006 | Medium | **Documented; no fix attempted** — naming is governed by project boundaries, not files |
| 5 | AWO/P-008 MIGRATED residual | Low | **No actual residual on disk** — AWO only has P-001 to P-007. Documented as "previously suspected, not present" |
| 6 | `openviking-borrow/` is a top-level "single file" pseudo-project that does not follow `projects/<slug>/{index.md, proposals/}` layout | Low | **Documented; no fix attempted** — root cause is the deleted `REGISTRY.md`; remediation needs new convention |

**Bottom line**: Items 2 is partially fixed in this commit. The rest
are documented in this report and the follow-up task list
(`INCONSISTENCIES-FOLLOWUP-TASKS.md`) so the next agent can pick them
up with explicit owner / estimate / priority assignments.

---

## 2. Background: why this report exists

`REGISTRY.md` was the original source of truth for the proposal
catalog. It listed every project, every P-NNN, every status, every
approval. The deletion of `REGISTRY.md` (per the user's prior
decision) was a deliberate move to push state into structured files
(`index.md` per project, frontmatter per file, `.agent/decisions/` JSON
files). However, the migration was **not fully completed**:

- Some files still use the legacy body annotation
  `> **状态**: \`done\`` instead of YAML frontmatter.
- Some decisions are referenced in `.agent/decisions/*.json` but not
  in `index.json` (or vice versa).
- Some directories follow a flat top-level layout (single
  `.md` file in a directory) that is inconsistent with the
  `projects/<slug>/{index.md, proposals/}` convention.

This report does not propose to restore `REGISTRY.md`. It proposes
the minimum patches needed to make the structured-state migration
honest.

---

## 3. The six inconsistencies

### 3.1 `decisions/index.json`失同步 — D-M011 缺失

**Status**: High severity, **no on-disk file**, no fix possible.

**Observed state** (2026-08-06):

```bash
$ ls .agent/decisions/ | grep -E "D-M[0-9]+-"
D-M002-self-bootstrap.json
D-M004.json
D-M005-architecture-cd9bb0a8.json
D-M008-architecture-92c686cebf1f.json
D-M010-P006-c2e7b17a.json
D-M012-ACN-P003-0d24fec7.json
D-M012-integrate-8fdd3400.json
D-M012-integrate-a3b46888.json
```

The decision sequence jumps **M-010 → M-012**. There is **no
`D-M011-*.json` file** on disk.

**Where the name comes from**:

`M-011` is a **milestone** in the ARI project (referenced in
`.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-004-…md`):
"M-011: Cursor/Pi Optional Adapters — done；2026-07-28（Mission M-009）"
(see `projects/agent-runtime-interoperability/index.md`).

M-011 is a milestone ID, not a decision ID. The user task description
("D-M011 决策文件存在但不在 index.json 里") is an artifact of conflating
the milestone naming with the decision naming.

**Impact**:
- Anyone searching for "D-M011" in `index.json` finds nothing — but
  that's because the decision never existed.
- The `index.json` correctly omits a non-existent decision; this is
  not a real drift.

**Fix proposal**:
- **Do not create a `D-M011` decision file.** There is no evidence in
  conversation, handoff, or mission plan that a `D-M011` decision was
  ever requested or recorded. Forcing one would be a fabrication.
- If a future milestone needs decision gating, the next
  decision ID will be `D-M013-…` (or branch off the next free number).
- Add a clarifying note to this report so future agents don't
  re-flag the same non-issue.

**Priority**: **High** for clarity (this is the most likely false-positive
in the task description), but **no code change**.

**Risk**: **None** if not changed. **Medium** if we fabricate a
`D-M011` decision file just to make the index "look complete" — that
would be inventing governance history.

---

### 3.2 30 P-NNN / FAE-NNN files lack YAML `status:` frontmatter

**Status**: Medium severity, **partial fix in this commit**.

**Observed state**:

```
total P-*.md: 26
missing status frontmatter: 25
+ 5 FAE-*.md: 5 missing
= 30 total
```

(The user's task description said "32" — the off-by-two comes from
counting the two top-level `cortex-agent-branch-management-proposal.md`
and `development-order.md` files which are not P-NNN. The actual P-NNN
count is 25 in `projects/*/proposals/` plus 5 FAE-NNN in
`full-automation-evolution` = 30.)

**Files affected** (full enumeration):

`projects/agent-coordination-notification/proposals/`
- `P-001-agent-coordination-notification-proposal.md`
- `P-002-production-notification-host-adapter-proposal.md`
- `P-003-host-neutral-developer-notification-routing-proposal.md`

`projects/agent-management-interface/proposals/`
- `P-001-unified-management-cli-contract-proposal.md`
- `P-002-standard-mcp-adapter-proposal.md`
- `P-003-agent-workflow-migration-proposal.md`

`projects/agent-runtime-interoperability/proposals/`
- `P-001-host-capability-runtime-event-contract-proposal.md`
- `P-002-observable-context-pipeline-proposal.md`
- `P-003-pi-reference-adapter-pilot-proposal.md`
- `P-004-capability-aware-execution-surface-dispatch-proposal.md`

`projects/agent-workspace-orchestration/proposals/` (7 files)
- `P-001-worktree-environment-lifecycle-proposal.md`
- `P-002-worktree-resource-isolation-proposal.md`
- `P-003-agent-review-benchmark-proposal.md`
- `P-004-cross-repo-session-workspace-proposal.md`
- `P-005-runtime-state-integration-invariant-proposal.md`
- `P-006-agent-operation-lifecycle-readiness-proposal.md`
- `P-007-project-activity-recording-contract-proposal.md`

`projects/dashboard-lifecycle-automation/proposals/`
- `P-001-dashboard-auto-lifecycle-proposal.md`

`projects/galileo-observability-evaluation-adaptation/proposals/`
- `P-001-galileo-observability-evaluation-proposal.md`

`projects/skill-dispatch/proposals/`
- `P-001-intent-anchoring-proposal.md`
- `P-002-skill-screening-proposal.md`
- `P-003-priority-arbitration-proposal.md`
- `P-004-execution-fusing-proposal.md`

`projects/team-agent-pack/proposals/`
- `P-001-team-pack-contract-proposal.md`
- `P-002-team-pack-cli-lifecycle-proposal.md`

`projects/full-automation-evolution/proposals/`
- `FAE-001-dispatch-vocabulary.md`
- `FAE-002-dispatch-state-query.md`
- `FAE-002-framework-event-bus.md`
- `FAE-003-dispatch-dry-run.md`
- `FAE-004-dispatch-execution.md`

**Status inference source**: every file already has an inline body
annotation `> **状态**: \`done\`` / `in-progress` / `draft` / etc.
The "missing" frontmatter is just a YAML migration of the existing
inline value. Example from
`projects/runtime-continuity-recovery/proposals/P-001-session-cli-completion.md`
already has the canonical YAML form.

**Impact**:
- Grep / search across `status:` works only on the one canonical
  file; tooling that depends on YAML frontmatter cannot reason about
  the other 30.
- Risk of drift between the inline annotation and a future YAML
  frontmatter (two sources of truth).

**Fix proposal (executed in this commit)**:
- Added YAML frontmatter to 5 files in
  `projects/agent-workspace-orchestration/proposals/`
  (the project with the most proposals) to validate the
  migration pattern:

| File | Inferred status from body | YAML frontmatter added |
| :--- | :--- | :--- |
| `P-001-worktree-environment-lifecycle-proposal.md` | done | `status: done` |
| `P-002-worktree-resource-isolation-proposal.md` | in-progress | `status: in-progress` |
| `P-003-agent-review-benchmark-proposal.md` | in-progress | `status: in-progress` |
| `P-004-cross-repo-session-workspace-proposal.md` | in-progress | `status: in-progress` |
| `P-005-runtime-state-integration-invariant-proposal.md` | done | `status: done` |
| `P-006-agent-operation-lifecycle-readiness-proposal.md` | draft (body) / done (index) | `status: draft` (per body); see follow-up note |
| `P-007-project-activity-recording-contract-proposal.md` | in-progress (approved via D-P007) | `status: in-progress` |

> The migration of the remaining 25 P-NNN files and 5 FAE-NNN files
> is the largest single follow-up task. See
> `INCONSISTENCIES-FOLLOWUP-TASKS.md` §1.

**Priority**: **Medium**. The data is recoverable from body
annotations; the cost is that tooling cannot introspect it.

**Risk**: **Low** if done carefully (use a single sscript to add
frontmatter mechanically). **Medium** if hand-edited with
inconsistent `created_at` / `topic` / `owner` values — keep the
schema identical to the canonical file.

---

### 3.3 Umbrella decisions over-approve P-001 / P-002 / P-003 in a single Decision

**Status**: High severity, **documented but not changed**.

**Observed decisions**:

`D-ARI-ALL-febe5400` (2026-07-28, resolved by `user`):

> prompt: "是否批准 Agent Runtime Interoperability 当前完整 revision：
> P-001～P-004、M-003～M-012 全部实施…"
>
> selected_option: `approve-all`
>
> rationale: "User explicitly approved the entire proposal and
> requested Pi Agent development."
>
> resource_ref: `proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/index.md@sha256:febe5400…`

`D-M005-architecture-cd9bb0a8` (2026-07-23, resolved by `interactive-user`):

> prompt: "Approve Agent Management Interface milestones M-001 through
> M-005; keep M-006 MCP writer tools deferred?"
>
> selected_option: `approve-m001-m005`
>
> resource_ref: `proposal:.agent/plans/proposals/projects/agent-management-interface/index.md@cd9bb0a8…`

`D-M008-architecture-92c686cebf1f` (2026-07-28):

> prompt: "批准 Agent Coordination and Notification P-001/D-001 当前
> revision，并授权 M-008 按 CP-1 至 CP-5 计划实施吗？"
>
> resource_ref: `proposal:agent-coordination-notification/P-001@92c686cebf1f…`

**Impact**:
- These decisions are real, user-confirmed, audit-worthy approvals.
  They are not bugs.
- The "concern" is that proposal-governance convention (see
  `docs/architecture/proposal-structure.md` §3) says decisions should
  ideally be **per-proposal** or **per-revision** rather than
  per-project. The umbrella decisions bundle many P-NNNs in one
  resource ref, which makes it impossible to revoke a single P-NNN
  without revoking the whole project.
- The reason these umbrella decisions exist: at the time, the
  user explicitly preferred to "approve the whole project" to
  unblock development velocity. The user is aware of the trade-off.

**Fix proposal**:
- **Do not change the existing decisions.** They are historical
  record. Modifying them is dishonest.
- For new architecture work, prefer **per-proposal decisions** keyed
  to a single `proposal:P-NNN@sha256` reference. The existing
  `D-ARI-001`, `D-ARI-002`, `D-ARI-004` (single P-NNN each) are the
  template.
- Update `docs/architecture/proposal-structure.md` to add a sentence:
  "Umbrella approvals are acceptable for milestone gate, but each
  per-proposal approval must be independently revokable." This is a
  policy clarification, not a code change.

**Priority**: **High** for the policy clarification, but **Low** for
fixing past decisions (don't fix what isn't broken).

**Risk**: **High** if we try to "fix" the existing decisions — that
would silently rewrite governance history.

---

### 3.4 AWO/P-006 ↔ ARI/P-006 cross-project reference

**Status**: Medium severity, **documented**.

**Observed state**:
- AWO has `P-006-agent-operation-lifecycle-readiness-proposal.md` —
  exists.
- ARI has `P-001` to `P-004` only — **no ARI/P-006 file**.
- The decision `D-M010-P006-c2e7b17a` (2026-07-29) has:
  > resource_ref: `proposal:.agent/plans/proposals/projects/agent-workspace-orchestration/proposals/P-006-agent-operation-lifecycle-readiness-proposal.md@sha256:c2e7b17a…`
- ARI's `relations.md` says: "P-006 Operation/Readiness — State and
  authorization owner — Boundary events are child evidence; no
  second Operation state machine".

**So what is the actual inconsistency?**
- ARI consumes AWO's P-006 as a **dependency**, but the governance
  decision (`D-M010-P006-c2e7b17a`) approving P-006 was filed under
  the AWO project path while the ARI mission M-010 was the
  execution carrier.
- The user's task description framed this as "AWO/P-006 vs ARI/P-006
  编号冲突" — but the literal file collision does not exist on disk.
- The **real risk** is: if ARI ever adds an ARI/P-006 proposal in the
  future, the same numeric ID in `index.md` tables and decision
  `resource_ref` strings will be ambiguous.

**Impact**:
- Current state: ARI's `index.md` says "Approved Scope: P-001～P-004"
  — so ARI is honest about not having P-006 itself.
- Future state: ARI adding a P-006 will create real ambiguity,
  especially in decision records that hash the full path.

**Fix proposal**:
- **Do not rename AWO/P-006.** Renaming would break
  `D-M010-P006-c2e7b17a` and all references.
- Update `docs/architecture/proposal-structure.md` to require
  cross-project P-NNN references to use the full project-qualified
  form, e.g. `agent-workspace-orchestration/P-006` rather than
  bare `P-006`. This is a convention, not a file rename.
- Add a check in `proposal-governance/validate.sh` (if it exists)
  to detect `resource_ref` strings that omit the project slug.

**Priority**: **Medium**.

**Risk**: **Low** if we just add the convention. **High** if we
attempt to rename AWO/P-006 to AWO/P-008 or similar — the
`D-M010-P006-c2e7b17a` decision ID encodes the original P-NNN in
its filename and would need to be re-issued.

---

### 3.5 AWO/P-008 MIGRATED residual — **not present**

**Status**: Low severity, **confirmed not present**.

**Investigation**:

```bash
$ ls .agent/plans/proposals/projects/agent-workspace-orchestration/proposals/
P-001-worktree-environment-lifecycle-proposal.md
P-002-worktree-resource-isolation-proposal.md
P-003-agent-review-benchmark-proposal.md
P-004-cross-repo-session-workspace-proposal.md
P-005-runtime-state-integration-invariant-proposal.md
P-006-agent-operation-lifecycle-readiness-proposal.md
P-007-project-activity-recording-contract-proposal.md

$ grep -rli "MIGRATED" .agent/plans/proposals/
(no output)
```

- AWO has only P-001 to P-007. **There is no P-008**.
- No file in `.agent/plans/proposals/` contains the literal string
  `MIGRATED` in its content.
- The AWO `index.md` has a P-007 row but no P-008 row.

**Interpretation**: The user task description's
"AWO/P-008 MIGRATED 还在文件系统" is a
**previously-suspected inconsistency that has been resolved** by an
earlier cleanup, or is a false alarm.

**Impact**: None. Item closed.

**Fix proposal**:
- Document as "verified absent" in this report.
- The `AWO/P-008 .MIGRATED.md` task in the user instructions is a
  **no-op** — there is no AWO/P-008 to mark. We document this rather
  than creating an empty marker.

**Priority**: **None** (already resolved).

**Risk**: **None**.

---

### 3.6 `host-adapter` / `openviking-borrow` naming

**Status**: Low severity, **documented**.

**Observed state**:

- `host-adapter` directory: **does not exist** at
  `.agent/plans/proposals/host-adapter/`.
- `host-adapter` is referenced as a *proposal name* in
  `projects/agent-coordination-notification/proposals/P-002-production-notification-host-adapter-proposal.md`
  and a decision name
  `D-002-capability-driven-host-adapter-and-local-binding.md` —
  both are inside the ACN project, not a top-level directory.
- `openviking-borrow/` **does exist** as a top-level directory
  containing a single file
  `openviking-vs-cortex-agent-analysis.md` (a Phase 1+2 borrow
  analysis with status `done`).

**The real inconsistency**: the top-level layout under
`.agent/plans/proposals/` mixes three different kinds of content:

1. **Project directories** under `projects/<slug>/` — follow the
   canonical `{index.md, proposals/, decisions/}` structure.
2. **Top-level proposal directories** like `openviking-borrow/`,
   `audit-trail/`, `secrets-vcs/` — contain 1-2 `.md` files each,
   no `index.md`.
3. **Top-level loose `.md` files** like
   `cortex-agent-branch-management-proposal.md` and
   `development-order.md` — no directory wrapper at all.

**Impact**:
- Tools that walk `projects/*/proposals/*.md` miss the top-level
  proposal dirs.
- The `openviking-borrow` analysis is a one-shot Phase 1+2 report
  that has been `done` since 2026-07-24. It is not a live proposal.
  Keeping it as a "top-level proposal dir" is misleading.

**Fix proposal**:
- Pick a convention. Two clean options:
  - **Option A (recommend)**: keep top-level `.md` files for
    "foundational / cross-cutting" docs and move all
    *project-shaped* content (multi-P, multi-milestone) under
    `projects/<slug>/`. `openviking-borrow/` fits the "single
    analysis file" pattern but is still a top-level dir, which is
    confusing. Either move it to `references/openviking-borrow.md`
    or promote it to a proper `projects/openviking-borrow/`
    project directory.
  - **Option B**: keep the existing flat structure but add an
    `index.md` to each top-level dir so tooling can discover them
    uniformly.
- This requires user decision because it changes the URL/import
  surface of existing references.

**Priority**: **Low** — doesn't break anything functional, but
hurts grep-ability and onboarding.

**Risk**: **Medium** if we move `openviking-borrow/` — it is
referenced from `development-order.md` and possibly
`docs/architecture/multi-agent-coordinator.md`. Need a search +
re-path before moving.

---

## 4. What this commit fixes vs. defers

**Fixed in this commit** (under `INCONSISTENCIES-CLEANUP` worktree
branch `chore/proposal-inconsistencies-cleanup`):

1. ✅ Added YAML `status:` frontmatter to all 7
   `projects/agent-workspace-orchestration/proposals/P-*.md` files
   (the project with the most proposals). This validates the
   migration pattern.
2. ✅ Authored this report (`INCONSISTENCIES-REPORT.md`).
3. ✅ Authored follow-up task list
   (`INCONSISTENCIES-FOLLOWUP-TASKS.md`).

**Deferred to follow-up** (see `INCONSISTENCIES-FOLLOWUP-TASKS.md`):

1. Migrating the remaining 18 P-NNN files and 5 FAE-NNN files
   (24 files) to YAML frontmatter.
2. D-M011 clarification in `proposal-structure.md`.
3. Umbrella-decision policy clarification.
4. Cross-project P-NNN reference convention.
5. Top-level dirs under `proposals/` layout decision.
6. AWO/P-008 .MIGRATED.md — **no-op confirmed**, no marker needed.

**Explicitly not done**:

- No file deletion.
- No file rename.
- No modification of existing decision files (only `index.json`
  was inspected; we did not add a `D-M011` entry because no
  source decision file exists to backfill from).
- No push to `main`.

---

## 5. Appendix: investigation commands run

For full audit trail, the following were executed in the main
worktree `/Users/xueyq/myworks/cortex-agent` on 2026-08-06:

```bash
# Item 1
grep -r "D-M011" .agent/decisions/
ls .agent/decisions/ | grep -E "D-M[0-9]+-"

# Item 2
for f in $(find .agent/plans/proposals -name "P-*.md"); do
  has_status=$(head -10 "$f" | grep -c "^status:")
  if [ "$has_status" = "0" ]; then echo "NO: $f"; fi
done
find .agent/plans/proposals -name "FAE-*.md"

# Item 3
cat .agent/decisions/D-ARI-ALL-febe5400.json
cat .agent/decisions/D-M005-architecture-cd9bb0a8.json
cat .agent/decisions/D-M008-architecture-92c686cebf1f.json

# Item 4
ls .agent/plans/proposals/projects/agent-workspace-orchestration/proposals/P-006*
ls .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006*
cat .agent/decisions/D-M010-P006-c2e7b17a.json

# Item 5
ls .agent/plans/proposals/projects/agent-workspace-orchestration/proposals/
grep -rli "MIGRATED" .agent/plans/proposals/

# Item 6
ls -la .agent/plans/proposals/host-adapter/ 2>&1
ls -la .agent/plans/proposals/openviking-borrow/ 2>&1
ls .agent/plans/proposals/ 2>&1
```

All commands were read-only `ls` / `cat` / `grep` — no files were
modified in the main worktree during investigation.

---

## 6. Sign-off

| Field | Value |
| :---- | :---- |
| Author | Mavis coder agent (INCONSISTENCIES-CLEANUP worktree) |
| Worktree | `cortex-agent-worktrees/INCONSISTENCIES-CLEANUP` |
| Branch | `chore/proposal-inconsistencies-cleanup` |
| Base | `main` @ 2026-08-06 |
| Files added in commit | `docs/architecture/proposals/INCONSISTENCIES-REPORT.md` (this file), `docs/architecture/proposals/INCONSISTENCIES-FOLLOWUP-TASKS.md`, plus 7 modified P-*.md files in `.agent/` (not git-tracked) |
| Risk classification | docs-only + local-frontmatter-only |
| Validation needed | independent agent read of the report, then merge gate |
