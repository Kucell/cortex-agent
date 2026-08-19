# Mission Plan: M-025

## Goal

在不启用自动压缩、自动路由或自动停机的前提下，落地 Token Control Plane 的 measurement-only-first：先建立版本化 `token-attempt` receipt、幂等账本和兼容查询，再接入至少两个 Host 的 shadow usage，形成可信的 7 天基线与质量/成本评测证据。

## Authorization

- Architecture Decision: `.agent/decisions/D-TCP-003.json`
- Approved proposal digest: `sha256:a70d089fef65a6c35e897313adac4cec1b71055c356900c3fec979c38a86f597`
- Approved scope: `measurement-only-first`
- User authorization: “可以 开启 PI agent 去开发”
- Execution host: governed one-shot Pi

## Non-Goals

- 不实现 P-002 最小上下文选择、P-003 自动压实/缓存、P-004 自适应预算与模型路由。
- 不读取 Host 私有 transcript、prompt、response、tool payload、源文件正文或凭据。
- 不把 estimated、selected、rendered 或 planned 数值伪装为 Host confirmed usage。
- 不在缺少两个 Host、连续 7 天非测试样本前发布 Token 节省比例。
- 不提交、推送、合并、创建 PR、发布或清理主工作区。

## Scope Boundaries

- In scope: tracked Management API template sources、token receipt normalization/validation、append-only/idempotent ledger、focused query、CLI contract、tests 和必要的双语模板一致性。
- Initial Pi scope: MS-001，仅实现契约、账本、兼容 CLI 与 focused tests。
- Later scope: MS-002 Host adapter/shadow collection；MS-003 baseline/evaluation，由独立 Gate 决定推进。
- Shared `.agent/` governance files are read-only for Pi；生命周期事件必须通过 Cortex 公共 Task API 上报。
- Ownership expansion, credentials, destructive Git, other repositories and automatic policy activation require a new Decision.

## Features

| Feature ID | Description | Owner | Status |
| :--- | :--- | :--- | :--- |
| F-001 | Versioned `token-attempt` receipt schema and strict normalizer | Pi + Root | PASS |
| F-002 | Append-only ledger with `attempt_id + receipt_id` idempotency | Pi + Root | PASS |
| F-003 | Additive CLI receipt/query surface with legacy `runs tokens` compatibility | Pi + Root | PASS |
| F-004 | Security boundary and `_shared`/zh/en template parity | Pi + Root | PASS |
| F-005 | Two governed Host adapters and shadow collection | Governed Pi + Root | PASS |
| F-006 | Seven-day baseline, quality/cost evaluation and rollout recommendation | Root validator | Planned |

## Milestones

| Milestone ID | Goal | Depends On | Validation Contract | Status |
| :--- | :--- | :--- | :--- | :--- |
| MS-001 | Freeze and implement receipt/ledger/compatible query contract | None | VC-001～VC-010 | PASS |
| MS-002 | Connect at least two Host adapters in shadow mode | MS-001 PASS | VC-011～VC-015 | PASS |
| MS-003 | Complete 7-day baseline and independent evaluation | MS-002 PASS + real samples | VC-016～VC-020 | Phase A integrated into main `85730df` (commit `466b123`); Phase B 7-day observation approved (organic traffic, 0 synthetic); Phase C after window closes; evaluation framework pre-staged at `handoffs/phase-c-evaluation-framework.md` (proposal-only, P-002/P-003/P-004 stay draft) |

## Sequencing

1. Pi serially implements MS-001 in an isolated worktree and stops at `READY_FOR_REVIEW`.
2. Root independently reviews the diff and reruns VC-001～VC-010; worker self-report is not proof.
3. Only after MS-001 PASS may MS-002 create Host-specific shadow adapters.
4. Only after the sample gate is satisfied may MS-003 calculate or publish savings and rollout recommendations.

## Risks

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| estimated values reported as actual usage | High | explicit status/source fields; unknown remains unknown |
| duplicate receipts double-count usage | High | composite idempotency key and replay tests |
| receipt leaks prompt/source/secret | High | strict allowlist, unknown-field rejection and persistence inspection |
| template/runtime divergence | High | `_shared`/zh/en parity tests and additive upgrade rules |
| legacy `runs tokens` regression | Medium | retain existing behavior and focused compatibility tests |
| shared `.agent` mutation from isolated worktree | High | Pi reads governance via symlink but edits tracked files only |
| premature savings claim | High | two-Host, 100-receipt-per-Host and seven-day blocking gates |

