# M-025 MS-003 Phase B — DSH Shadow Host Readiness (2026-08-19)

> **Purpose**: Document DSH (DeepSeek Harness) integration as a third governed Host for M-025 Phase B measurement.
> **Authority**: Decision `D-TCP-004` (approved 2026-08-19T03:30Z) + Waitpoint `WP-rsl-dsh-host-shadow-20260819`
> **Scope**: Measurement-only; no default policy change; no activation.

## 1. Background

P-005 §5 Measurement Gate requires "two Hosts, 7 consecutive days, ≥100 non-test receipts per Host". Phase B was blocked because:

1. MS-002 §VC-011 PASS was based on schema/security validation in a temporary ledger; no Pi receipt was persisted to the main ledger.
2. Only Codex contributed real receipts (21,563 via opencodex-usage-sync backfill).

This release adds DSH as a third governed Host, which (a) satisfies the "two Hosts" prerequisite without needing Pi parity work, and (b) increases diversity for Phase C evaluation.

## 2. Implementation summary

### 2.1 Shadow adapter

- `lib/host-adapter/shadow-usage/dsh-shadow.js` — implements `DshShadowAdapter` registered with `hostId: "dsh"`, `sourceId: "dsh"`
- Alias mapping: `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` → MS-001 canonical fields
- `MEASUREMENT_SOURCES.DSH` added to `lib/host-adapter/shadow-usage/index.js`
- Capability: `available` by default; configurable via `options.usageCapability`

### 2.2 Backfill script

- `scripts/dsh-usage-sync.js` — streams `~/.dsh/sessions/<slug>/session-*/session.jsonl.zstd` via `spawn("zstd", ["-dc"])` (streaming to avoid maxBuffer)
- Filters `assistant/chunk` events with `chunk.type === "usage"`; maps `chunk.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` to canonical
- Preserves original event `time` as `recorded_at` (no overwrite by `now()`)
- Idempotent: receipt_id is deterministic from `(attempt_id, host)` so re-runs produce duplicates only
- CLI: `--dsh-home`, `--project-root`, `--session-slug`, `--since`, `--until`, `--limit`, `--dry-run|--apply`, `--json`

### 2.3 Tests

| Test file | Cases | Result |
|-----------|-------|--------|
| `tests/host-adapter/shadow-usage/dsh-shadow.test.js` | 13 | 13/13 PASS |
| `tests/scripts/dsh-usage-sync.test.js` | 11 | 11/11 PASS |
| **New tests** | **24** | **24/24 PASS** |

Regression: shadow-adapter (16) + capture-usage (5) + passive-collector (37) + opencodex-usage-sync = **102/102 PASS** (verified).

## 3. Backfill results (2026-08-19T03:28Z apply run)

```
sessions_scanned: 7
events_parsed: 16,079
events_mapped: 832
events_skipped: 15,247 (non-usage events + non-usage chunks)
written: 832
duplicates: 0
submit_errors: 0
zstd_errors: 0

by_slug:
  --Users-xueyq-myworks-cortex-agent--: 763 mapped
  --Users-workspace-code-HMI--: 61 mapped
  --Users-xueyq-myworks-dsh-sapce--: 8 mapped

DSH receipts by UTC day:
  2026-08-18: 110
  2026-08-19: 722
```

DSH totals (host_reported):
- input_tokens: 3,021,160
- output_tokens: 463,915
- cache_read_input_tokens: 84,249,719 (DSH surfaces cumulative cache read numbers — expected behavior)
- cache_creation_input_tokens: 0 (DSH `cacheWriteTokens` not currently surfaced in `assistant/chunk`; recorded as `unknown`)

## 4. Post-backfill ledger state

```
total_receipts: 22,397 (was 21,565)
by_host (LLM provider):
  openai: 12,353 (Codex)
  minimax-cn: 6,635 (Codex routing via Pi)
  volcengine: 1,815 (Codex routing via Pi)
  deepseek: 401 (Codex routing)
  combo: 224 (Codex)
  qianwenai: 126 (Codex routing)
  nvidia: 9 (Codex routing)
  dsh: 832 (NEW — DSH agent host)
  codex: 2 (test-verify fixtures)

attempts by agent host (attempt_id prefix):
  ocx-*: 21,563 (Codex)
  dsh-*: 832 (DSH — NEW)
  test-*: 2 (excluded)
  pi-*: 0 (Pi still absent — see pi-ledger-audit-20260819.md)
```

## 5. P-005 §5 progress

| Gate | Status |
|------|--------|
| 每 Host ≥100 non-test | ✅ Codex (21,563), DSH (832). Both exceed. |
| Two Hosts | ✅ Codex + DSH. (Pi optional.) |
| 7 consecutive days | ⏳ observing. DSH started 2026-08-18; Codex already spans 14 non-empty days but with gaps. |
| Token gate (P50 input -25%) | ⏸ not started (Phase C) |
| Quality gate | ⏸ not started |
| Stability gate | ⏸ not started |
| Privacy gate | ✅ No prompt / source / secret leakage observed; allowed fields only. |
| Rollback gate | ⏸ not started |

## 6. What changed in policy

**Nothing.** D-TCP-004 explicitly extends measurement-only-first scope to a third Host. No default cortex-agent behavior changed:

- DSH receipts are appended to the existing `token-attempts/` ledger
- No P-002/P-003/P-004 code path is now triggered by DSH traffic
- DSH shadow adapter is registered for measurement only; `DshShadowAdapter.detectUsage()` defaults to `"available"` but no caller invokes it as a policy gate
- Future activation of P-002/P-003/P-004 still requires P-005 evaluation gates + Phase C economic review + independent resource-bound Decision (per MS-005 §Integration Path)

## 7. Future work (non-blocking)

1. **DSH capability auto-detect** — currently `available` by default; in a future Decision we can switch to `createCapabilityResult(host, source, capability)` based on observed `assistant/chunk` event ratios
2. **DSH model provenance** — DSH does not surface `model` in `assistant/chunk` events; receipts have `model: null`. Phase C evaluation may want to lock model per receipt; deferred until DSH exposes it
3. **DSH → capture-usage.js real-time wiring** — current implementation is backfill-only. A real-time DSH-side hook (similar to opencodex proxy log streaming) would shorten the 7-day window. Not authorized by this Decision; tracked as separate proposal
4. **Pi parity work** — see `pi-ledger-audit-20260819.md` for the independent Decision scope

## 8. Traceability

- Decision: `.agent/decisions/D-TCP-004-add-dsh-host.json`
- Waitpoint: `.agent/waitpoints/WP-rsl-dsh-host-shadow-20260819.json`
- Audit handoff: `.agent/missions/M-025/handoffs/pi-ledger-audit-20260819.md`
- Code: `lib/host-adapter/shadow-usage/dsh-shadow.js`, `scripts/dsh-usage-sync.js`
- Tests: `tests/host-adapter/shadow-usage/dsh-shadow.test.js`, `tests/scripts/dsh-usage-sync.test.js`
- Modified: `lib/host-adapter/shadow-usage/index.js` (MEASUREMENT_SOURCES.DSH added)