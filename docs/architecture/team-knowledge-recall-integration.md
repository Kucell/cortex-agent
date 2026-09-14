---
title: "Team Knowledge Recall Integration (P-003 / M-004)"
status: "done"
created_at: "2026-09-11"
merged_at: "2026-09-11"
related_proposals:
  - ".agent/plans/proposals/projects/team-knowledge-recall/index.md"
related_missions:
  - "M-039 (M-004)"
related_decisions:
  - "D-TKR-004 (bounded pilot)"
  - "D-TKR-MERGE-006 (runbook merge)"
related_waitpoints:
  - "WP-TKR-MERGE-006"
owners:
  - "architecture-coordinator"
tags: ["integration", "self-bootstrap", "evidence", "runbook"]
---

# Team Knowledge Recall Integration (P-003 / M-004)

> Runbook that records how cortex-agent itself consumes the artifacts shipped by
> P-001 (Capability-Gated Auto-Recall), P-002 (Project-Scope Team Pack), and
> P-003 (Friction-Assisted Learning) **inside its own tree**, plus a bounded
> pilot observation session.

## 1. Scope and Non-Goals

In-scope:

- Verify that P-001/P-002/P-003 artifacts are discoverable and exercisable
  from cortex-agent's own working copy (no out-of-tree fork or shim).
- Run one self-bootstrap session and capture friction signals + an
  assessment in the project's `.agent/runtime-evidence/friction/`.
- Land this runbook plus the decision/waitpoint evidence trail.

Out-of-scope (explicit):

- No new `lib/` or `templates/` changes. M-004 is observational only.
- No multi-week dogfood metrics. A single session's evidence is recorded;
  longitudinal analysis belongs to a follow-up mission.
- No upstream PR. M-004 commits land on the local `main` only.

## 2. What cortex-agent Already Ships (Inventory Snapshot)

| Layer | Artifact | Path | Notes |
| --- | --- | --- | --- |
| P-001 metadata precheck | `recall.js --check` | `templates/_shared/.agent/skills/knowledge-retrieval/scripts/recall.js` | Self-contained CLI; returns JSON `{ mode, status, reason, results }`. |
| P-001 sub-agent | `cortex-recall` | `templates/_shared/.agent/agents/cortex-recall.json` | Schema-versioned agent entry; same recall contract. |
| P-002 team-pack | registry + `team-pack` lib + CLI | `lib/agents/registry.js`, `lib/team-pack/index.js`, `lib/commands/team-pack.js` | Pinned schema V2; supports per-project scoping. |
| P-003 friction | skill + signal/score/assessment | `templates/_shared/.agent/skills/friction/`, `lib/friction/{signal,score,assessment}.js` | Self-contained scripts; append-only journals. |
| P-003 host adapters | dsh + pi | `lib/agents/adapters/dsh.js`, `lib/runtime-adapters/pi-adapter.js` | Host capability matrices. |

## 3. M-039 MS-001 — Self-Bootstrap Procedure

### 3.1 Skill auto-install

`friction` skill is part of the runtime template, but a fresh checkout may not
have the local copy materialized yet. Mirror it from the template:

```bash
cp -R templates/_shared/.agent/skills/friction .agent/skills/friction
ls .agent/skills/friction/   # SKILL.md  scripts/{record-signal,friction-score,share-learnings}.js
```

### 3.2 Agent entry

Create `.agent/agents/cortex-agent-self.json` so the project can list itself
via `agents projects list`:

```json
{
  "schema_version": 1,
  "agent_id": "cortex-agent-self",
  "role": "coordinator",
  "model": "gpt-5.6-terra",
  "started_at": "2026-09-11T03:30:00Z",
  "status": "running",
  "projects": ["cortex-agent"],
  "recall": "enabled"
}
```

Validation:

```bash
node -e "const r=require('./lib/agents/registry.js'); const raw=require('./.agent/agents/cortex-agent-self.json'); r.validateEntry(raw); console.log(r.entryProjects(raw), r.entryRecall(raw));"
# [ 'cortex-agent' ] enabled
```

### 3.3 End-to-End Evidence (this session)

