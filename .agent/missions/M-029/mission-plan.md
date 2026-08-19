# Mission Plan: M-029 — DSH First-Class Adapter

> **Status**: `SCOPE → PLAN → CONTRACT`（approved by `/approve` 2026-08-19）
> **Proposal**: [P-006 DSH Host Adapter (first-class)](../../plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md)
> **Approval Decision**: [D-ARI-P006-promote-dsh-firstclass](../../decisions/D-ARI-P006-promote-dsh-firstclass.json)
> **Source Waitpoint**: [WP-ari-p006-impl](../../waitpoints/WP-ari-p006-impl.json)（pending；M-029 CONTRACT 阶段 release）
> **Related Decision**: [D-TCP-004-add-dsh-host](../../decisions/D-TCP-004-add-dsh-host.json)（已 approved，仅授权 shadow usage）
> **Related Waitpoint**: [WP-rsl-dsh-host-shadow-20260819](../../waitpoints/WP-rsl-dsh-host-shadow-20260819.json)（已 released，shadow scope）

## Goal

Promote DeepSeek Harness (DSH) from a Token Control Plane shadow host to a first-class dispatch adapter, on par with Pi / Claude Code / Codex CLI, delivering `discover/health/invoke/cancel/report` 5-method contract, dual-language templates, integration docs, and registration paths.

## Non-Goals

- Implement an LLM provider, agent loop, TUI, or full transcript store inside Cortex Agent.
- Auto-activate DSH dispatch by default — `cortex-agent add dsh` stays opt-in.
- Patch DSH CLI core; if `--json` / stdio JSON-RPC / `--task` flags are absent, fail closed.
- Rewrite `lib/agents/registry.js` (M-002 frozen). Use `VALID_ADAPTER_TYPES_EXT` and `_seed()` try/catch.
- Bypass Decision, Waitpoint, Operation, ownership, lease, or workflow gates.
- Perform commits, pushes, releases, publishing, credential access, or destructive operations without their own workflow and approval.
- Enable DSH tool gate or context pilot beyond Phase 5 (M-018); Phase 5 itself is optional and may ship "dispatch only".

## Scope Boundaries

- In scope: P-006 §2 全部目标 + M-014～M-018 全部 milestone。
- Completed prerequisites:
  - `D-TCP-004-add-dsh-host` 已批准 (shadow usage + backfill)
  - `scripts/dsh-usage-sync.js` 已落地，832 receipts 回放通过
  - `lib/host-adapter/shadow-usage/dsh-shadow.js` 已注册（hostId `dsh`）
- Ownership constraints:
  - 复用 P-001 capability vocabulary，不新增 vocabulary 字段
  - 复用 Workspace P-005 / P-006 状态机，不新建第二套
  - `lib/agents/registry.js` 主体零修改
  - `bin/cli.js` 与 `lib/agents/m003-cli.js` 对外签名零修改
- Serial shared writes:
  - `lib/agents/adapters/index.js#_seed()` try/catch 注入（与 codex 同源）
  - `lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT` 加入 `"dsh"`
  - `lib/coordination/adapter-core.js` 新增 `HostAdapter.dsh` 注册（不动 wakeup / handshake / structured-context）
- Read-only research and independent validation may run separately; implementation remains serial by milestone.
- 双语模板（`templates/zh` + `templates/en`）必须同步。

## Features

| Feature ID | Description | Owner | Status |
| :--- | :--- | :--- | :--- |
| F-014 | DSH capability snapshot + discover/health/report | Worker | Planned (MS-001) |
| F-015 | DSH registry / `_seed()` / `adapter-core.js` 注册路径 | Worker | Planned (MS-002) |
| F-016 | DSH dispatch evidence sink + 6 类失败模式 | Worker | Planned (MS-003) |
| F-017 | DSH 双语模板 + `cortex-agent add dsh` CLI + 文档 | Worker | Planned (MS-004) |
| F-018 | DSH tool gate + context pilot（可选） | Worker | Optional (MS-005) |

## Milestones

| Milestone ID | Goal | Depends On | Validation Contract | Status |
| :--- | :--- | :--- | :--- | :--- |
| MS-001 | DSH capability snapshot + discover/health/report 落地（M-014） | 无 | `validation-contract.json#MS-001` | Planned |
| MS-002 | DSH registry / `_seed()` / `adapter-core.js` 注册（M-015） | MS-001 | `validation-contract.json#MS-002` | Planned |
| MS-003 | DSH dispatch evidence sink + 6 类失败模式（M-016） | MS-002 | `validation-contract.json#MS-003` | Planned |
| MS-004 | DSH 双语模板 + `cortex-agent add dsh` CLI + 文档（M-017） | MS-003 | `validation-contract.json#MS-004` | Planned |
| MS-005 | DSH tool gate + context pilot（M-018，可选） | MS-004 | `validation-contract.json#MS-005` | Optional |

