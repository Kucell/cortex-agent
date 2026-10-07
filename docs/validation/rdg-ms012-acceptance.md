# RDG MS-012 Acceptance Evidence Matrix

Date: 2026-10-07

## Evidence classes

- LIVE: observed against a real connected provider/repository.
- CONFORMANCE: executed through Cortex provider/store contracts without provider network transport.
- PENDING-LIVE: contract evidence exists, but a real provider connection has not been exercised.

## Matrix

| Scenario | Evidence class | Status | Evidence |
|---|---|---:|---|
| GitHub product + GitHub governance | LIVE | PASS | Kucell/cortex-agent + Kucell/cortex-agent-agent both resolved through connected GitHub API; both default to main; current connection has read/write permission |
| GitHub product + GitLab governance | PENDING-LIVE | PENDING | No GitLab connector available in current environment; provider contract exists but live transport not exercised |
| Gitee compatibility | PENDING-LIVE | PENDING | No Gitee connector available in current environment; provider contract/conformance exists |
| Generic Git | CONFORMANCE | PASS | GitGovernanceStore bare-repo acceptance + optional capability degradation |
| Two remote sessions shared Queue CAS | CONFORMANCE | PASS | two store instances read same revision; first writer wins, stale writer gets RevisionConflict |
| Session restart | CONFORMANCE | PASS | new store/parallel instances recover same queue and revision from persistent Git governance repo |
| Provider capability degradation | CONFORMANCE | PASS | optional checks unavailable => DEGRADED + resumable; required/failed checks => BLOCKED |
| local -> detached -> Git -> local | CONFORMANCE | PASS | stable ProjectIdentity preserved across binding roundtrip |
| drift -> reconcile -> controlled resume | CONFORMANCE | PASS | stale governance revision blocks; refreshed observation returns READY |

## Milestone completion rule

MS-012 is **not complete** while mandatory live cross-provider rows remain PENDING-LIVE.

No simulated or conformance-only result may be reported as a live GitLab/Gitee acceptance.
