# Dispatch & Lease Vocabulary (FAE-001 / FAE-002 / FAE-003 / FAE-004 / FAE-007)

This directory defines the machine-readable schemas and human-readable
documentation for the **Dispatch / Lease** vocabulary introduced by FAE-001
and extended by FAE-002 / FAE-003 / FAE-004 / FAE-007. The vocabulary is the
shared language for the public lease CLI, the read-only dispatch-state query,
the dispatch dry-run, the explicit manual dispatch, and the corresponding
Management API projections.

`cortex-agent dispatch` now provides a deliberately explicit manual surface:
`dispatch dry-run <task-id>` is read-only and `dispatch <task-id>` is gated,
lease-fenced, and idempotent. `daemon` and `trigger` remain **Phase 0 stubs**
— no daemon, no trigger persistence, and no automatic fallback. All FAE-002 /
FAE-003 / FAE-004 / FAE-007 surfaces remain human-triggered and fail-closed.

## Schemas

| File | Purpose | Status |
| :--- | :--- | :--- |
| `trigger.schema.json` | Reserved Phase 0 trigger record; **Phase 0 does not create records**. | Frozen (FAE-001) |
| `daemon-state.schema.json` | Recoverable local state for a future opt-in user-space daemon; **Phase 0 does not create this file**. | Frozen (FAE-001) |
| `idempotency.schema.json` | Durable deduplication record for a future dispatch attempt; **Phase 0 does not create records**. | Frozen (FAE-001) |
| `dispatch-state.schema.json` | Read-only Management API projection for `query dispatch-state`; **empty-state and populated-state share the same shape**. | FAE-002 |
| `dispatch-plan.schema.json` | Read-only Management API projection for `query dispatch-plan <task-id>`. | FAE-002 |
| `lease-cli.schema.json` | Public ownership lease CLI envelope (acquire / renew / release / status / recover). | FAE-007 |

## CLI surface

| Command | Surface | Source |
| :--- | :--- | :--- |
| `cortex-agent daemon --help` | Phase 0 stub; reserved contract. | FAE-001 |
| `cortex-agent trigger --help` | Phase 0 stub; reserved contract. | FAE-001 |
| `cortex-agent query dispatch-state` | Read-only aggregate (active + queued + blocked + history + next_action). | FAE-002 |
| `cortex-agent query triggers` | Read-only trigger index (Phase 0 returns empty). | FAE-002 |
| `cortex-agent query dispatch-plan <task-id>` | Read-only plan preview for a task. | FAE-002 |
| `cortex-agent dispatch dry-run <task-id>` | Pure resolver; never writes to `.agent/` or `.agent-runtime/`. | FAE-003 |
| `cortex-agent dispatch <task-id>` | Governed explicit manual dispatch; gates + lease fencing + idempotency + rollback; automatic dispatch is disabled. | FAE-004 |
| `cortex-agent lease acquire --scope <scope> --owner <owner> [--idempotency-key <key>] [--ttl <seconds>]` | Public ownership lease acquire; idempotent on key+scope+owner. | FAE-007 |
| `cortex-agent lease renew --lease-id <id> | --scope <scope> [--ttl <seconds>]` | Public ownership lease renew. | FAE-007 |
| `cortex-agent lease release --lease-id <id>` | Public ownership lease release (idempotent). | FAE-007 |
| `cortex-agent lease status [--lease-id <id> | --scope <scope>]` | Public ownership lease status query. | FAE-007 |
| `cortex-agent lease recover --scope <scope> --new-owner <owner>` | Two-phase takeover recovery (P-001 §13.3). | FAE-007 |

## Boundaries

- `daemon` and `trigger` Phase 0 stubs are **never** replaced by silent execution. Their
  `--json` stub returns `ok: false, status: not_implemented` and exits 2;
  no subprocess is spawned, no `.agent/` file is written, no lock is taken.
- FAE-002 query projections are **read-only**. They never call `runs upsert`,
  `queues upsert`, `decisions resolve`, or any mutation primitive.
- FAE-003 dry-run is a **pure resolver**. It writes nothing; the only side
  effects are stdout / stderr / process exit code.
- FAE-004 explicit dispatch is **manually triggered and gated**. `automatic_dispatch_enabled`
  and `daemon_enabled` remain frozen `false`. The dispatch writes to
  `.agent-runtime/dispatch/idempotency/<key>.json` for deduplication, and
  to existing Operation / boundary-event / journal owners — never to a new
  state machine.
- FAE-007 public lease wraps the audited M-008 / T-ACN-005 LeaseManager.
  It does not introduce a new algorithm; it persists to
  `.agent-runtime/coordination/leases/{state.json,idempotency.json}` with
  fsync + atomic rename + 0o600.

## Forbidden side effects

The following are **never** executed by any FAE-002 / FAE-003 / FAE-004 /
FAE-007 surface, even with `--non-interactive --quiet` or other bypass flags:

- `mmx auth` (any subcommand), `mmx config` (any subcommand), `mmx quota`,
  `mmx update`, `mmx install`, `mmx file` (any subcommand), or any paid
  / network / generation subcommand.
- Reading `/Users/xueyq/.mmx/config.json`, `/Users/xueyq/.mmx/auth.json`,
  environment `MINIMAX_API<KEY>`, environment `MINIMAX<TOKEN>`, or any
  `mmx auth` / `mmx config` stdout.
- `git add`, `git commit`, `git push`, `git reset`, `git stash`, `git merge`,
  force-push, publish, release, install, update, or destructive `rm`.
- Subprocess spawn (`child_process.spawn`, `child_process.fork`,
  `child_process.exec`), network sockets (`net.Socket`, `http`, `https`,
  `fetch`), or credential file reads.
- Reading sensitive values into lease `evidence` fields. The CLI rejects
  `sk-…`, `MINIMAX_API<KEY>`, `MINIMAX<TOKEN>`, `api[-_]?key`, `password`
  at the argument boundary with `ERR_LEASE_EVIDENCE_TAINTED`.

## Cross-references

- FAE-001 vocabulary: `projects/full-automation-evolution/proposals/FAE-001-dispatch-vocabulary.md`
- FAE-002 dispatch-state query: `projects/full-automation-evolution/proposals/FAE-002-dispatch-state-query.md`
- FAE-003 dispatch dry-run: `projects/full-automation-evolution/proposals/FAE-003-dispatch-dry-run.md`
- FAE-004 explicit dispatch: `projects/full-automation-evolution/proposals/FAE-004-dispatch-execution.md`
- FAE-007 public lease: `projects/full-automation-evolution/proposals/FAE-007-public-ownership-lease.md`
- Launch workflow compatibility clause: `templates/<lang>/.agent/workflows/launch-governed-agent.md`
- Management API surface: `templates/_shared/.agent/skills/management-api/scripts/index.js`
- Lease owner: `lib/coordination/lease.js` (M-008 / T-ACN-005 audited-approved)
- Lease persistence: `lib/coordination/lease-store.js`