## Sequencing

1. **MS-001** — Read-only observer：snapshot / discover / health / report；不连 dispatch；保留 shadow usage sidecar。
2. **MS-002** — Registry 路径：`VALID_ADAPTER_TYPES_EXT` 加入 `"dsh"`、`_seed()` try/catch 注入、`dsh-bootstrap.js`、`adapter-core.js` 注册、`host-runtime-snapshots.js` 字段。
3. **MS-003** — Dispatch：spawn `dsh` + JSON-RPC + atomic journal + 6 类失败模式 + cancel + report。
4. **MS-004** — 模板 + CLI + 文档：`templates/{zh,en}/integrations/dsh/`、`cortex-agent add dsh`、`docs/platform-integration.md` + `docs/host-dsh-integration.md` + `adapter-authoring.md` §9。
5. **MS-005** — Tool gate + context pilot（可选，依赖 DSH 真实 hook 能力；不实施则发布为 first-class dispatch only）。
6. **COMPLETE** — 全部 milestone PASS 或 explicit waiver；触发 `/publish-docs --architecture` 把 `docs/host-dsh-integration.md` 同步到公开 `docs/`。

## Risks

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| DSH CLI 协议与 §4.3 假设不符（`--json` / stdio JSON-RPC / `--task`） | High | `discover().transport` 在 `health()` 中探测后写回；fake binary 测试覆盖 6 类失败模式；MS-001 先固 discover/health 不连 dispatch |
| 引入 npm 第三方依赖（破坏 `bin/cli.js` 零依赖） | High | PR review 强制 grep；`tests/agent/agent-adapter-dsh.test.js` import 链检查 |
| `_seed()` 修改被误读为破坏 M-002 frozen | Medium | 严格按 codex 路径的 try/catch 注入；不改 `_seed()` 主体，仅末尾追加 |
| `lib/agents/registry.js` 被改 | Medium | 强制只用 `VALID_ADAPTER_TYPES_EXT` 扩展路径；PR review 检查 |
| DSH 用户把 session.jsonl.zstd 拷贝进 `.agent/` | Medium | shadow 路径不变；adapter 不读 session storage |
| 模板与 CLI 不同步（缺 zh/en） | Medium | CI 检查双语模板文件存在 + 行数阈值 |
| DSH 默认开启自动 dispatch | High | 不修改 `bin/cli.js` 默认行为；DSH agent 保持 opt-in |
| token 测量与 dispatch 重复实现 | Medium | DSH shadow adapter 与 backfill 完全复用 |
| DSH 提供 tool gate hook 但与 P-001 契约不符 | Medium | MS-005 推迟；记录为 `unsupported`，readiness `warning|blocked` |
| `lib/coordination/adapter-core.js` 注册引入副作用 | Medium | 新工厂仅在 DSH host 存在时被调用；不动主流程 |

## Exit Criteria

- [ ] All milestones are PASS or have explicit waivers.
- [ ] Blocking validation assertions (VC-001 ~ VC-016 in `validation-contract.json`) are satisfied.
- [ ] Command log records required command exit codes.
- [ ] Handoffs are complete for any cross-agent or cross-session transfer.
- [ ] 双语模板（`templates/zh` + `templates/en`）内容一致。
- [ ] `docs/host-dsh-integration.md` 四节齐备。
- [ ] `lib/host-adapter/shadow-usage/dsh-shadow.js` 与 `scripts/dsh-usage-sync.js` 继续工作（24/24 baseline 不退化）。
- [ ] Test baseline ≥ 287 不退化（参考 `docs/releases/v1.13.0-rc.3.md`）。
- [ ] `bin/cli.js` 零依赖硬约束保持。
- [ ] 纯加法升级（`upgrade` 命令不覆盖用户 `.agent/` 改动）。
- [ ] Waitpoint `WP-ari-p006-impl` 已 released。

## Current State

- State: SCOPE → PLAN → CONTRACT → EXECUTE_FEATURE（MS-001～MS-004 PASS）→ HANDOFF → VALIDATE_MILESTONE → COMPLETE（判定中）
- Current milestone: MS-005（WAIVED-OPTIONAL）
- Last updated: 2026-08-19
- **Milestone 状态汇总**:
  - MS-001 PASS（commit `7d877a8`）
  - MS-002 PASS（commit `005b59e`）
  - MS-003 PASS（commit `8c94bdf`）
  - MS-004 PASS（commit `0f65bd1`）
  - MS-005 WAIVED-OPTIONAL（无 DSH 真实 hook 证据，first-class dispatch only）
- **Global assertions**:
  - VC-029-G01（零 npm 依赖）PASS
  - VC-029-G02（测试 baseline ≥ 287）PASS — 1131/1131
  - VC-029-G03（architecture-guard）PASS
  - VC-029-G04（双语模板对称）PASS — 6/6 文件
  - VC-029-G05（WP-ari-p006-impl released）PASS
