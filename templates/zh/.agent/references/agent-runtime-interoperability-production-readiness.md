---
title: Agent Runtime Interoperability Production Readiness
module: agent-runtime-interop
module_path: .agent/plans/proposals/projects/agent-workspace-orchestration/proposals/P-006-agent-operation-lifecycle-readiness-proposal.md
module_type: report
keywords: [agent-runtime, interoperability, production-readiness, P-006, coordination-adapter]
status: stable
owner: Codex
last_verified: 2026-07-29
verified_by: Codex
sources:
  - .agent/plans/proposals/projects/agent-workspace-orchestration/proposals/P-006-agent-operation-lifecycle-readiness-proposal.md
linked_decisions:
  - D-M010-P006-c2e7b17a
  - D-ARI-ALL-febe5400
updated_at: 2026-07-29
source: local-verification
---

# Agent Runtime Interoperability Production Readiness

## Outcome

The P-006 authoritative Operation/Authorization/Readiness owner is implemented and the bounded manual production pilot is complete. Pi returned a real adapter boundary receipt associated with a durable coordination lease and new Operation attempt. The Codex safe local boundary was genuinely attempted and proved reachable, but it did not expose an approved unauthenticated execution receipt; the independently verified blocker is retained without fabricating success.

Automatic dispatch and a persistent daemon remain disabled and out of scope.

## Local host probe

Verified on 2026-07-29:

| Host | Local version | Adapter result | Readiness |
| :--- | :--- | :--- | :--- |
| Codex | `codex-cli 0.145.0` | Coordination adapter contract is available; host capabilities remain explicit claims | adapter-ready |
| Claude Code | `2.1.220` | Coordination adapter supports hook or explicit-CLI reporting; live hook receipt was not exercised | adapter-ready |
| Pi | `0.82.1` | `detectPi()` returned `available: true`; session/turn/tool boundary capabilities were detected | probe-pass |
| Cursor | not probed by a stable headless API | Optional, absent-safe adapter contract is implemented | manual-attach-only |

The probe records versions and capability declarations only. It does not imply
authorization, a live authenticated session, or successful task execution.

## Verified implementation path

```text
task requirement
  -> host runtime snapshots
  -> deterministic matcher / dry-run
  -> governance + lease hard filters
  -> manual dispatch owner callback
  -> new Operation attempt ID
  -> redacted context package / checkpoint / handoff
  -> normalized boundary events and audit evidence
```

Focused M-009 validation remains `181/181` passing, and Architecture Guard is
clean. These tests prove the contracts and fail-closed behavior; they do not
replace a live host receipt pilot.

## Production pilot result

M-010 evidence satisfies the approved bounded pilot:

1. P-006 provides the authoritative Operation/Authorization/Readiness writer, replay/recovery, and read-only projections.
2. Manual dispatch calls that owner after governance, snapshot, and durable coordination lease revalidation.
3. Pi produced a real normalized adapter boundary receipt for Operation attempt `OP-M010-PI-001:1`.
4. Cross-host handoff preserved the source checkpoint and created new attempt `OP-M010-HANDOFF-002:2` without private chat history.
5. Durable evidence lives under `.agent/missions/M-010/evidence/` and links requirement, snapshot, lease, Operation, event, receipt, and checkpoint.
6. Codex was genuinely attempted through `codex --version`; authenticated execution was not attempted because the existing safe no-credential boundary provides no execution receipt. `.agent/missions/M-010/evidence/second-host-attempt.json` records `SAFE_EXECUTION_BOUNDARY_UNAVAILABLE`, `receipt: null`, and `fabricated_receipt: false`.
7. Final focused independent regressions passed 545/545, Architecture Guard found no violations across 644 source files, and the sensitive-value evidence scan returned zero findings.

Automatic dispatch and a persistent daemon remain out of scope and disabled by default. They require a separate ADR and Decision.
