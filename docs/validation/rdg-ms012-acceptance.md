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


## Live cross-provider runner

Manual workflow:

`RDG MS-012 Live Cross-Provider Acceptance`

File:

`.github/workflows/rdg-ms012-live-provider.yml`

The workflow validates a **disposable/test governance repository** on GitLab or Gitee. It never writes to the provider's default branch.

### Required repository secrets

For GitLab:

- `RDG_LIVE_GITLAB_USERNAME`
- `RDG_LIVE_GITLAB_TOKEN`

For Gitee:

- `RDG_LIVE_GITEE_USERNAME`
- `RDG_LIVE_GITEE_TOKEN`

The credentials must have permission to create and delete branches in the designated acceptance repository.

### Workflow inputs

- `provider`: `gitlab` or `gitee`
- `governance_repository`: HTTPS clone URL of the acceptance governance repository
- `governance_branch`: source branch, normally `main`
- `product_repository`: product repository identifier, default `Kucell/cortex-agent`

### What the live runner proves

1. Clone the real governance repository twice, representing Session A and Session B.
2. Record the common remote base revision.
3. Create a temporary `cortex-rdg-ms012-*` acceptance branch.
4. Session A commits evidence and pushes with `--force-with-lease=<expected base>`.
5. Session B commits from the same stale base and performs the same conditional push.
6. Session B **must be rejected** by the provider.
7. A fresh third clone must observe Session A's revision/evidence and must not contain Session B's stale evidence.
8. The temporary branch is deleted using an expected-revision lease.

The workflow uploads `rdg-ms012-live-provider-evidence.json` even when the acceptance run fails.

### Evidence requirements for closing MS-012

The GitLab row may move from `PENDING-LIVE` to `LIVE PASS` only when the workflow artifact shows:

- `provider = gitlab`
- `status = passed`
- `stale_writer_rejected = true`
- `fresh_clone_verified = true`
- `cleanup_succeeded = true`

The same conditions apply independently to Gitee.

Do not use a production governance repository for this workflow. Use a disposable/test repository because the acceptance intentionally creates commits on a temporary branch.
