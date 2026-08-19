# 冻结窗口 · runtime-state-layout

> **Status**: closed (superseded by `D-M026-MS004-R1-close` at 2026-08-19T00:35:00Z; 原 decision `D-M026-freeze-window` 同步标记为 superseded; waitpoint `WP-M026-freeze-window` 在 released 终态记录 supersede 上下文)
> **Owner**: mission-coordinator
> **Effective**: 2026-08-17T01:24:55Z (Root synchronized `D-M026-freeze-window` to approved and `WP-M026-freeze-window` to released)
> **Closed at**: 2026-08-19T00:35:00Z (Root mission-coordinator + interactive-user 授权 close-out; MS-004 R1 已在 origin/main 合并;FREEZE §5 close conditions 全部满足)
> **Closure decision**: `D-M026-MS004-R1-close`
> **Closure task event**: `CE-MS004-R1-complete-20260819` (T-RSL-MS004-PI → COMPLETED, Root/coordinator + workflowGate=M-026)
> **Baseline commit**: `0792a85` (MS-003 R1 merge commit, on `origin/main`)
> **Closure commit**: `bb694d1` (MS-004 R1 merge commit, on `origin/main`)

## 1. 冻结目的

`cortex-agent update` 的运行时布局迁移引擎（MS-002 checkpoint `9e6651b`）刚通过 fixture 验证，但从未在真实 `.agent-runtime/`（66 文件 / 808K）上跑过迁移。MS-004 即将用同一引擎迁移当前仓库，必须保证：

1. 二次 `update` no-op（VC-009）能通过：迁移期间不得产生额外的 journal/lease/archive/report/binding 写入。
2. 用户修改保护（VC-010）可证伪：plan allowlist 外文件必须保持 byte-identical，不接受并发动静让断言失效。
3. 故障回滚（VC-008）能在干净基线验证：迁移期间不应有其他故障源干扰。
4. 真实迁移（VC-015 ~ VC-018, VC-024）的"前/后 digest 对账"可信：源端与目标端必须各自冻结到迁移结束。

## 2. 冻结范围（不允许任何写操作）

| 路径 | 备注 |
| :--- | :--- |
| `.agent/**` | 共享规则、工作流、技能与项目知识；状态机唯一来源 |
| `.agent-runtime/**` | 当前实战遗留 runtime 数据；本次冻结内不手工搬迁 |
| `lib/runtime-layout/**` | 解析器、身份契约、逻辑 URI、local binding |
| `lib/commands/upgrade.js` | update 入口 |
| `lib/commands/update/**` | planner/apply/rollback/report/verify |
| `tests/runtime-layout/**` | resolver/identity/binding 测试 |
| `tests/update/runtime-layout-migration.test.js` | VC-006 ~ VC-010 聚焦测试 |
| `templates/_shared/.agent/**` | L1 模板与共享合同 |
| `templates/zh/.agent/runtime/**` | 中文模板 runtime 投影 |
| `templates/en/.agent/runtime/**` | 英文模板 runtime 投影 |

## 3. 例外（仍可写，但限定 worktree）

| 例外 | 路径 / 范围 | 工作方式 |
| :--- | :--- | :--- |
| MS-003 consumer/template 迁移自身 | `lib/runtime-state-integration/**`、`lib/coordination/**`、`lib/cross-project/**`、`lib/commands/management-api.js`、`lib/commands/dashboard.js`、`agents/skills/runtime-state-*/**`、`templates/_shared/.agent/contracts/runtime-state/**` | 仅在 `T-RSL-MS003-PI` 隔离 worktree 内提交；不在主线合并 |
| 冻结相关的元数据写 | `.agent/decisions/D-M026-freeze-window*.json`、`.agent/waitpoints/WP-M026-freeze-window*.json`、`.agent/runtime-continuity/events/*freeze*.json`、`FREEZE.md`、`.agent/missions/M-026/**`、`.gitignore` 中 runtime 同步策略 | 由 Root 直接更新；不进入 Pi 开发 worktree |
| Root 协调事件 | `.agent-runtime/coordination/...`（task/lease/event/journal/snapshot） | 仅 Root via `cortex-agent` CLI 操作；CORTEX_STATE_SYNC=off |
| M-025 governance doc sync | `.agent/missions/M-025/**`、`.agent/missions/M-025/handoffs/**`、`.agent/plans/proposals/projects/token-control-plane/proposals/**`、`.agent/plans/task-progress.md` | Root 直接更新；仅文档/markdown 同步，不改 runtime / migration engine / templates；不影响 M-026 MS-004 byte-identical 验证目标 |
| P-006 Host 侧激活治理记录（2026-08-18） | `.agent/skills/host-prompt-slim/**`、`.agent/decisions/D-P006-host-activation-slim.json`、`.agent/experiences/EXP-018-host-prompt-slim.md`、`.agent/skills/skill-index.json` | Root 一次性登记：仅治理/技能/经验/决策记录，不改 runtime / migration engine / templates；不影响 M-026 MS-004 byte-identical 验证目标 |

