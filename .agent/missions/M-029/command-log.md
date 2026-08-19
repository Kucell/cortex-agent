# Command Log: M-029

Record key commands, exit codes, and follow-up actions. If a required command is not run, record the reason.

| Time | Role | Milestone | Command | Exit Code | Result | Follow-up |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-08-19 16:10 | Orchestrator | SCOPE | `node .agent/skills/management-api/scripts/index.js decisions request --gate mission --type architecture --gate-action architecture --resource-ref "proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md" --requested-by arch-design --prompt "..." --options '["approve-promote-dsh-firstclass","approve-pilot-only","defer-after-pi-parity","reject"]' --decision-id D-ARI-P006-promote-dsh-firstclass` | 0 | ok: true — open Decision registered | `waitpoints create --owner-workflow /arch-design` |
| 2026-08-19 16:10 | Orchestrator | SCOPE | `node .agent/skills/management-api/scripts/index.js waitpoints create --gate mission --owner-workflow /arch-design --reason "P-006 DSH first-class adapter approval required" --action architecture --resource-ref "proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md" --decision-id D-ARI-P006-promote-dsh-firstclass --waitpoint-id WP-ari-p006-impl` | 0 | ok: true — Waitpoint blocked (status=blocked, awaiting user approval) | pass to /approve gate |
| 2026-08-19 16:48 | User | PLAN | `node .agent/skills/management-api/scripts/index.js decisions resolve --gate user --decision-id D-ARI-P006-promote-dsh-firstclass --status approved --selected-option approve-promote-dsh-firstclass --resolved-by interactive-user --rationale "..."` | 0 | ok: true — Decision status=approved, rationale captured | proceed to mission create |
| 2026-08-19 16:48 | Orchestrator | PLAN | `/approve P-006-dsh-host-adapter-proposal.md mission` | 0 | Mission M-029 created (SCOPE → PLAN → CONTRACT) | release Waitpoint at MS-001 acceptance |
| 2026-08-19 16:54 | Worker | MS-001 | `write lib/agents/adapters/dsh.js (253 lines; DshAdapter extends BaseAdapter; discover/health + capability descriptor)` | 0 | OK | file written |
| 2026-08-19 16:54 | Worker | MS-001 | `write tests/agent/agent-adapter-dsh.test.js (240 lines; 10 test cases)` | 0 | OK | file written |
| 2026-08-19 16:54 | Worker | MS-001 | `node --test tests/agent/agent-adapter-dsh.test.js` | 0 | 10/10 PASS | all green |
| 2026-08-19 16:54 | Worker | MS-001 | `node --test tests/agent/*.test.js` | 0 | 458/458 PASS | no regression vs 448 baseline |
| 2026-08-19 16:54 | Worker | MS-001 | `node --test tests/host-adapter/shadow-usage/*.test.js tests/scripts/dsh-usage-sync.test.js` | 0 | 82/82 PASS | shadow usage baseline unchanged |
| 2026-08-19 16:54 | Worker | MS-001 | `node .agent/skills/architecture-guard/scripts/index.js` | 0 | No architectural violations | clean |
| 2026-08-19 16:54 | Worker | MS-001 | `wc -l lib/agents/adapters/dsh.js` | n/a | 253 lines | within 500-line soft limit per code-standards.md |
| 2026-08-19 17:12 | Orchestrator | MS-001 | `node .agent/skills/activity-recording/scripts/index.js receipt append --payload-json ...` (commit_intent) | 0 | ok: true — `AR-commit-intent-20260819T091229Z.json` recorded | proceed to commit |
| 2026-08-19 17:12 | Orchestrator | MS-001 | `git -c user.name=cortex-agent -c user.email=cortex-agent@local commit -m "..."` | 0 | `[main 7d877a8] feat(agents): 加入 DSH 一类派发适配器 (MS-001 切片)` | 2 files changed, 493 insertions(+) |
| 2026-08-19 17:12 | Orchestrator | MS-001 | `node .agent/skills/activity-recording/scripts/index.js receipt append --payload-json ...` (commit_result) | 0 | ok: true — `AR-commit-result-20260819T091235Z.json` recorded, commit_identity=7d877a85f6bf18ccebbfc111485f0ebdd9172537 | advance to MS-002 |
| 2026-08-19 17:18 | Worker | MS-002 | `edit lib/agents/registry-adapter-types.js` — added `"dsh"` to `VALID_ADAPTER_TYPES_EXT` | 0 | OK | additive, registry.js unchanged |
| 2026-08-19 17:18 | Worker | MS-002 | `edit lib/agents/adapters/index.js#_seed()` — try/catch inject `DshAdapter` | 0 | OK | mirrors codex path |
| 2026-08-19 17:18 | Worker | MS-002 | `write lib/agents/adapters/dsh-bootstrap.js (new, ~70 lines; mirrors codey-pi-bootstrap.js)` | 0 | OK | opt-in bootstrap path |
| 2026-08-19 17:18 | Worker | MS-002 | `edit lib/coordination/adapter-core.js` — added `dsh.local` + `dsh.dev` to `REGISTERED_ADAPTER_IDS` | 0 | OK | wakeup / handshake / structured-context unchanged |
| 2026-08-19 17:18 | Worker | MS-002 | `edit tests/agent/agent-adapter-dsh.test.js` — added 8 MS-002 test cases | 0 | OK | file extended |
| 2026-08-19 17:18 | Worker | MS-002 | `node --test tests/agent/agent-adapter-dsh.test.js` | 0 | 18/18 PASS | all green |
| 2026-08-19 17:18 | Worker | MS-002 | `node --test tests/agent/*.test.js tests/coordination/*.test.js` | 0 | 1010/1010 PASS | no regression |
| 2026-08-19 17:18 | Worker | MS-002 | `node .agent/skills/architecture-guard/scripts/index.js` | 0 | No architectural violations | clean |
| 2026-08-19 17:18 | Orchestrator | MS-002 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_intent) | 0 | ok: true — `AR-commit-intent-20260819T091833Z.json` | proceed to commit |
| 2026-08-19 17:18 | Orchestrator | MS-002 | `git -c user.name=cortex-agent -c user.email=cortex-agent@local commit -m "..."` | 0 | `[main 005b59e] feat(agents): 把 DSH 接入 registry / _seed() / coordination (MS-002 切片)` | 5 files changed, 191 insertions(+), 1 deletion(-) |
| 2026-08-19 17:18 | Orchestrator | MS-002 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_result) | 0 | ok: true — `AR-commit-result-20260819T091854Z.json`, commit_identity=005b59e626b54b88bc466e34a5b08e1ceab892a5 | advance to MS-003 |
| 2026-08-19 17:46 | Worker | MS-003 | `edit lib/agents/adapters/dsh.js` — full invoke() + cancel() + report() + _parseJsonRpc + _writeErrorAndRollback + subprocess tracking | 0 | OK | file extended to 655 lines |
| 2026-08-19 17:46 | Worker | MS-003 | `edit tests/agent/agent-adapter-dsh.test.js` — added 13 MS-003 cases (fake DSH binary via FAKE_DSH_MODE) | 0 | OK | 31/31 PASS |
| 2026-08-19 17:46 | Worker | MS-003 | `node --test tests/agent/agent-adapter-dsh.test.js` | 0 | 31/31 PASS | all green |
| 2026-08-19 17:46 | Worker | MS-003 | `node --test tests/agent/*.test.js tests/coordination/*.test.js tests/host-adapter/shadow-usage/*.test.js tests/scripts/dsh-usage-sync.test.js` | 0 | 1105/1105 PASS | no regression |
| 2026-08-19 17:46 | Orchestrator | MS-003 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_intent) | 0 | ok: true — `AR-commit-intent-20260819T094611Z.json` | proceed to commit |
| 2026-08-19 17:46 | Orchestrator | MS-003 | `git -c user.name=cortex-agent -c user.email=cortex-agent@local commit -m "..."` | 0 | `[main 8c94bdf] feat(agents): 实现 DSH 派发证据槽与 6 类失败模式 (MS-003 切片)` | 2 files changed, 767 insertions(+), 10 deletions(-) |
| 2026-08-19 17:46 | Orchestrator | MS-003 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_result) | 0 | ok: true — `AR-commit-result-20260819T094620Z.json`, commit_identity=8c94bdf1fd92180ae9cac02ab31e65fd6ea8a58e | advance to MS-004 |
| 2026-08-19 17:49 | Worker | MS-004 | `edit lib/registry/index.js` — PLATFORM_REGISTRY added `dsh` entry (files + links + cleanupPaths) | 0 | OK | dsh platform registered |
| 2026-08-19 17:49 | Worker | MS-004 | `write templates/{zh,en}/integrations/dsh/{README.md,AGENTS.md,settings.json}` (6 files) | 0 | OK | dual-language templates |
| 2026-08-19 17:49 | Worker | MS-004 | `write docs/host-dsh-integration.md` (4 sections) | 0 | OK | matches host-claude-code-integration parity |
| 2026-08-19 17:49 | Worker | MS-004 | `edit docs/platform-integration.md` — DSH row + add dsh example | 0 | OK | platform map updated |
| 2026-08-19 17:49 | Worker | MS-004 | `edit docs/architecture/adapter-authoring.md` — §9.4 EXT + §9.5 DSH section | 0 | OK | authoring guide updated |
| 2026-08-19 17:49 | Worker | MS-004 | `write tests/cli/add-host-dsh.test.js` (4 cases) | 0 | OK | file written |
| 2026-08-19 17:49 | Worker | MS-004 | `node --test tests/cli/add-host-dsh.test.js` | 0 | 4/4 PASS | all green |
| 2026-08-19 17:49 | Worker | MS-004 | `node --test tests/agent/*.test.js tests/coordination/*.test.js tests/host-adapter/shadow-usage/*.test.js tests/scripts/dsh-usage-sync.test.js tests/cli/add-host-dsh.test.js tests/commands/platform.test.js tests/platform/*.test.js` | 0 | 1131/1131 PASS | no regression |
| 2026-08-19 17:49 | Orchestrator | MS-004 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_intent) | 0 | ok: true — `AR-commit-intent-20260819T094934Z.json` | proceed to commit |
| 2026-08-19 17:49 | Orchestrator | MS-004 | `git -c user.name=cortex-agent -c user.email=cortex-agent@local commit -m "..."` | 0 | `[main 0f65bd1] feat(platform): 新增 DSH 双语模板 + add dsh CLI + 集成文档 (MS-004 切片)` | 11 files changed |
| 2026-08-19 17:49 | Orchestrator | MS-004 | `node .agent/skills/activity-recording/scripts/index.js receipt append` (commit_result) | 0 | ok: true — `AR-commit-result-20260819T094943Z.json`, commit_identity=0f65bd1fe3909cdc10bd23b0625441d03507f125 | MS-005 optional or COMPLETE |

## Notes

- Use `not-run` when a command is intentionally skipped.
- Missing evidence for a blocking validation assertion must be recorded as a follow-up.
- Do not paste long logs here. Reference log files or terminal excerpts by path when possible.
- All commits during M-029 must follow `.agent/workflows/commit.md` Steps 1-5 (Conventional Commits).
- Mission M-029 owns the release of `WP-ari-p006-impl` (per `/mission` rules; `/approve` does not release Waitpoints).