| Step | Command | Result |
| --- | --- | --- |
| P-002 E2E | `node bin/cli.js agents projects list --project .` | `cortex-agent-self: cortex-agent` |
| P-001 precheck | `node .agent/skills/knowledge-retrieval/scripts/recall.js --check --query 'friction signal contract' --task-id T-TKR-004` | exit 0; JSON `{ mode:"check", status:"CHECK_UNAVAILABLE", reason:"metadata_not_found", metadata_file, results:[] }` |
| P-003 record | `node .agent/skills/friction/scripts/record-signal.js --project . --session S-TKR-004 --host dsh --type tool_failed --observability derived` | `FS-c6cd3b69-...` appended to `.agent/runtime-evidence/friction/signals.jsonl` |
| P-003 score | `node .agent/skills/friction/scripts/friction-score.js --project . --session S-TKR-004 --host-matrix dsh` | `score: 2, recommendation: "suggest", coverage: explicit` |
| P-003 assessment | `lib/friction/assessment.js` `createAssessment` then `transitionAssessment` 3 times | `FA-8c1b212e-...` walked `observed -> assessed -> suggested -> user_approved` |

All five steps are reproducible from a clean checkout using only the artifacts
listed in section 2. No external scripts or one-off patches were used.

## 4. VC Validation Matrix (M-039 MS-001)

| VC | Description | Status |
| --- | --- | --- |
| VC-001 | friction skill installed under `.agent/skills/friction/` | PASS (3 files present) |
| VC-002 | `.agent/agents/cortex-agent-self.json` validates via `reg.validateEntry` and exposes `projects=["cortex-agent"], recall="enabled"` | PASS |
| VC-003 | runtime integration E2E (P-001 precheck + P-002 list + P-003 record/score/assessment) produces structured output | PASS (see section 3.3) |
| VC-004 | `D-TKR-004` decision records user approval of the bounded pilot | PASS (`approved`, resolved-by `interactive-user`, rationale: `user instruction: P-003 M-004`) |
| VC-005 | this runbook is committed with `D-TKR-MERGE-006` evidence | PASS (this document) |
| VC-DRIFT-001 | no new `lib/` / `templates/` changes from M-004 | PASS (working tree shows only `m .agent` and the new doc) |

## 5. Boundaries and Follow-Ups

- **Multi-week dogfood** is operational and out of scope here. Once the
  friction journal accumulates 3 or more sessions with `recommendation: consider` or
  stronger, schedule a follow-up mission to triage template improvements.
- **`cortex-agent-self.json`** lives in the inner `.agent` gitlink and is not
  committable in the outer repo. It coexists with other sessions' entries
  (`Worker-A-MS001`, etc.); do not delete it — it is the in-tree demo of the
  `agents projects list` contract.
- **Recall entry path.** The P-001 capability probe lives in
  `templates/_shared/.agent/skills/knowledge-retrieval/scripts/recall.js` and
  the `cortex-recall` sub-agent template. There is no top-level
  `cortex-agent recall` CLI command — first-time users that try it hit
  `Unknown command: recall`. A future template revision may add a thin CLI
  alias; for now, the skill script is the canonical entry and this runbook
  documents it.
- **State-sync push failures** in this runbook's transcript are expected when
  no remote is configured (`Repository not found`). They do not block local
  decision/waitpoint writes; the inner `.agent` repo is locally committed and
  all evidence files are durable on disk.

## 6. Evidence Index

| Type | Path / ID |
| --- | --- |
| Friction signals | `.agent/runtime-evidence/friction/signals.jsonl` (2 entries: FS-c6cd3b69-..., FS-a48bb023-...) |
| Friction assessment | `.agent/runtime-evidence/friction/assessments/FA-8c1b212e-5a6e-420e-a3f5-ba5bf2284df8.jsonl` |
| Approval decision | `.agent/decisions/D-TKR-004.json` |
| Merge decision | `.agent/decisions/D-TKR-MERGE-006.json` |
| Merge waitpoint | `.agent/waitpoints/WP-TKR-MERGE-006.json` |
| Mission plan | `.agent/missions/M-039/mission-plan.md` |
| Milestone | `.agent/missions/M-039/milestones/MS-001.md` |
| Task | `.agent/tasks/T-TKR-004.json` |