## 4. 不在冻结范围（继续允许改动）

| 范围 | 说明 |
| :--- | :--- |
| 其他项目（SamHMI、csm-view、samkoonyun-mobile 等） | 不在 M-026 范围；可继续独立开发 |
| Pilot 实战项目 | MS-005 之前的 Pilot 自身改动不受本次冻结影响 |
| `.agents/skills/source-command-*` 适配器层 | 兼容适配层，不是行为定义 |
| 用户私域、未受管脚本 | 与运行时布局合同无关 |

## 5. 生效与撤销

| 触发 | 动作 |
| :--- | :--- |
| 用户在聊天中确认"approve"（或选择 `approve-with-ms003`） | Root 把 `D-M026-freeze-window` 置 `approved` 并填 `selected_option`/`resolved_by`/`resolved_at`/`rationale`；把 `WP-M026-freeze-window` 置 `released`；runtime-continuity 发 `decision` + `checkpoint` 事件；本 FREEZE.md 头部 status 改为 `active` |
| 用户选择 `reject` | Root 把决策置 `rejected`，删除本 FREEZE.md |
| 用户选择 `revise` | Root 在本 doc 末尾记录修订点并重新生成 `D-M026-freeze-window` |
| `MS-004` 通过 VC-015 ~ VC-018 + VC-024 验证 | Root 把决策置 `superseded` 并写 `superseded_by_decision_id`；把 waitpoint 置 `released`；本 FREEZE.md 头部 status 改为 `closed` |

## 6. 冻结期内的 Root 守则

1. 任何写到 §2 范围路径的请求（包括 Pi 实现提议）一律拒绝并指向 MS-003 worktree 或用户授权的 sub-mission。
2. `cortex-agent` CLI 写操作全部 `CORTEX_STATE_SYNC=off`；不要因为 state-sync 推进任何 `main` 之外自动 commit。
3. `.gitignore` 对 `.agent-runtime/` 的同步策略若要调整，必须由 Root 显式 patch，不走 update 流程。
4. 冻结窗口内发现任何 mission plan / freeze 范围冲突，立即停下升级并回报用户，不擅自扩大冻结。

## 7. 关联产物

| 产物 | 路径 |
| :--- | :--- |
| 决策 | `.agent/decisions/D-M026-freeze-window.json` |
| Waitpoint | `.agent/waitpoints/WP-M026-freeze-window.json` |
| Runtime-continuity 事件 | `.agent/runtime-continuity/events/20260814_080000_freeze-window.json` |
| Mission plan 更新 | `.agent/missions/M-026/mission-plan.md` |
| MS-002 milestone | `.agent/missions/M-026/milestones/MS-002.md`（已记录 freeze 准备） |
| Command log | `.agent/missions/M-026/command-log.md` |
| M-025 governance doc sync | `.agent/missions/M-025/**`、`.agent/missions/M-025/handoffs/**`、`.agent/plans/proposals/projects/token-control-plane/proposals/**`、`.agent/plans/task-progress.md` | Root 直接更新；仅文档/markdown 同步，不改 runtime / migration engine / templates；不影响 M-026 MS-004 byte-identical 验证目标 |
| M-019/M-020/M-021/M-022 follow-up governance | `.agent/missions/M-019/**`、`.agent/missions/M-020/**`、`.agent/missions/M-021/**`、`.agent/missions/M-022/**`、`.agent/plans/task-progress.md`（相关条目） | Root 直接更新；M-019/M-020 已完成 follow-up 创建 M-021/M-022 ticket/mission 骨架；M-021/M-022 跟踪 2 per-file TIMEOUT + 9 Mode C/C2 失败；纯 mission-plan / handoffs / command-log 文档，不改 runtime / lib / tests |
| M-013 SP-001 governance prep | `.agent/missions/M-013/**`、`.agent/missions/M-013/milestones/**`、`.agent/missions/M-013/validation-contract.json`、`.agent/missions/M-013/command-log.md` | Root 直接更新；P-005 实施前 SP-001..SP-007 milestone / validation contract / handoff 文档 sync；不含 lib / tests / scripts 实际代码改动 |
## 6. 关闭事件 (2026-08-19T00:35:00Z)