## Exit Criteria

- [ ] VC-001～VC-020全部 PASS，或非阻塞项有显式 waiver。
- [ ] Receipt/ledger never persists prompt, response, source body, credential or private absolute path.
- [ ] Estimated and Host-reported values remain distinguishable in storage and query output.
- [ ] Legacy `runs tokens` stays compatible and additive-only upgrade behavior is proven.
- [ ] At least two Hosts each provide 100 non-test receipts over seven consecutive days before any savings claim.
- [ ] Root independently validates every milestone; Pi does not self-ACK.
- [ ] No automatic compaction/routing/policy activation, commit, push, merge or release occurs.

## Current State

- State: MS003_PHASE_B_OBSERVATION_ACTIVE; MS-005 PASS (P-002/P-003/P-004 implementation merged, activation pending Phase B/C + independent Decision); M-026 freeze window approved (D-M026-freeze-window)
- Current milestone: MS-005 PASS (P-002/P-003/P-004 implementation merged); MS-003 Phase B 7-day passive observation in parallel (window starts when both Hosts have eligible receipt on same UTC day); activation of P-002/P-003/P-004 against production traffic awaits Phase C evaluation
- Worktree: `/Users/xueyq/myworks/cortex-agent-worktrees/T-TCP-MS002-PI`
- Agent: governed Pi `pi-M025-MS002`; Task `T-TCP-MS002-PI` is `COMPLETED`; Root validation lease `LEASE-2` released; implementation commit `1f04b16`
- Integration: approved Decision `D-M025-integrate-MS002-f147b865`; released Waitpoint `WP-M025-integrate-MS002-f147b865`; main merge `b3f27ea`; `163/163` main validation PASS
- MS-003 Phase A gate: Decision `D-M025-MS003-pi-launch-225bc4b7` approved (03:55Z) + Waitpoint `WP-M025-MS003-pi-launch-225bc4b7` released; Pi R1 self-exited (LEASE-28 released) -> Pi R2 (LEASE-30, T-TCP-MS003-PI-R2) reached agent_settled; checkpoint `466b123` produced; Root independent validation PASS; 37/37 focused + 53/53 regression; Architecture Guard clean; no forbidden patterns; zero external deps
- MS-003 main integration: Decision `D-M025-integrate-MS003-925508397fa1` approved + Waitpoint `WP-M025-integrate-MS003-925508397fa1` released; `git merge --no-ff 466b123` produced merge commit `85730df` on main (main HEAD = 85730df, ahead origin/main by 5); Architecture Guard clean (1100 source files); 37/37 focused + 53/53 regression; diff --check clean; integration lock released
- MS-003 Phase B: Decision `D-M025-MS003-phaseB-observation-240294f00e6d` approved + Waitpoint `WP-M025-MS003-phaseB-observation-240294f00e6d` released; 7-day passive observation window active; 0 synthetic calls; collector creates no model calls; generated workload needs separate external-side-effect Decision with call/cost cap
- Last updated: 2026-08-14 (Phase A integrated + Phase B observation authorized)
- Last updated: 2026-08-14

- MS-005 (P-002/P-003/P-004 implementation): merged to main via `982935c` (context-traverse + context-expand + capability-detect + budget-ledger + 67 tests) + `2858099` (minimal-context entry); Templates `templates/{zh,en}/.agent/skills/context-budget/scripts/` byte-identical; **activation requires Phase B/C + independent Decision**
- M-026 freeze window: Decision `D-M026-freeze-window` approved (2026-08-17T01:24:55Z); Waitpoint `WP-M026-freeze-window` released; FREEZE.md scope §2 (9 路径冻结) + §3 (3 类例外) 生效; valid until MS-004 validation pass
- P-002/P-003/P-004 proposal status: `draft` → `approved-implementation` (代码已落 main 但 activation gating 仍走 P-005 evaluation gates)
- Last updated: 2026-08-17 (MS-005 milestone added + P-002/P-003/P-004 status sync + M-026 freeze window + runtime-continuity archive_now)
- Last updated: 2026-08-19T03:30Z (MS-003 DSH host expansion: D-TCP-004 approved + Waitpoint WP-rsl-dsh-host-shadow-20260819 released; DSH added as third governed Host; 832 receipts backfilled spanning 2 UTC days; Pi ledger audit completed)