§5 关闭条件全部满足后,Root mission-coordinator 收到 interactive-user 授权 close-out (replied '1' on plan: "直接做1+2+3 收尾"),按以下顺序关闭 FREEZE:

1. **Coordination Task 关闭** - `T-RSL-MS004-PI` 经 `CE-MS004-R1-ready-20260819` (EXECUTING→READY_FOR_REVIEW) 与 `CE-MS004-R1-complete-20260819` (READY_FOR_REVIEW→COMPLETED, producer=root/coordinator + workflowGate=M-026) 进入 COMPLETED 终态,revision=6,evidence refs=9。
2. **新 Decision 创建** - `D-M026-MS004-R1-close` (type=approval, status=approved, requested_by=mission-coordinator, resolved_by=interactive-user, gate.action=external_side_effect) 作为 FREEZE 关闭授权依据,resource_ref 指向 MS-004 R1 close mission URI。
3. **原 Decision 标记 superseded** - `D-M026-freeze-window` 直接编辑为 `status: superseded`(cortex-agent decisions supersede CLI 仅支持 status=open;approved→superseded 按 D-TCP-002/D-TCP-001 precedent 模式直接编辑文件),填 `superseded_by_decision_id=D-M026-MS004-R1-close`、`superseded_at=2026-08-19T00:35:00Z`、`superseded_by=interactive-user`、`supersede_rationale` 详细列出 close 理由 (VC-015..VC-018+VC-024 PASS、PR #12 merged、T-RSL-MS004-PI closed、106/106 tests pass、Architecture Guard 0 violations、`git diff --check` clean)。
4. **Waitpoint 保留 released + 追加 supersede 上下文** - `WP-M026-freeze-window` 保持 `status: released`(waitpoint schema enum 不允许 superseded,且 additionalProperties: false),`release_note` 追加 supersede 段落,`updated_at` 更新为 2026-08-19T00:35:00Z,`decision_id` 保持 D-M026-freeze-window 以保持 schema 合规(原 decision 已被 superseded)。
5. **索引同步** - `.agent/decisions/index.json` 更新 `D-M026-freeze-window` status 为 superseded 并加 `superseded_by_decision_id`/`superseded_at`,新增 `D-M026-MS004-R1-close` 条目;`.agent/waitpoints/index.json` 更新 `WP-M026-freeze-window` 的 `updated_at` 并加 `superseded_by_decision_id` 与 `supersede_note` 字段。
6. **FREEZE.md 头状态** - 从 `active` 改为 `closed`,新增 `Closed at`、`Closure decision`、`Closure task event`、`Closure commit` 行。
7. **Launchd runtime-cleanup 取消** - `~/Library/LaunchAgents/com.cortex-agent.runtime-cleanup.plist` 取消启动调度(`.bak.<ts>` 是 pre-migration byte-identical snapshot,故意保留作为 rollback evidence,不需要清理)。

### 关闭后影响

- 冻结范围 (.agent/*、.agent-runtime/*、lib/runtime-layout/**、lib/commands/upgrade.js、lib/commands/update/**、tests/runtime-layout/**、tests/update/runtime-layout-migration.test.js、templates/_shared/.agent/**、templates/{zh,en}/.agent/runtime/**) 立即释放。
- `cortex-agent update` 可正常写入这些路径,后续模板迁移/真实 .agent-runtime/ 迁移不会再被 FREEZE 阻挡。
- T-RSL-MS004-PI 生命周期结束;若需要发起 MS-005 (Pilot 真实 update),需另开 Coordination Task 与新 Decision/Waitpoint。
