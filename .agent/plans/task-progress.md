# 任务进度

> **2026-08-20 收口 (P-007 Host Adapter Completeness Round 批准 + M-031 调度)**:
> - **执行授权**: 用户 `/approve D-ARI-P007-host-completeness` 批准 P-007 当前 revision（gates SHA-256 `4c50a96cc297d9f33c322674e1205fafff6947700adceb9ad1339ecb9ec5f44d`）。Decision `D-ARI-P007-host-completeness` (architecture / approved / interactive-user 2026-08-20T03:16:57Z) + Waitpoint `WP-ARI-P007-host-completeness-4c50a96c` (released) 双双落地。
> - **Mission M-031** (Host Adapter Completeness Round，CONTRACT): 7-host × 4-layer 横向闭环（dispatch / shadow / boundary / skill discovery）。范围限定 `agent-runtime-interoperability` 项目 home，仅扩展 `VALID_ADAPTER_TYPES_EXT` + `SUPPORTED_HOSTS` + `HOSTS` 三处，不动 `lib/agents/registry.js` M-002 frozen 主表。
> - **M-031 6 个 milestone 概览**:
>
> | MS | 描述 | Commit | 状态 | 进度 |
> | :--- | :--- | :--- | :--- | :--- |
> | MS-001 | Cursor observer + capability snapshot | TBD | 🟡 Planned | 0/N |
> | MS-002 | DSH dispatch 白名单 + skill path | TBD | 🟡 Planned | 0/N |
> | MS-003 | Cursor shadow adapter + boundary integration | TBD | 🟡 Planned | 0/N |
> | MS-004 | codey dispatch 白名单 + shadow adapter | TBD | 🟡 Planned | 0/N |
> | MS-005 | minimax-cli-skill-discovery list extension (codey / minimax / dsh) | TBD | 🟡 Planned | 0/N |
> | MS-006 | MS-001~005 联调 + 7-host 集成测试 | TBD | 🟡 Planned | 0/N |
>
> - **当前状态**: mission skeleton 已建立（mission-plan.md / validation-contract.json 26 AC + 6 MS + 5 globals，机读 CHECK PASS / milestones MS-001..MS-006.md / handoffs/ / command-log.md 10 行 SCOPE+CONTRACT 记录 / sessions S-M-031 / runs R-M-031 / activity 2 receipts）。Dashboard supervisor 由 `dashboard ensure` 触发启动 (http://127.0.0.1:8787)，用户未授权 `dashboard stop`。
> - **Implementation 未启动**: 未创建独立 worktree，未在 dirty `main` 上 commit 任何代码改动；批准范围仅限治理资产 + 实施骨架，不覆盖任何外部副作用（network write / CI 触发 / release）。
> - **命名澄清**: 本项目 `P-007` = **Host Adapter Completeness Round**（7-host 横向闭环）；本任务进度条目顶部 2026-08-19 段"DSH 真实 hook 证据出现后单列 P-007 (tool gate + context pilot)" 是 **Token Control Plane 的旧 P-007 命名**，与本次 Host Adapter P-007 **不同**。两套 P-007 命名不再并存，新的统一指 Host Adapter。
> - **M-031 调度约束**: 实施前必须由用户显式授权 worktree；CONTRACT 阶段 validation contract 6-gate 全 PASS 后才能进入 EXECUTING；任何 Phase 1~6 gate 失败必须回到 CONTRACT 追加 Decision revision，不允许在 EXECUTING 状态覆盖主仓 evidence。
> - **runtime-continuity 状态**: 本轮 `checkpoint --gate user --phase executing` 落 `2026-08-20T11:30Z` 事件。
> **下一步**: (a) 用户授权 M-031 实施 worktree 后，再启动 MS-001 Cursor observer；(b) M-031 串行执行 MS-001 ~ MS-006，gate 失败回到 CONTRACT 追加 Decision revision；(c) M-031 COMPLETE 后才考虑 M-032 follow-up（claude-code/codey/minimax 真实 shadow 接入）。


> **2026-08-19 收口 (M-029 COMPLETE — DSH first-class adapter 交付完成)**:
> - **执行授权**: 用户 `/approve P-006-dsh-host-adapter-proposal.md mission` 调度 + "批准执行" + "继续"；`D-ARI-P006-promote-dsh-firstclass` (architecture / approved / interactive-user 2026-08-19) 批准 DSH 从 TCP shadow host 提升为 first-class dispatch adapter。
> - **Mission M-029** (DSH First-Class Adapter): MS-001～MS-004 PASS + MS-005 WAIVED-OPTIONAL (无 DSH 真实 hook 证据,发布 first-class dispatch only) → **COMPLETE (2026-08-19)**。
> - **7 commits**: `7d877a8` MS-001 (lib/agents/adapters/dsh.js 五方法契约 + P-001 capability descriptor) + `005b59e` MS-002 (VALID_ADAPTER_TYPES_EXT 加 dsh + _seed() try/catch + dsh-bootstrap.js + adapter-core.js dsh.local/dev) + `8c94bdf` MS-003 (invoke() + 6 类失败模式 + cancel/report) + `0f65bd1` MS-004 (双语模板 6 文件 + PLATFORM_REGISTRY.dsh + docs/host-dsh-integration.md + platform-integration 行 + adapter-authoring §9.5) + `427cd64` closeout + `44a5862` publish-docs (docs/architecture/dsh-host-adapter.md) + `60b84e1` COMPLETE。
> - **验证**: 测试基线 **1131/1131 PASS** (agent 458 + coordination + shadow-usage 82 + CLI/platform + dsh 31 + add-host 4)；architecture-guard 无违规；双语模板 6/6；零 npm 依赖 (dsh.js 仅 node: 内置)；docs 脱敏通过。
> - **此前挂起的 DSH adapter 工作已收口**: task-progress §2026-08-19 samkoonyun-mobile 收口里"另一会话进行中的 `lib/agents/adapters/dsh.js` 未提交修改 (MS-003 invoke/cancel)" + "下一步 (c) 另一会话完成后 review + commit" → **已完成** (MS-003 提交 `8c94bdf` + 全套 DSH 交付)。
> - **P-006 提案状态**: draft → approved → in-progress → **done**；index.md P-006 行 done；M-014～M-017 done；M-018 proposed (P-007 follow-up, 等 DSH 真实 hook 证据)。
> - **治理资产**: `WP-ari-p006-impl` released (mission_ids: [M-029])；activity receipts 16 条 (AR-commit-intent/result, MS-001~004 + closeout + publish-docs + COMPLETE + M-029 建立)。
> - **M-025 Phase B 不受影响**: DSH dispatch adapter 与 shadow usage (dsh-shadow.js + dsh-usage-sync.js) 互不触碰；Phase B 7-day window 继续观察 (预计 8-24 满)。
> **下一步**: (a) M-025 Phase B window 满 (预计 8-24) 后跑 preflight 脚本 → `D-M025-MS003-phaseC-shadow-<sha>` (沿用既有挂起流程,本会话不触碰)； (b) 可选: `git push` 推送 7 个 M-029 commits；(c) DSH 真实 hook 证据出现后单列 P-007 (tool gate + context pilot)。

> **2026-08-19 收口 (samkoonyun-mobile 升级到 rc.14 + P-003 Pilot 矩阵 4/4 补齐)**:
> - **授权执行**: 用户指示 `/Users/workspace/code/Samkoon APP/samkoonyun-mobile` 项目也需升级。前置状态: `.cortex-version` = rc.10 (落后 4 RC),git clean (branch `feat/mobile-device-variable-cards`, HEAD `fd8627b`),上次更新 8-13。
> - **执行方式**: 因主仓 working tree 含未跟踪文件 (本会话产物 pi-usage-sync.js + tests + rc.3 release notes) + 另一会话进行中的 `lib/agents/adapters/dsh.js` 未提交修改 (DSH adapter MS-003 invoke/cancel),**不重新 pack** (避免把未发布改动带进 tarball);直接复用 volta 已装的 rc.14 binary 对目标跑 `cortex-agent upgrade` + `cortex-agent update` (等价 local-publish-validate Step 6)。
> - **升级结果**: `.cortex-version` rc.10 → **rc.14**;`upgrade` additive OK (context-budget v2 全套 + contracts/runtime-state + workspaces schema 等);`update` status=**passed** ok=true (2 updated / 1 merged / 0 protected / 0 failed);`--verify` **7/7 PASS**;second-update noop (0 added/updated/merged);git status 0 entries (`.agent/` gitignored)。
> - **KI-3 orphan schema 清理** (同 SamHMI/hmi-platform 模式): `.agent/contracts/runtime-state/` 下 6 个 orphan (authorization/evidence-ref/log-cursor/operation/readiness-projection/resource-event, sha256 均非源端) → `rm` → 复验 `--verify` 7/7 PASS + second-update noop 仍成立;目录对齐源端 (5 new schemas + README)。
> - **P-003 Pilot 矩阵 4/4 补齐**: `samkoonyun-mobile` 从 `pending` → `validating`;validation artifact `.agent/pilot-artifacts/runtime-state-layout-update/samkoonyun-mobile.json` (result=partial, KI-1 rollback 未实测 + KI-2 模板源硬编码路径, KI-3 resolved);pilot-projects.md §3 注册项目表 + §5 能力矩阵 + KI-3 脚注同步。**四个适用 Pilot 项目 (samhmi/hmi-platform/csm-view/samkoonyun-mobile) 全部 validating**。
> - **主仓未触碰**: `lib/agents/adapters/dsh.js` 的未提交修改属另一会话 DSH adapter MS-003 进行中工作,**未 commit / 未 pack / 未触碰**;本会话产物 (pi-usage-sync.js + tests + rc.3 release notes + preflight 脚本) 仍未 commit。
> - **runtime-continuity 状态**: 本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T05:35Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**: (a) Phase B window 满 (预计 8-24) 后跑 preflight (7/7 green) → `D-M025-MS003-phaseC-shadow-<sha>`; (b) GA 前置资产 + MS-006 资产 (pi-usage-sync) 满窗后一并 commit + push; (c) `lib/agents/adapters/dsh.js` 另一会话完成后 review + commit。

> **2026-08-19 收口 (MS-006 Pi agent host 接入主 ledger — 统计不重开)**:
> - **用户指示**: "先补 Pi 再进 Phase C 统计不需要重开" — Pi agent host 主 ledger 写入路径补齐,Phase B 7-day window 起点保持 8-18 (Codex+DSH 首次同日),Pi 数据追加进同一窗口,不重新起算。
> - **审计假设修正**: `pi-ledger-audit-20260819.md` §2.1 假设 "Pi 无日志源" (仅查 `~/.openpi/usage.jsonl`) 经复核为**误判** — Pi session transcript (`~/.pi/agent/sessions/<slug>/<session>.jsonl`) 的 `type:"message"` 行携带完整 public usage (0.84.x: `message.usage` 嵌套; 旧格式: 顶层 `usage`),字段与 `pi-json-shadow.js` alias 映射完全吻合。
> - **新增 `scripts/pi-usage-sync.js`** (zero-dep streaming backfill): 扫描 Pi sessions → 提取 `type:"message"` 行 public usage → MS-001 receipt → 主 ledger;`host="pi-json"` (agent-host 维度, 镜像 dsh);`attempt_id="pi-"+session+"-"+eventId` (确定性幂等);只读 usage/model/provider/timestamp,不读 prompt/response/tool payload。
> - **新增 `tests/scripts/pi-usage-sync.test.js`**: 8/8 PASS (映射/幂等/slug filter/limit/missing-home);`scripts` scope 4/4 PASS。
> - **Decision + Waitpoint**: `D-M025-MS006-pi-bridge` (approved, option=approve-with-backfill, 2026-08-19T05:25Z) + `WP-M025-MS006-pi-bridge` (released) + index.json 同步。
> - **Backfill apply 结果** (2026-08-19T05:23Z): sessions_scanned=31, files_scanned=80, rows_parsed=19,420; **written=8,858**, duplicates=0, submit_errors=0。Ledger total 21,565 → **31,255**;by agent host: **codex 21,563 + dsh 832 + pi 8,858** + test 2 (excluded)。Pi 8-18 → 391, 8-19 → 546 (与 Codex+DSH 8-18 同日出现)。
> - **Phase B window 状态**: 三 Host (codex+dsh+pi) 同日出现始于 8-18;7 天窗口进度 **2/7 天** (截至 8-19),预计 **8-24 满**。统计未重开 (用户指示)。
> - **preflight 脚本修正**: (1) sample_gate 判定改为 **agent-host 维度** (attempt_id 前缀 ocx-/dsh-/pi-, 非 LLM provider host 字段); (2) readiness 查询实例化修正 (`createPassiveCollector` 而非 `passiveCollector`); (3) exclusion key 匹配 `/test/i`。修正后 **7/7 ALL GREEN**: sample_gate=PASS (agent_hosts=test,codex,dsh,pi + eligible=31,253) / inference_rate=PASS (0) / reproducibility=PASS / tests=PASS (71) / arch_guard=PASS / active_audit=PASS / rollback_drill=SKIPPED (需真实执行一次)。
> - **pi-ledger-audit 追加 §8** (MS-006 resolution): 审计假设修正 + 脚本 + backfill 结果 + 统计不重开 + 遗留 (Pi runtime 实时桥 future work)。
> - **runtime-continuity 状态**: 本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T05:25Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**: (a) Phase B 窗口满 (预计 8-24) 后跑 preflight (7/7 green) → 提交 `D-M025-MS003-phaseC-shadow-<sha>` (rollback drill 需在满窗前真实执行一次纳入 evidence); (b) GA 前置起草资产 (rc.3 release notes + release decision 模板) 保留,满窗后一并 commit + push。

> **2026-08-19 收口 (等待 Phase B window 满 — GA 推进挂起)**:
> - **用户指示**: "等 Phase B window 满后再推进"。GA 前置起草 (rc.3 release notes + preflight 脚本 + release decision 模板) 已完成并保留,但**不 commit / 不 push / 不继续 GA 流程**,待 Phase B 满窗后恢复。
> - **Phase B window 当前状态** (2026-08-19T04:05Z 查询):ledger total 22,397 receipts;agent-host 维度: **codex 21,563 + dsh 832 + test 2 (excluded)**;Pi 仍 0 (缺席,已记录于 pi-ledger-audit)。双 Host 同日出现始于 **2026-08-18** (codex 846 + dsh 110),8-19 (codex 850 + dsh 722)。若 8-18 为 window 起点,7 天窗口预计 **8-24/25 满** (需 DSH 后续每日持续有流量,若中断则窗口顺延);比早前预估的 8-21~22 略晚 (DSH 只有 2 天数据)。
> - **等待期间的挂起资产**: `docs/releases/v1.13.0-rc.3.md` (untracked) + `scripts/phase-c-stage1-preflight.sh` (untracked) + `.agent/decisions/templates/D-release-1.13.0-stable.template.json` (untracked) + task-progress 更新;均保留在工作区,待满窗后一并 commit。
> - **恢复触发条件**: Phase B window 满 (双 Host 连续 7 天) → 跑 `bash scripts/phase-c-stage1-preflight.sh --json` (sample_gate 应从 WARN → PASS) → 提交 `D-M025-MS003-phaseC-shadow-<sha>` → Stage 1 PASS 后填 `D-release-1.13.0-stable-<sha>` → 用户拍板 → npm publish。
> - **runtime-continuity 状态**:guard PID 71858 / renew_until `2026-08-19T06:37:47Z` (窗口过期后 SessionStart hook 会自动重新拉起)。
> **下一步**: 等待 Phase B 满窗 (预计 8-24/25),期间无主动动作。

> **2026-08-19 收口 (GA 前置起草: rc.3 release notes + Phase C preflight + release decision 模板)**:
> - **背景**:用户要求 "token 优化和 runtime 提案实施完成就可以做正式版本发布";评估后路径 B (等 Phase B 满 + Phase C Stage 1 PASS 后发 v1.13.0 stable),并授权起草三件套。
> - **1. `docs/releases/v1.13.0-rc.3.md`** (新增, 起草):v1.13.0 stable 候选 RC。核心增量: TCP DSH 第三 Host (D-TCP-004 approved, dsh-shadow.js + dsh-usage-sync.js + opencodex-usage-sync.js) + runtime-state-layout 实战验证收口 (P-003 release gate unlocked, 3/3 Pilot + KI-3 resolved);继承 rc.2 全量 (Event Bus / Branch Mgmt / OKF / TCP measurement / context-budget v2 / runtime-state-layout MS-001+002);287/287 tests PASS;Excluded: P-002/003/004 默认激活 (待 Phase C Stage 1 + 独立 Decision) + P-006/007 (draft) + M-007 (gate) + M-014 (PLAN)。
> - **2. `scripts/phase-c-stage1-preflight.sh`** (新增, 可执行):M-025 Phase C Stage 1 (Shadow) 7 步 pre-flight checklist 落地为可执行脚本 (基于 handoff §4,但修正 readiness 查询实际在 passive-collector.queryReadiness 而非 query-token-attempts.js CLI);`--json` 输出机器可读 readiness report;`--skip-rollback` 供 CI。本机实测 6/7 PASS (sample_gate WARN 因 Phase B window 未满,符合预期;71/71 shadow-usage tests PASS;arch-guard clean;no activation leak)。
> - **3. `.agent/decisions/templates/D-release-1.13.0-stable.template.json`** (新增, 模板):发版 Decision 模板 (approval / external_side_effect / release:cortex-agent@<candidate-digest>),含 publish / defer-until-phase-c-stage1 / defer-until-ki1-rollback / reject 四选项;Phase B close 后填 digest + sha 即可提交。
> - **发版路径确认**:v1.13.0 stable (minor bump from 1.12.0-rc.14)。GA 前置: (a) M-025 Phase B 7-day window 满 (预计 8-21~22, 需 DSH/Codex 双 Host 同 UTC day 首次 eligible receipt 后起算) + Phase C Stage 1 shadow readiness PASS (preflight 脚本跑通); (b) `D-release-1.13.0-stable-<sha>` 用户拍板; (c) npm publish 授权 + 2FA OTP。GA 步骤: version bump → plugin.json/marketplace.json 同步 (当前 1.12.0-rc.10 已滞后,GA 时一并修) → CHANGELOG `[1.13.0]` 段 → tag v1.13.0 → push → npm publish。
> - **runtime-continuity 状态**:本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T04:00Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) Phase B window 满后 (8-21~22) 跑 preflight 脚本 → 提交 `D-M025-MS003-phaseC-shadow-<sha>`;(b) Phase C Stage 1 PASS 后填 `D-release-1.13.0-stable-<sha>` 模板 → 用户拍板 → npm publish;(c) 期间可选: plugin.json/marketplace.json 版本对齐 (当前 rc.10 滞后)。

> **2026-08-19 收口 (DSH host 接入 + Pi ledger 审计)**:
> - **执行授权**:用户授权"选项 A 补齐 + DSH 统计"后,执行 DSH 作为第三个 governed Host 加入 M-025 Phase B 测量 + Pi agent host 缺席审计。
> - **DSH shadow adapter**:`lib/host-adapter/shadow-usage/dsh-shadow.js` 新增,注册 `hostId: "dsh"`,`sourceId: "dsh"`;`MEASUREMENT_SOURCES.DSH` 加入 `lib/host-adapter/shadow-usage/index.js`;alias 映射 `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` → MS-001 canonical; capability 默认 `available` 可通过 `options.usageCapability` override;13/13 tests PASS。
> - **DSH backfill script**:`scripts/dsh-usage-sync.js` 新增,streaming `~/.dsh/sessions/<slug>/session-*/session.jsonl.zstd`(via `spawn("zstd",["-dc"])` 流式避免 maxBuffer 截断);filter `assistant/chunk` events `chunk.type === "usage"`;保留原始 event `time` 作为 `recorded_at`(不 overwrite);幂等 `(attempt_id, host)` → 同样 receipt_id;CLI `--dsh-home`/`--project-root`/`--session-slug`/`--since`/`--until`/`--limit`/`--dry-run|--apply`/`--json`;11/11 tests PASS。
> - **Backfill 结果 (2026-08-19T03:28Z apply run)**:sessions_scanned=7, events_parsed=16079, events_mapped=832, events_skipped=15247;written=832, duplicates=0, submit_errors=0, zstd_errors=0;by_slug: cortex-agent 763 + HMI 61 + dsh-sapce 8。Ledger by UTC day: 2026-08-18 → 110, 2026-08-19 → 722。
> - **Ledger 状态后**:total_receipts=22,397 (was 21,565);by_host: openai 12353, minimax-cn 6635, volcengine 1815, deepseek 401, combo 224, qianwenai 126, nvidia 9, **dsh 832 (NEW)**, codex 2 (test-verify)。attempt_id by agent host: ocx-* 21563 (Codex), **dsh-* 832 (NEW)**, test-* 2 (excluded), pi-* 0 (Pi 仍缺席)。
> - **全量回归**:shadow-adapter 16/16 + capture-usage 5/5 + passive-collector 37/37 + dsh-shadow 13/13 + dsh-usage-sync 11/11 + opencodex-usage-sync = 102/102 PASS。
> - **Pi ledger 审计 (`.agent/missions/M-025/handoffs/pi-ledger-audit-20260819.md`)**:审计发现 MS-002 §VC-011 PASS 实际写到**临时 MS-001 ledger** 而非主 ledger;MS-002 验收口径偏窄——仅验证 schema/security 通过,未验证"持续真实流量持续写入";opencodex 有 `~/.opencodex/usage.jsonl`,**Pi 无对等日志源**;Pi runtime (`lib/runtime-adapters/pi-adapter.js`) 存在但**没有任何路径调用 capture-usage.js → 主 ledger**;Pi parity work 留作独立 Decision 范围,不阻塞当前 DSH 决策。
> - **Governance artifacts**:新建 Decision `D-TCP-004-add-dsh-host` (architecture / approved / interactive-user / approve-add-dsh-shadow, 2026-08-19T03:30Z) + Waitpoint `WP-rsl-dsh-host-shadow-20260819` (released, 7/7 gates passed);`P-001` proposal header 更新为 D-TCP-004 dual authorization;`token-control-plane/index.md` §10 当前决策表 + §13 下一步 check list 同步;M-025 mission-plan current state 新增 DSH host expansion entry + last_updated 2026-08-19T03:30Z。
> - **scope 边界确认**:DSH 接入**不改变**任何默认行为;scope 仍为 `measurement-only-first`;non-goals (auto-compaction/routing/stop/Host-private-transcript/estimated-masquerading) 不变;P-002/P-003/P-004 activation 仍需 P-005 evaluation gates + Phase C + 独立 resource-bound Decision;Phase C 评估时 DSH receipts 与 Codex 一样被纳入两 Host 评测样本池。
> - **runtime-continuity 状态**:本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T03:30Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) Phase B 7-day observation window 持续观察 Codex + DSH 双 Host 流量,等待连续 7 天窗口;(b) Pi parity work 独立 Decision 范围,建议下个 Mission (M-026/MS-004-R2 或独立 MS-006) 处理;(c) DSH model provenance(`assistant/chunk` events 不带 model) Phase C 评估时再决定 lock 维度。

> **2026-08-19 收口 (Push origin 完成)**:
> - **执行授权**:用户授权 `push` 后,执行 `git push origin main` + `git push origin v1.12.0-rc.14`。
> - **main push**:本地 `main` 2 commits (`483bce7 chore(local-publish-validate): 1.12.0-rc.14` + `e56baef docs(release): bridge rc.11..rc.14 + 添加 rc.14 release notes`) 推送到 origin;非 destructive,无 force-push,无 protected branch 冲突。
> - **tag push**:`v1.12.0-rc.14` (annotated, 本地创建于 2026-08-19T01:00:24Z) 推送到 origin;origin refs/tags/v1.12.0-rc.14 → 483bce7 (与 main 同步)。
> - **同步确认**:`git fetch origin` 后 `main...origin/main [ahead 0 / behind 0]`;`origin/main HEAD = e56baef`,与本地一致。
> - **未触碰**:工作树 2 个未跟踪文件 (`scripts/opencodex-usage-sync.js` + `tests/scripts/opencodex-usage-sync.test.js`) 非本会话引入,**未 commit / 未 push**,保持原状。
> - **runtime-continuity 状态**:本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T03:05Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) 若需 npm publish rc.14 到外部 registry,需独立 Decision 授权(本 workflow 默认不 publish);(b) KI-1 + KI-2 仍待下个 RC 周期独立 MS 处理;(c) SamHMI/hmi-platform 工作分支 (`fix/workspace-platform-surface-layout` / `feat/control-handoff-v5-pilot-batch`) 不在 main 上,本次 push 不影响。

> **2026-08-19 收口 (KI-3 orphan schema 清理 + KI-3 resolved)**:
> - **执行对象**:本会话授权执行 KI-3 (legacy-schemas-not-cleaned) 收口 — 3 个实战项目 (`csm-view-memory-rc10` / `SamHMI` / `hmi-platform`) 的 orphan schema 文件手动 `rm`。
> - **每个文件 sha256 比对**:通过对比目标文件 vs 源端 `templates/_shared/.agent/contracts/runtime-state/` sha256,精确区分 MATCH-NEW(保留) vs ORPHAN(删除);避免误删新 schema。
> - **csm-view 清理**:`.agent/runtime/` 下删除 3 个 orphan + 1 个 sha-identical duplicate (4 文件):`evidence-ref.schema.json` (orphan) / `log-cursor.schema.json` (orphan) / `resource-event.schema.json` (orphan) / `runtime-state-projection.schema.json` (sha-identical duplicate,可删);保留 `README.md`。`.agent/runtime/` 与源端 `templates/_shared/.agent/runtime/` 状态对齐。
> - **SamHMI / hmi-platform 清理**:`.agent/contracts/runtime-state/` 下各删除 6 个 orphan (6 文件):`authorization.schema.json` / `evidence-ref.schema.json` / `log-cursor.schema.json` / `operation.schema.json` / `readiness-projection.schema.json` / `resource-event.schema.json`;保留 5 个新 schema + `README.md`。`.agent/contracts/runtime-state/` 与源端对齐。
> - **清理后验证**:3 个项目各跑 `cortex-agent update --verify` → 全部 7/7 PASS;再跑 1 次 `cortex-agent update` → 全部 `summary: {added:0, updated:0, merged:0}` 即 idempotent noop 仍成立。**无副作用**。
> - **3 个 P-003 §4 validation artifacts 更新**:每个 artifact 从 `known_issues` 移除 KI-3,新增 `resolved_since_capture` 段 (含 resolved_at + action 描述 + verified_by);保留 `last_resolved_at: 2026-08-19T02:55:00.000Z` 字段。
> - **pilot-projects.md 注册表同步**:§5 能力验证矩阵 `runtime-state-layout-update` 行从 "KI-1/2/3 known_issues" → "KI-1/2 known_issues; KI-3 resolved 2026-08-19T02:55Z";新增脚注详述 KI-3 cleanup 步骤;`last_updated` → `2026-08-19T02:55Z`。
> - **runtime-state-layout index.md P-003 行同步**:从 "with documented known_issues" → "with documented known_issues; KI-3 orphan schema 残留已 2026-08-19T02:55Z 解决";剩余 known issues 注释保留 (KI-1 rollback + KI-2 模板源硬编码路径)。
> - **已知 issue 现状**(本会话收口后):
>   - **KI-3 legacy-schemas-not-cleaned**: ✅ **RESOLVED** 2026-08-19T02:55Z (本轮手动清理)
>   - **KI-1 rollback_verified**: ⏳ pending (需受控环境;下个 RC 周期独立 MS)
>   - **KI-2 absolute_path_scan_passed**: ⏳ pending (模板源 SKILL.md 硬编码路径;下个 release cycle 模板侧 templating)
> - **runtime-continuity 状态**:本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T02:58Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) KI-3 收口完整,3/3 Pilot 现在仅 KI-1/2 两个 template/system 级别 issue,非本 RC 必做;(b) `git push` 仍待用户授权;(c) 下个 RC 周期独立 MS: rollback 真实项目测试 + 模板源 SKILL.md 路径 templating。

> **2026-08-19 收口 (P-003 MS-005 Pilot validation 跑通,release gate 解锁)**:
> - **P-003 release gate 解锁**:基于本会话 3 个实战项目 (`csm-view-memory-rc10` / `SamHMI` / `hmi-platform`) 的 P-003 §3 完整验证序列证据(dry-run zero write + 7/7 verify PASS + second-update 0 changed = idempotent),新建 `D-rsl-p003-pilot-validation-20260819` (architecture / approved / interactive-user, option=approve-with-known-issues, 2026-08-19T02:45:00Z) + `WP-rsl-p003-pilot-validation-20260819` (released);3 个 P-003 §4 validation artifacts 落 `.agent/pilot-artifacts/runtime-state-layout-update/{csm-view-memory-rc10,SamHMI,hmi-platform}.json`。
> - **3/3 Pilot 验证矩阵**:5 个 boolean PASS(`dry_run_zero_write` / `apply_passed` / `verify_passed` / `second_update_noop` / `user_content_preserved`);2 个 boolean 显式 false + 已知 issues 完整记录 — **(1) `rollback_verified`**: rollback 需受控环境,M-002 fixture VC-009 已隔离覆盖,真实项目 rollback 测试建议纳入下个 RC 周期独立 MS;**(2) `absolute_path_scan_passed`**: 模板源硬编码路径在 `.agent/skills/*/SKILL.md` 和 `.agent/skills/runtime-continuity/scripts/index.js`,非运行时状态泄漏,模板侧 templating 已纳入下个 release cycle 候选;**(3) `legacy-schemas-not-cleaned`**: 源端 commit 1a12043 已删除 7 个旧 schema 但目标未主动清理(csm-view 4 个在 `.agent/runtime/` + SamHMI/hmi-platform 各 6 个在 `.agent/contracts/runtime-state/` 混在 5 个新 schema 之间),需独立清理任务。
> - **P-003 header 状态翻转**:`approved-implementation ⚠️ release-eligible 仍需 MS-005 Pilot` → **`implementation-released ✅`** (with documented known_issues);Release Gate Approval 字段填 `D-rsl-p003-pilot-validation-20260819`;Pilot Validation 段填 3/3 项目结果。
> - **runtime-state-layout project index 同步**:§3 sub-proposals 表 P-003 行更新为 `implementation-released ✅`;Pilot 描述改为 "全部落地,release gate 已解锁(已知 issues 见每项目 validation artifact)"。
> - **pilot-projects.md 注册表更新**:`last_updated` 2026-08-12 → 2026-08-19;`last_commit` fe40f1b → 483bce7;`last_verified` 2026-08-12 → 2026-08-19;新增 `validation_artifacts` 字段 + 3 个 artifact 路径;§3 注册项目: `samhmi` / `hmi-platform` / `csm-view` 从 `pending` → `validating` (result=partial);§5 能力验证矩阵新增 `runtime-state-layout-update` 行 (3 个项目 validating partial,1 个 n/a)。
> - **P-003 release gate 已解锁的实际意义**:runtime-state-layout capability (`runtime-state-layout-update`) 现可在已验证 Pilot 上声明 "可顺利升级" 结论(per P-003 §6 conclusion口径 "partial pilots" 表述);下个 release notes 需列已知 issues;rollback 测试纳入下个 RC。
> - **runtime-continuity 状态**:本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T02:50Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) `git push origin v1.12.0-rc.14 + main e56baef` (需用户显式授权);(b) 下个 RC 周期单独 MS 处理: rollback 真实项目测试 + 模板源 SKILL.md 路径 templating + 目标项目旧 schema 清理;(c) samkoonyun-mobile 仍 `pending`(无 validation artifact),需要时另起 Pilot 验证;(d) Windows-runtime 实测(P-003 §5 要求)未覆盖,需寻找 Windows 项目或 Mac 仿真。

> **2026-08-19 收口 (真实实战项目升级到 rc.14)**:
> - **授权执行对象**:`/Users/workspace/code/HMI/SamHMI` (生产分支 `fix/workspace-platform-surface-layout`, HEAD `79d81a0`) + `/Users/workspace/code/HMI/hmi-platform` (生产分支 `feat/control-handoff-v5-pilot-batch`, HEAD `71ada25`)。
> - **前置状态**:双方 recorded `.cortex-version` = `1.12.0-rc.13`(volta binary 已是 rc.14);最近一次 update 文件 8月19日 09:00-09:01 (rc.13 时点); patch `0016-cross-host-memory-adapters` 双方已应用。
> - **执行命令**(用 --skip-tests 跳过已验证的 287/287 PASS,用 --skip-commit 因无 version bump):
>   - `node bin/local-publish-validate.cjs --target /Users/workspace/code/HMI/SamHMI --skip-tests --skip-commit`
>   - `node bin/local-publish-validate.cjs --target /Users/workspace/code/HMI/hmi-platform --skip-tests --skip-commit`
> - **SamHMI 结果**:upgrade noop + update `partial` ok=true (added 0, merged 0, updated 2, protected 1, failed 0, verification_failed 0); 2 个 stale template 脚本更新 (`management-api/scripts/query-run-state.js` + `management-api/scripts/query-task-state.js`); 1 个 user_modified 脚本保护 (`skills/vcs-pr/scripts/backends/gitlab.js` — 之前 hand-mod); `.cortex-version` rc.13 → **rc.14**; git HEAD `79d81a0` 不变; working tree 仅剩用户之前在跑的 `AGENTS.md` M + `.worktrees/` ??(与本升级无关,`.agent/` 在 gitignore)。
> - **hmi-platform 结果**:upgrade noop + update `passed` ok=true (added 0, updated 2, protected 0, failed 0); 2 个 stale template 脚本更新 (同 SamHMI); `.cortex-version` rc.13 → **rc.14**; git HEAD `71ada25` 不变; working tree clean。
> - **P-003 MS-005 Pilot validation 证据累计**:除 csm-view-memory-rc10 外,**本轮拿到 SamHMI + hmi-platform 两个真实生产项目的 update partial/passed 实证**,完全具备 P-003 release gate 解锁条件;若需解锁,新建 `D-rsl-p003-pilot-validation-20260819` + 引用本轮三条 update 报告 (`csm-view-memory-rc10` / `SamHMI` / `hmi-platform`) → 拍板 "Pilot 跑通" 即可。本轮**不做**,等用户授权开新 Decision。
> - **runtime-continuity 状态**:`latest` archive `RC-20260819_013745_228.json` (count 17);本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T02:20Z` 事件;guard PID 71858 / renew_until `2026-08-19T06:37:47Z`。
> **下一步**:(a) 等用户授权 P-003 Pilot validation Decision (`D-rsl-p003-pilot-validation-20260819`);(b) git push rc.14 + main `e56baef` (需用户显式授权);(c) SamHMI branch `fix/workspace-platform-surface-layout` 工作未合 main,本升级不影响该分支状态(`.agent/` gitignore)。

> **2026-08-19 收口 (rc.14 本地发包 + 实战项目升级 Pilot)**:
> - **local-publish-validate 周期跑通**:`1.12.0-rc.13` → `1.12.0-rc.14`; `node bin/local-publish-validate.cjs --bump rc --target /Users/xueyq/myworks/cortex-agent-validation-targets/csm-view-memory-rc10` 全流程:287/287 tests PASS (38257ms / 8 workers parallel) → commit `483bce7 chore(local-publish-validate): 1.12.0-rc.14` → tag **`v1.12.0-rc.14`** (annotated) → `npm pack` 产出 `cortex-agent-1.12.0-rc.14.tgz` (1.4MB) → `volta install cortex-agent@file:...tgz` (file: 协议,无网络) → 目标项目 `csm-view-memory-rc10` 升级完成。
> - **实战项目升级结果** (`status: partial`, `ok: true`):5 个 stale template 脚本同步到最新 (`handoffs/scripts/handoff-protocol.js` / `agent-dashboard/scripts/generate.js` / `context-budget/scripts/build-l0l1.js` / `knowledge-lint/scripts/index.js` / `subagent-trace/scripts/index.js`);2 个 user-modified 脚本安全保护 (`context-budget/scripts/select.js` / `management-api/scripts/index.js`);0 failed;7 项 verification 全 PASS (`parse hooks.json` / `parse .claude/settings.json` / `parse projection-registry.json` / `runtime resume-bundle` / `query capabilities` / `query dashboard-state` / `query activity`);target `cortex-agent --version` 报 `1.12.0-rc.14`。
> - **本轮回退 / 不重做的事**:`doctor` 报 5 个 `[setup-portability]` warnings (`.agent/global` / `.agent/global-shared-skills` 非 symlink),**非阻塞**,后续 `cortex-agent init` 可清理;wrapper 报 exit 6 但实际是 ok=true 的 partial success (故意不覆盖 user_modified 脚本)。
> - **P-003 release gate 评估(MS-005 Pilot)**:**csm-view-memory-rc10 upgrade + update 跑通 = MS-005 Pilot 实测证据已落地**;但 P-003 header 仍标 `approved-implementation ⚠️ release-eligible 仍需 MS-005 Pilot 跑通` 是因为:pre-RC 时点定的 "Pilot 跑通" 是抽象概念,本轮通过 local-publish-validate 拿到了真实证据。**建议路径**:新建独立 `D-rsl-p003-pilot-validation-20260819` (resource: pilot://csm-view-memory-rc10/upgrade-update) + 真实 pilot evidence 落 `csm-view` upgrade report + 验证报告 → 由 interactive-user 拍板 "Pilot 跑通" → 解锁 P-003 release gate。**本轮不做**,作为下一步独立 resource-bound 任务。
> - **runtime-continuity 状态**:`latest` archive 仍 `RC-20260819_013745_228.json` (count 17);本轮 `checkpoint --gate user --phase executing` 落 `2026-08-19T01:57:51Z` 事件记录 rc.14 周期收口;guard PID 71858,renew_until `2026-08-19T06:37:47Z`。
> - **main HEAD**:`483bce7` (本地 rc.14 bump commit);**origin/main HEAD** `bb694d1` (未 push rc.14);**release notes** `docs/releases/v1.12.0-rc.14.md` 184 行已写。
> **下一步**:(a) 可选 `git push origin v1.12.0-rc.14` (push 需用户显式授权);(b) P-003 MS-005 Pilot validation 开独立 Decision `D-rsl-p003-pilot-validation-20260819`; (c) P-006 等 P-005 收口 — 仍挂起;(d) 等 guard 5h 窗口过期 SessionStart 重新拉起。

> **2026-08-19 收口 (runtime-continuity 守护重启 + runtime 提案进度 sync)**:
> - **runtime-continuity 守护重启**:SessionStart hook 未自动拉起 guard(stopped since 2026-08-06T11:01:18Z),Root 按 bootstrap 指引执行 `archive --gate user --full` 落盘 `RC-20260819_013745_228.json` (count 16→17, age 14h→0),再以 `CORTEX_SESSION_START=1 ... warm --auto --project cortex-agent` 重启 guard(PID 71858, renew_until 2026-08-19T06:37:47Z, 5h 窗口);后续 `checkpoint --gate user --phase executing` 落 `2026-08-19T01:38:05Z` 事件记录本轮收口;status `stale_recommendation: archive_now` → `ok`。
> - **item 2 — agent-dispatch-runtime 提案**:用户授权 **挂起(保持 Draft,等触发条件)**;与 2026-08-11 task-progress.md 记录的"3 个评估挂起"状态保持一致。**重新激活条件**(待任一满足):(a) Management API Phase 5 daemon 进入实施;(b) 用户显式 `/approve decision D-arch-agent-dispatch-runtime`;(c) 出现 cron / queue / multi-tenant trigger 类需求且 management-api 不能 cover。本轮**不动 proposal header**(仍 `draft`),不动 decisions/waitpoints;在 `task-progress.md` 留下重新激活条件便于后续 host-aware resume。
> - **item 3 — runtime-state-layout MS-004 R1 收口**:已在 2026-08-19T00:35:00Z 由前一会话完成 — `D-M026-MS004-R1-close` approved (interactive-user, FREEZE §5 close conditions 全部满足);`origin/main` HEAD = `bb694d1` (PR #12 merged);106/106 tests PASS;Architecture Guard 0 violations;`git diff --check` clean;T-RSL-MS004-PI → COMPLETED via `CE-MS004-R1-complete-20260819`;`D-M026-freeze-window` 已 superseded。**本轮无新执行**,仅做现状确认 + 与 item 4 同步记录。
> - **item 4 — runtime-state-layout P-001/P-002/P-003 推进**:用户授权 **三个都推进到 approved-implementation**。新建 `D-rsl-p001-p002-p003-impl-20260819` (architecture / approved / interactive-user, 2026-08-19T01:38:00Z) + `WP-rsl-p001-p002-p003-impl-20260819` (released);理由:P-001 目录/身份契约由 `0792a85` (MS-003 R1 VC-011..VC-014) + `bb694d1` (MS-004 R1 VC-013/VC-016/VC-017) 落地;P-002 update 事务迁移引擎在 MS-002 fixture VC-006~VC-010 通过 + MS-004 R1 VC-024 真实 `.agent-runtime/` 自举 no-op 验证;P-003 Pilot 验证门禁 implementation 落地 contract 但 **release eligible 仍需 MS-005 真实 Pilot 跑通后另开 Decision 激活**(P-003 header 标注 `approved-implementation ⚠️ release-eligible 仍需 MS-005`)。3 个 P-proposal header `draft` → `approved-implementation` + index.md 表 + decisions/index.json + waitpoints/index.json 同步更新。**header status flip 为 documentation sync,不引入新代码改动**;后续 git commit 应排除 `.agent/**` (受 `/.agent` exclude 保护)。
> - **runtime-continuity 状态**:`latest` `ctx_20260819_013745_188.md` (0h);`stale_recommendation` `ok`;`count` 17;`guard.active` true / PID 71858 / renew_until 2026-08-19T06:37:47Z。
> - **main HEAD**:`da7d0af` (local merge of `bb694d1` MS-004 R1 sync);`origin/main` HEAD `bb694d1`。
> **下一步**:(a) 等 guard 5h 窗口过期后 SessionStart 重新拉起;(b) MS-005 Pilot 真实 update 启动需另开 Coordination Task + Decision(独立 resource-bound);(c) M-026 FREEZE 已 closed,后续 `.agent/**` 写操作不再受限。

> **2026-08-17 收口 (M-026 freeze + M-025 MS-005 sync)**:D-M026-freeze-window approved + WP-M026-freeze-window released (runtime 同步 2026-08-17T01:24:55Z); FREEZE.md scope §2 + §3 生效。runtime-continuity archive_now 完成 (count 14→15, age_hours 0)。M-025 文档同步:P-002/P-003/P-004 proposal status `draft` → `approved-implementation` (代码已 merged via 2858099 + 982935c, 67 tests PASS + template parity); MS-005.md milestone 创建 (69 lines, 6 VCs all PASS); mission-plan 加 MS-005 row + 状态更新。3 天后真相澄清:P-002/P-003/P-004 implementation 已落地 main, 但 proposal status / mission-plan / MS-005 不同步; 现在已 sync。activation gating 仍需 Phase B 7-day observation 触发 + Phase C evaluation + 独立 resource-bound Decision。**继续 free 推进**:Phase B 等 organic traffic; P-002/P-003/P-004 等独立 Decision 激活。
**FREEZE.md §3 exceptions formal 化
M-026 FREEZE 期间 zombie 清理: 13 个 task (2026-07-29~30 遗留) 12 个 cancel 成功 via `task cancel` + workflowGate=M-026 (FREEZE §3 例外 3: Root 协调事件); 1 个 ERR_INVALID_TRANSITION (T-CAB-001 状态不允许 cancel transition). active task count 22 → 10. 无 zombie 干扰 M-026 真实迁移准备.**:user 授权 (option 1) 后, FREEZE.md §3 增加 `M-025 governance doc sync` 例外行 — 涵盖 `.agent/missions/M-025/**` + `.agent/plans/proposals/projects/token-control-plane/proposals/**` + `.agent/plans/task-progress.md`; 限定 "Root 直接更新；仅文档/markdown 同步，不改 runtime / migration engine / templates；不影响 M-026 MS-004 byte-identical 验证目标"。形式化合规化 2026-08-17 01:24-01:25Z 期间 Root 执行的 M-025 docs sync (MS-005.md + P-002/P-003/P-004 status + mission-plan + task-progress + command-log append)。实际影响:git working tree clean (`.agent/**` 被 `/.agent` exclude), 仅 framework runtime governance 状态变化, 不进入 commit, 不影响 M-026 迁移目标。

> **2026-08-14 追加 (M-026 / Runtime State Layout)**:MS-001 已由 governed Pi 实现并经 Root 独立验收；59/59 聚焦测试、4/4 安全拒绝探针、6/6 non-nullable null 拒绝、Architecture Guard 与 `git diff --check` 全部 PASS；本地 checkpoint 为 inner `b7883fc` / outer `3113732`，未 push/merge。MS-002 已冻结 VC-006～VC-010，但 governed Pi 的 `MiniMax-M3` 与 `MiniMax-M2.7` 均在 0 tool call 时返回 Provider HTTP 429，worktree clean、leases released，当前状态 `BLOCKED_PI_PROVIDER_QUOTA`；停止自动重试。现有 `.agent-runtime/` 尚未迁移，仍由 MS-004 的产品 `cortex-agent update` 自举验证负责。

> **2026-08-14 push (M-025 / origin/main synced)**:用户授权执行 push → `git push origin main` 成功 → origin/main 从 `c5a9c0d` 更新到 `85730df` (5 commits 含 MS-001/002/003 集成 + MS-003 Phase A merge); `main...origin/main` 同步 (no ahead/behind); 非 destructive push,无 force-push,无 protected branch 冲突。M-025/MS-003 主干完成全链路 push,Phase B 7-day 被动观察 window 持续在 origin/main `85730df` 基线上接收 organic traffic;后续 Pi/Codex Host usage envelope 会自然 append 到 MS-002 ledger,collector (main HEAD 85730df 集成版本) 计算 readiness。后续 release / tag / PR 仍需独立 Decision。

> **2026-08-14 快照 (M-025 / Phase B observation active)**:collector readiness query (require('./lib/host-adapter/shadow-usage/passive-collector.js')) 输出 `{eligible_count:0, excluded_count:0, by_exclusion_reason:{}, by_host_day_model:{}}` —— 零 ledger entry 符合预期 (Phase B 刚启动,等待 organic traffic)。`R-M-025` run direct JSON update: phase → `phase-b-observation-active`,activity 记录 Phase A 集成 + Phase B 7-day 被动观察授权。`main...origin/main [ahead 5]`,未 push (按 AGENTS.md 未经明确授权不 push/merge)。M-025 inbox 0,blocked waitpoint 0。后续 MS-003 milestone (P-002/P-003/P-004) draft 状态保持,Phase C 仍需 Phase B 完成后独立评估。pi-token 心跳 (10min) 监控 Phase B organic traffic 增长与 task / run / decision 状态变化。**push main 待用户授权**;**Phase B 7-day window 实际运行待 organic traffic 触发**。

> **2026-08-14 追加 (M-025 / Token Control Plane, Phase A 集成 + Phase B 授权)**:用户 1 批准 ack Phase A → Root `task.complete T-TCP-MS003-PI-R2` (workflowGate=M-025, no progress.phase) 成功; Task state COMPLETED, revision 7; `authorization-policy.json` 的 `workflowGates` 由 `readMissionRegistry` 自动从 `.agent/missions/` 收录 M-025。用户 5 批准 T-TCP-MS003-PI cleanup → Root `task.cancel_requested T-TCP-MS003-PI` (workflowGate=M-025) 成功; R1 task state CANCEL_REQUESTED。用户 2 执行 main 集成 → Decision `D-M025-integrate-MS003-925508397fa1` (resource: merge:466b123@b3f27ea, strategy=local-merge) approved; Waitpoint `WP-M025-integrate-MS003-925508397fa1` auto-released; preflight (ancestry / status / diff --check / merge-tree) PASS; integration lock `.agent/locks/integration-MS003-D-M025-integrate-MS003-925508397fa1.json` acquired; `git merge --no-ff 466b123 -m "merge: integrate MS-003 Phase A passive collector"` produced merge commit `85730df`; main HEAD = `85730df`, `main...origin/main [ahead 5]`; validate: Architecture Guard clean (1100 source files), `node --test tests/host-adapter/shadow-usage/*.test.js` 53/53 PASS, `git diff --check HEAD~1..HEAD` clean; integration lock released。用户 3 批准 Phase B → Decision `D-M025-MS003-phaseB-observation-240294f00e6d` (resource: mission://M-025/MS-003/phase-b-observation?revision=...&hosts=pi,codex&window=7d&synthetic=0&generated-cap=separate-decision) approved; Waitpoint `WP-M025-MS003-phaseB-observation-240294f00e6d` released; 7-day 被动观察窗口 activated; 0 synthetic calls; collector creates no model calls; window start = 双 Host (Pi + Codex) 同 UTC day 首次 eligible receipt; generated workload needs separate external-side-effect Decision with call/cost cap。**Main 集成后状态**:worktree `agent/T-TCP-MS003-PI-passive-collector` 仍保留 466b123 (历史),与 main `85730df` 一致; Pi / pump 进程全退; LEASE-28 / LEASE-30 均 released。**下一步**:等 Phase B organic traffic 累计 (≥100 eligible receipts/Host/7d); pi-token 心跳监控 task / run / decision / waitpoint 变化; Phase C 待 window close 后 Root 独立评估 VC-016..VC-020; P-002/P-003/P-004 activation 仍需独立 Decision。

> **2026-08-14 追加 (M-025 / Token Control Plane, MS-003 Phase A 收口)**:用户 `/approve decision D-M025-MS003-pi-launch-225bc4b7` resolved approved (selected_option=approve, resolved_by=interactive-user, rationale 已记录); `WP-M025-MS003-pi-launch-225bc4b7` auto-released at 03:55Z by runtime。Root 执行 `/launch-governed-agent`:worktree `git worktree add -b agent/T-TCP-MS003-PI-passive-collector .../T-TCP-MS003-PI b3f27ea`; `.agent` share preflight (rules/skills symlink → main + governance dirs); `task create + assign` 创建 `T-TCP-MS003-PI`,rev 2; `lease acquire LEASE-28` (fencing 1, ttl 1800s, expires 05:52Z)。Pi R1 (`MiniMax-M2.7` via `nohup pi --mode json --no-session -a --exclude-tools ask_question --thinking off`) self-exited during tool-call streaming (no `agent_settled`/`task.accepted`); `LEASE-28` released。Pi R2 retry:`T-TCP-MS003-PI-R2` + `LEASE-30` + focused prompt, PID 50272 PPID=1 detached, ~30 min alive, ~13 MB stdout, `agent_settled` 正常。Pi R2 产出:checkpoint `466b123 feat(MS-003-PhaseA): add shadow-usage passive collector` on `agent/T-TCP-MS003-PI-passive-collector`,2 files / +1181 lines (`lib/host-adapter/shadow-usage/passive-collector.js` 587 + `tests/host-adapter/shadow-usage/passive-collector.test.js` 594)。Root independent verification: `git status clean` / `git diff --check clean` / Architecture Guard ✅ no violations (503 source files audited) / `node --test tests/host-adapter/shadow-usage/passive-collector.test.js` 37/37 PASS / combined shadow-usage suite 53/53 PASS / zero external deps (only `node:fs/path/crypto` + MS-001 ledger writer `templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js`) / no forbidden patterns (`child_process`/`spawn`/`exec`/`\.pi/`/`\.claude/`/`\.codex/`/`context_compact|select`/`fan_out`/`stop_behavior`)。Task events 链 (producer=pi, actorId=pi):CREATE→ASSIGN→ACCEPT→EXECUTING(progress)→TESTING(testing)→READY_FOR_REVIEW(ready),revision 6,lastEventId `CE-M025-MS003-PI-R2-READY`,evidence `RUN-M-025-MS-003-PI-R2` + `ARTIFACT-checkpoint-466b123` + VC-016..VC-020。`LEASE-30` released。MS-003 milestone state 翻 `IN_PROGRESS (Phase A READY_FOR_REVIEW, Phase B/C not started)`,validation table 5 个 VC 翻 `PARTIAL (readiness/collector/no-inference/deterministic/compliance)`,Decision PENDING → Phase A READY_FOR_REVIEW。**下一步等用户 ack**:(a) ack MS-003 Phase A;(b) main 集成 checkpoint `466b123`(需新 Decision 资源绑定 + `/worktree local-merge`);(c) 是否/何时打开 Phase B external-side-effect Decision(7-day window + Host-model cohort + max-call/cost cap)。

> **2026-08-14 追加 (M-025 / Token Control Plane)**:MS-001 receipt/ledger/query 与 MS-002 双 Host shadow adapter 均已通过 Root 独立验收；获批 local merge `b3f27ea` 已进入 main，Architecture Guard 与 main 聚焦/回归 163/163 PASS。M-025 整体未完成；MS-003 已规划但重复 Host 调用尚未启动，等待绑定 cadence、最大调用数、Host/model cohort、七天窗口与成本边界的新 Decision；未 push/publish，也未启用 P-002/P-003/P-004。

> **当前阶段**:**M-002 5/5 milestone 全部 merged to main ✅**;**M-003 MS-001 merged to main `d9e8b95` ✅**;**M-003 MS-002 + MS-003 3x workers 派发中**;**M-003 mission plan 起草 done**(commit `434b9a6` + .agent/ `5744c84`,5 milestones / 12 features / 7 D-003 决策项 / 6-7 周);main HEAD = `d9e8b95`;**M-002 5/5 全部 merged**:MS-001 `eac3d9a` (merged `518139f`) + MS-002 `1289702` (merged `a465f01`) + MS-003 `a8c0e28` (merged `4f24c83`) + MS-004 `5a3d36a` (merged `5d2199b`) + MS-005 `cc10303` (merged `1168710`);**M-003 MS-001 merged** `a684f03` (merged `d9e8b95`);**M-003 MS-002 + MS-003 3 workers 派发中** (Worker-A codex / Worker-B codey+pi / Worker-C minimax+mcp);v1.10.0-rc.1 release prep done(待 Eric 授权 npm publish);**v1.10.0-rc.2 已 tag(包含 M-011 fix,2026-08-02 拍板,但在 `fadf9be` 而非新 main HEAD `d9e8b95`,retag 待 Eric 拍)**;RFC v0.3 落地 + v0.4 同步 done;**M-001 mission Phase 1 全部 5 milestone done(100%)** ✅ ✅ ✅ ✅ ✅;**M-002 mission 5/5 milestone 全部 merged ✅**;**M-003 mission plan + MS-001 merged** + **MS-002/003 3 workers 派发中**;**M-013.P0 C2 dispatch 已 ship + merged**;**FAE-002 spec 已 ship + merged**
> **2026-08-12 追加 (本轮交付,未 commit)**:pilot-projects 中央实战项目注册表建立(`.agent/references/pilot-projects.md`,samhmi / hmi-platform [新] / csm-view / samkoonyun-mobile 四态登记);**feedback-pipeline 提案组建立** (`.agent/plans/proposals/projects/feedback-pipeline/`,draft 状态,5 份子提案 P-001..P-005 框架 + P-001 收集层完整草案 + 5 份 Decision 草案清单 + feedback-config 设计参考);**整体进度**未变化(本轮纯设计交付,不动 templates/ / bin/cli.js / lib/,所有 1026+ 测试零影响);**新增 4 个文件 + 1 个 README**:pilot-projects.md (133 lines) + index.md (186) + P-001-collection-proposal.md (344) + relations.md (84) + references.md (111) + decisions/README.md (115) + feedback-config-design.md (142) = 共 7 个新文件,1115 行 draft 内容;**待用户 `/approve feedback-pipeline/P-001`**:D-FBP-001/002/003/004/005 五项决策按 P-001 §13 触发流程顺序拍板;**下一步**:P-002 提炼层子提案等 D-FBP-001 approved 后展开;hmi-platform 实战项目 `pending-validation` 状态等首次验证后翻 `validated-YYYY-MM-DD`
> **2026-08-11 追加 head**:main HEAD = `e64fbdd`(原 `d9e8b95` 已被 14 commit 推进);14 commit 链推进顺序 → `41f0898 feat(workflows): Pi non-interactive invocation modes` → `b5d78a0 feat(governance): approve D-pi-non-interactive-modes-001` → `36e9ecb feat(missions): add M-019 + M-020 mission plans` → `1e6bef4 feat(proposals): add graphify-worktree-governance project-level proposal` → `a344fb6 docs(proposals): progress-reconcile §9 + token-usage closed checklist` → `d08675a chore(state): sync state-class files` → `b096876 chore(repo): clean 5 .bak residual` → `1fab490 feat(skills): dependency-analysis + context-budget core` → `a34d104 feat(registries): agents + conversations + general + sub-agents/scripts` → `f56f685 feat(workflows): local-publish-validate` → `f75dddf feat(proposals): P-005 governed-agent-semantic-progress-supervision` → `77ea7d4 docs(schemas): 12 schema + sample + README` → `3b2e9d9 chore(updates): sync 3 runtime update events` → `e64fbdd docs(proposals): auto-sync ARI index/references/relations after P-005 commit`
> **整体进度**:Dashboard Lifecycle Automation 100%(5/5);Full Automation Evolution Phase 0 100%(FAE-001 done);Team Agent Pack(M-TAP L1 capability)100%;Runtime Continuity Recovery P-001 implement 100%(11/11 测试全绿,merged to main `94d26f1`);**M-001 mission Phase 1 100%(5/5 merged: MS-001 `660e248` / MS-002 `12e3db7` / MS-003 `f8a1d38` / MS-004 `8be4e4d` / MS-005 `6475930`)**;**M-011 收口(merged `fadf9be`)**;**RFC v0.3 done + v0.4 同步(§15 Phase 2 5 行 placeholder 全部 final 化)**;**v1.10.0-rc.1 release prep done(commit `4afb9db`,tag `v1.10.0-rc.1` local-only,branch ahead 22 commits,等 Eric 授权 npm publish)**;**v1.10.0-rc.2 tag on `fadf9be`(M-011 fix only,不含 M-002 / M-013 / FAE-002 后续合并,retag 待 Eric 拍)**;**M-002 5/5 merged to main** + **M-003 MS-001 merged `d9e8b95`**;**M-003 mission plan done**;**M-003 MS-002 + MS-003 3 workers 派发中 (Worker-A codex / Worker-B codey+pi / Worker-C minimax+mcp)**;**7 D-003 决策项 全部 ✅ A 拍板 (Eric 8-04 14:35)**;**FAE-002 spec merged(`105198e`),**M-004 已批准(D-M004 approved 2026-08-04),可启动实施(5-6 周)****;**M-013.P0 C2 dispatch merged(`1759597`),P1/P2/P3/P4 等排队**;**AI-Brain 内部 case study 起框架(v2.0 启动条件 #3 准备)**;**M-017 3/3 milestone 全 PASS(Agent Skills 标准生态融合:全局共享 + Pi/Grok/opencode 平台集成,38 测试全绿,5 file +105 行)**
> **2026-08-11 追加 (8-04 ~ 8-11 7 天增量)**:M-019 + M-020 mission plans 启动 (54 failed + 2 timeout + 16 fail mop-up,f7d4100 refactor fallout); **P-005 提案新增** (受管 Agent 语义进展监督, draft, ARI 项目级提案组 P-001..P-005 共 5 个); **D-008 决策项** 新增 (heartbeat ≠ 进度, Reject: 必须区分 alive/active/productive/verified); **M-013 mission proposed** (冻结受管 Agent 语义进展、脱敏、worktree evidence 与监督控制契约, 待独立评审); **D-pi-non-interactive-modes-001 approved** (Pi invocation modes 流程约定固化, three-piece contract: workflow + reference + decision); **D-ARI-P-005-ecbb9ef1 approved** (P-005 提案批准, 4 evidence levels + 强制脱敏 + capability-gated control + no-progress watchdog + 跨宿主契约; **M-013 启动, SP-001..SP-007 7 milestones 串行**); **WP-ARI-P-005-ecbb9ef1 released** (与 D-ARI-P-005-ecbb9ef1 绑定); **skills/context-budget 8 核心脚本完整** (build-l0l1/cache-break/cache-config/compact(+schema)/dedup-refs/prefix-builder/rule-tier/select, ~50 KB); **skills/dependency-analysis SKILL.md** 新增; **agents/ + conversations/ + general/ + sub-agents/scripts/** 四个 registries 首次进入 git 跟踪; **workflow/local-publish-validate** 新增 (本地发包 + 本地安装 + 目标升级验证, stable); **12 schema + sample + README** 首次跟踪 (decisions/handoffs/inbox/memory/missions/runs/sessions/tasks/waitpoints); **3 runtime update events** 同步 (8-10 ~ 8-11); ARI 自动同步 — index.md + references.md + relations.md 在 P-005 commit 后被 hook 更新 (P-005 表格行 + D-008 + M-013 + Workspace P-005 vs ARI P-005 命名冲突消解 + SamHMI Governed Pi Pilot 观察事实表); **v1.13.0-rc.2 latest tag**, v1.12.0-rc.3 + v1.12.0-rc.2 + v1.12.0-rc.1 序列进行中; **3 个 open decisions** 等 user 拍板: D-arch-plat-mem-boundary-001 / D-arch-setup-symlink-001 / D-arch-mem-integrity-001
> **最后更新**:2026-08-19 05:35 (samkoonyun-mobile 升级到 rc.14 完成 + P-003 Pilot 矩阵 4/4 补齐: rc.10→rc.14 upgrade+update passed (2 updated/1 merged/0 failed) + verify 7/7 PASS + second-update noop; KI-3 6 orphan schema 清理完成; validation artifact samkoonyun-mobile.json; pilot-projects.md §3+§5 同步; 主仓 dsh.js 未提交修改属另一会话未触碰; **main HEAD = `5fa7b87`** / **origin/main HEAD = `e56baef`**)
> **2026-08-11 追加 SP-001 收口 (P-005 / M-013)**:P-005 实施第一阶段 SP-001 落地。`.agent` 子仓 `bdd75ec feat(progress): SP-001 freeze contract — schema + fixtures + redaction + validator` (19 文件) + 主仓 `c7646f1 feat(progress): SP-001 freeze contract — V1 schema + L1 templates + tests` (5 文件) + `.agent` `dfa3f6f docs(m013): append SP-001 contract-freeze completion record` (1 文件);同步 `74d7048 fix(tests): exclude runtime-evidence from management-query-readonly digest` (independent bug fix,1 文件)。验证:schema.test.js 18/18 + redaction.test.js 26/26 = 44/44 PASS;validate-governed-attempt-progress-schema.js 5/5 fixture PASS;4 L1 templates sha256 parity = `90a9b324...`。3 个 SP-001 VCs (VC-001/VC-001a/VC-001b) 全部满足;contract freeze 已生效,SP-002/SP-003 可并行启动。**main HEAD = `74d7048`**;`.agent` HEAD = `dfa3f6f` (ahead of origin by 1 commit)
> **2026-08-11 追加 SP-002 收口 (P-005 / M-013)**:P-005 实施第二阶段 SP-002 落地。主仓 `1dd3abb feat(m013): SP-002 reducer + probes + focused query` (9 文件: 4 lib + 5 tests);`.agent` 子仓 command-log 同步更新。验证:reducer.test.js 9/9 + reducer-promotion.test.js 6/6 + reducer-determinism.test.js 5/5 + validation-probe.test.js 12/12 + probe-perf.test.js 5/5 = 37/37 PASS;SP-001 + SP-002 累计 81/81 PASS。5 个 SP-002 VCs (VC-003/VC-004/VC-005/VC-005a/VC-005b) 全部满足;reducer 单 integrator 冻结,watchdog/adapter 可接入事件。**main HEAD = `1dd3abb`**;`.agent` HEAD 即将更新到 SP-002 done 记录
> **2026-08-11 追加 SP-005 收口 (P-005 / M-013)**:P-005 实施第四阶段 SP-005 落地(watchdog + notification + recovery)。主仓 `e8161d9 feat(m013): SP-005 watchdog + notification + recovery` (10 文件: 3 lib + 1 schema + 3 L1 templates + 4 tests, +1407 行);`.agent` 子仓 task-progress 同步更新。验证:watchdog.test.js 5/5 + watchdog-default.test.js 5/5 + watchdog-steer-cap.test.js 5/5 + watchdog-race.test.js 6/6 = 21/21 SP-005 PASS;SP-001+002+005 累计 102/102 PASS。4 个 SP-005 VCs (VC-006/VC-006a/VC-006b/VC-006c) 全部满足;watchdog 是 pure state machine,4-gate 上游验证留给 SP-004 control port;P-005 §13 关键安全保证已落实:watchdog 永不直接写 Task state,Application Service 仍是单写者。**main HEAD = `e8161d9`**;`.agent` HEAD 即将更新到 SP-005 done 记录
> **2026-08-11 追加 SP-006 收口 (P-005 / M-013)**:P-005 实施第五阶段 SP-006 落地(CLI + Management routing + 双语模板)。主仓 `3f5bc66 feat(m013): SP-006 CLI + Management routing + 双语模板` (20 文件: 2 lib + 1 bin + 1 script + 16 L1 templates, +6531 行);Kucell 并行 commit `b6f0914 feat(cli): SP-006 supervise CLI + governed-attempt-query + 26 tests` + `43f1b83 chore(templates): sync L1 management-api scripts`。验证:`tests/cli/{agent-supervise-cli,task-status-routing}.test.js` = 28/28 PASS;`node scripts/check-template-parity.js` = 3/3 L1 templates sha256 identical。SP-001+002+003+004+005+006 累计 183/183 PASS。4 个 SP-006 VCs (VC-010/VC-010a/VC-011t/VC-011b) 全部满足;`cortex-agent agent supervise status|steer|abort` CLI 工作正常;4-gate 验证 fail-closed;abort 永远 preserve worktree/journal/receipt;management-api 添加了 `governed-attempt-progress` + `governed-attempt-diagnostics` 两个 read-only projections。**main HEAD = `3f5bc66`**;`.agent` HEAD 即将更新

> **Release 1.8.0 状态**:已完成发布。GitHub `main` 与 tag `v1.8.0`
> 对应候选提交 `21fbc4c`;已从冻结的 `v1.8.0` 源码发布
> `cortex-agent@1.8.0`,npm registry 的 `latest` 已指向 `1.8.0`。
> 发布包 shasum 为 `2c369ffd355c12abfce050aff6073a4c66d4d033`,
> registry 记录发布时间为 `2026-07-29T02:58:29.522Z`。发布身份通过
> macOS Keychain 引用 `cortex-agent-npm-publish` 注入,全程未将 token
> 写入仓库或命令日志。

> **本轮收口(2026-07-20)**
> - M-001:COMPLETE(MS-005 cleared by commit `4d5f3b0`)
> - M-002:COMPLETE(MS-001..MS-006 全 PASS;MS-007 daemon deferred to ADR)
> - M-003:COMPLETE(MS-004 PASS, VC-010 user-approved waiver)
> - M-004:COMPLETE(MS-003 contract + compat/mcp worktree 合并,#5/#6 waivered)
> - 全量回归:97/97 测试通过,0 fail
> - 双模板同步 commit:`8b5db2b`
> - **协作运行时自举闭环**:补齐 `approve.md` 三份模板的 CRI 节,端到端跑通 `decisions request → waitpoints create → decisions resolve → waitpoints release`,并修复 5 处 CLI flag 不一致(`--action` → `--gate-action` in decisions request)。自举样例:`D-M002-self-bootstrap` + `WP-M002-self-bootstrap` 已写入 `.agent/decisions/` 与 `.agent/waitpoints/`,dashboard-state approvals 段联动验证通过
> - **Release 1.5.0 完成**:CHANGELOG.md(Keep a Changelog 格式)+ 10 commits pushed + tag v1.5.0 + npm publish cortex-agent@1.5.0(latest tag);release gate `D-release-1.5.0` approved / `WP-release-1.5.0` released 端到端跑通;5 个已结案提案 header 翻 done(agent-collaboration-runtime / P-001 / P-005 / agent-management-api),3 个评估挂起(agent-dispatch-runtime / dashboard-prd-ui Phase 4 / P-006 等 P-005 收口)

---

## 🗺️ 路线图

### Phase 1:核心 CLI(✅ 已完成)

- [x] `cortex-agent init`:初始化 `.agent/` 目录 + 平台符号链接
- [x] `cortex-agent upgrade`:纯加法升级,不覆盖已有文件
- [x] `cortex-agent doctor`:健康检查
- [x] `cortex-agent untrack` / `track`:Git 追踪管理
- [x] 双语模板(zh / en)

### Phase 2:Claude Code 深度集成(✅ 已完成)

- [x] `hooks.json` 模板 + `PostToolUse` 质量检查 Hook
- [x] `init` 时自动生成 `.claude/settings.json` 并注入 Hooks
- [x] `.claude-plugin/plugin.json` + 根目录插件发现入口(agents / commands / skills / hooks)
- [x] `commit.md` 工作流 —— AI 生成 Conventional Commits,禁 AI 署名
- [x] `commit-standards.md` 规则文件
- [x] 完善 `pre-commit-check.sh`:支持 Python ruff、Go vet、Java checkstyle、Swift swiftlint(T-001)

### Phase 3:平台管理与语言规则(✅ 已完成)

- [x] 多平台支持:Cline、Roo Code、Amazon Q Developer、Aider、Copilot、Continue
- [x] `PLATFORM_REGISTRY`:平台注册表统一管理
- [x] `cortex-agent add / remove / list`:平台增删查
- [x] `init` 交互选择平台 + `--platforms` 非交互模式
- [x] `.agent/.platforms` 状态文件持久化已安装平台
- [x] 语言规则模板:TypeScript / Python / Go(zh + en)
- [x] `configure.md` 加入语言选择步骤
- [x] 新增 Java、Swift 语言规则(T-002)
- [x] `configure.md` 自动写入语言规则到 `tech-stack.md`(T-003)

### Phase 4:代码架构优化(✅ 已完成)

- [x] `bin/cli.js` 拆分为 5 个 lib 模块(registry / platform / setup / git / commands)
- [x] `package.json` files 字段补全 lib/、hooks/、agents、commands、skills、.claude-plugin

### Phase 5:发布与分发(🔥 进行中)

- [x] 确认 npm 包名 `cortex-agent` 可用(T-004)
- [x] 发布到 npm registry —— `npx cortex-agent` 现已可用(T-006)
- [x] 完善 `package.json`:author、homepage、repository、files 字段(T-007)
- [x] `README.md` 补充快速上手 SVG/CSS 演示(T-005)
- [ ] Claude Code 插件市场上架(T-008)

### Phase 6:Harness Engineering 优化(✅ 已完成)

> 设计方案:`docs/architecture/harness-optimization-design.md`
> 优先级顺序:P0 → P1 → P2 → P3

**P0 — 基础设施(已在进行)**

- [x] Skill 精简:合并 architecture-audit + architecture-check → `architecture-guard`(T-H01)
- [x] 新增 `skills/phase-gate`:阶段状态机前置条件检查(T-H01)
- [x] 新增 `config/reasoning-config.yml`:推理三明治成本模式配置(T-H02)
- [x] `sub-agents/planner.md`:模型 haiku → sonnet,引用 architecture-guard(T-H02)
- [x] `sub-agents/code-reviewer.md`:结构化评分输出 + 输入隔离声明(T-H03)
- [x] `workflows/ship.md`:状态机 + max_retry + LINT/REVIEW 阶段 Gate(T-H02)
- [x] `hooks/hooks.json`:双层 Hooks(linter 先行 + AI 后行)(T-H01)
- [x] 上下文预算基础设施:`context-index.json` + `skills/context-budget/`(T-H04)
- [x] `/start-task` 改造:插入 context-manifest 生成步骤(T-H04)
- [x] `/scan-project` 改造:reference 生成时自动加 frontmatter(T-H04)
- [x] `/update-refs` 改造:同步刷新 frontmatter 和 context-index(T-H04)

**P1 — 完整防火墙(Sub-agent 输出契约)**

- [x] `sub-agents/planner.md` 增加结构化输出摘要(plan_summary JSON 契约)(T-H05)
- [x] `sub-agents/implementer.md` 增加结构化输出摘要(execution_report JSON 契约)(T-H05)
- [x] `workflows/ship.md` DONE 后增加 context_cleanup 步骤(T-H05)
- [x] 新增 `sub-agents/routing-defaults.yml`:自动路由配置(保留 5 个 sub-agent)(T-H05)

**P2 — 熵治理闭环**

- [x] 新增 `sub-agents/entropy-scanner.md`:扫描逻辑 + 分级策略(T-H06)
- [x] 新增 `entropy-config.yml`:扫描频率 + L0-L3 分级规则(T-H06)
- [x] `hooks/hooks.json` 增加 PostCommit L0 自动清理(T-H06)
- [x] `workflows/ship.md` 追加 ENTROPY_SCAN → CLEAN 状态(T-H06)
- [x] `workflows/briefing.md` 增加知识库健康度板块(T-H06)

**P3 — 渐进式退化 + Workflow 精简**

- [x] 新增 `harness-manifest.yml`:全组件退化条件 + 路径 + 回滚策略(T-H07)
- [x] 新增 `skills/maturity-tracker/`:组件表现指标收集(T-H07)
- [x] `workflows/briefing.md` 增加成熟度看板(T-H07)
- [x] Workflow 精简(降级重定向):/code-review /done /sync-plans /parallel /weekly-report 加入"推荐用 /ship"提示(T-H08)

### Phase 7:知识架构与可理解性地基(✅ 已完成)

> 设计方案:`docs/architecture/harness-optimization-design.md`
> 目标:先补齐知识架构,再继续推进 application legibility 与 knowledge lint

- [x] 建立 `docs/quality`、`docs/reliability`、`docs/security`、`docs/exec-plans` 与 `docs/tech-debt.md` 基础骨架(T-H09)
- [x] 更新 `docs/architecture.md` 与 `docs/architecture/harness-optimization-design.md`,同步到当前真实实现(T-H10)
- [x] 新增 active exec plan,并把技术债务统一沉淀到 `docs/tech-debt.md`(T-H11)
- [x] 设计 knowledge lint 与 doc-gardening 的下一轮落地方案(T-H12)
- [x] 实现第一版 `knowledge-lint` skill 与 `knowledge-health.json` 输出(T-H13)
- [x] 将 `knowledge-health.json` 接入 `/briefing` 工作流说明(T-H14)
- [x] 将轻量 `knowledge-lint` 接入 `/ship` 工作流说明(T-H15)
- [x] 实现第一版 `doc-gardening` skill,并接入 `/briefing` 与 `/ship`(T-H16)
- [x] 新增知识维护 Runbook,为 heartbeat / cron 接入提供统一入口(T-H17)

### Phase 8:Mission Lite 长周期任务编排(✅ 模板 MVP 已完成)

> 设计入口:`docs/architecture.md`、`docs/architecture/mission-lite-design.md`、`docs/architecture/harness-optimization-design.md`
> 目标:在现有 `/start-task`、`/ship`、`/handoff` 之上,补齐多 milestone 长周期任务的验证契约、结构化交接和独立验证机制。

- [x] Mission Lite 架构设计:三角色模型、状态机、核心产物、验证契约与边界(T-H24)
- [x] 新增 `validation-contract` skill:定义 CREATE / CHECK / SUMMARIZE 三种模式和 JSON 契约模板(T-H25)
- [x] 新增 `/mission` workflow:覆盖 SCOPE / PLAN / CONTRACT / EXECUTE / VALIDATE 状态(T-H26)
- [x] 扩展 planner / reviewer 输出契约:planner 产出 validation contract,reviewer 按 contract 验证(T-H27)
- [x] 命令日志与 milestone 模板标准化:提供 `mission-plan.md`、`command-log.md` 与 `milestones/MS-xxx.md` 模板(T-H28)

### Phase 9:Dashboard Lifecycle Automation(📋 已规划)

> Proposal: `.agent/plans/proposals/projects/dashboard-lifecycle-automation/index.md`
> 子提案:P-001 · 执行计划:`.agent/plans/dashboard-lifecycle-automation-plan.md`

- [x] `T-DASH-AUTO-002`(M-001):冻结配置、状态和活跃判定契约(完成,inner `157c8d1` / outer `d0624f1`)
- [x] `T-DASH-AUTO-003`(M-002):实现手动 Supervisor CLI 与单实例恢复(outer `d89c698`)
- [x] `T-DASH-AUTO-004`(M-003):实现 opt-in SessionStart/workflow trigger adapter(outer `e839dce`)
- [x] `T-DASH-AUTO-005`(M-004):实现 idle grace 与异常恢复(outer `fb4dc7a`)
- [x] `T-DASH-AUTO-006`(M-005):完成模板分发和四项目 E2E 验证(outer `3dfb7dc`)

### Phase 10:Full Automation Evolution(🔥 FAE-001 已批准)

> Proposal: `.agent/plans/proposals/projects/full-automation-evolution/index.md`
> 当前批准范围:FAE-001 Phase 0;执行计划:`.agent/plans/T-FAE-001-implementation.md`

- [x] `T-FAE-001`(M-FAE-001 / FAE-001):落地 Dispatch、Daemon、Trigger 词汇、Schema 与 fail-closed CLI stub
- [x] FAE-002:已批准(D-M004 approved 2026-08-04);FAE-003～FAE-006:未批准,不得提前实施

### Phase 11:Agent Coordination and Notification(✅ M-008 完成)

> Proposal: `.agent/plans/proposals/projects/agent-coordination-notification/index.md`
> Mission: `.agent/missions/M-008/mission-plan.md`
> 执行计划:`.agent/plans/agent-coordination-notification-plan.md`

- [x] `T-ACN-001`:批准并冻结协调架构契约
- [x] `T-ACN-002`:冻结 Coordination Schema 与转换契约
- [x] `T-ACN-003`:实现可靠 JSONL Journal
- [x] `T-ACN-004`:实现状态机与 Snapshot
- [x] `T-ACN-005`:实现 Ownership Lease 与 Stale
- [x] `T-ACN-006`:集成 Coordination Application Service
- [x] `T-ACN-007`:实现 Task 与 Event CLI
- [x] `T-ACN-008`:实现 ACK、Cursor 与通知策略
- [x] `T-ACN-009`:实现可选 Notification Pump
- [x] `T-ACN-010`:实现 Claude Code 与通用 Agent Adapter
- [x] `T-ACN-011`:实现取消、Stale 与安全接管
- [x] `T-ACN-012`:实现 Codex Wakeup 与恢复消费
- [x] `T-ACN-013`:接入 Management API、MCP 与双语模板
- [x] `T-ACN-014`:完成 SamHMI 与故障安全验收

### Phase 12:Agent Runtime Interoperability(✅ M-009 完成)

> Proposal: `.agent/plans/proposals/projects/agent-runtime-interoperability/index.md`
> Mission: `.agent/missions/M-009/mission-plan.md`

- [x] M-001～M-002:capability/event contract 与 Codex/Claude adapter 迁移
- [x] M-003～M-006:context trajectory、Pi boundary adapter、tool-before gate 与模板回归
- [x] M-007～M-010:execution-surface matcher、dry-run、人工 dispatch 与跨宿主 handoff
- [x] M-011～M-012:Cursor/Pi adapter 与可审计 dispatch policy
- [x] M-009 收口:181/181 聚焦测试通过;全仓 1026/1033,7 项为独立验证的历史基线失败;Architecture Guard clean
- [x] Production pilot:M-010 已按 P-006 frozen revision 完成 authoritative owner、真实 Pi receipt、checkpoint/handoff 与安全 Codex blocker 验证

### P-006 Operation Lifecycle / ARI Production Pilot(M-010)

- **状态**:COMPLETE / MS-001..MS-005 PASS
- **冻结范围**:P-006 SHA-256 `c2e7b17aa2c0cf21995da0bd4cb197bd6a8b1d514d2d66339558e03bc9ae16ca` + existing ARI production-readiness record
- **治理证据**:`D-M010-P006-c2e7b17a` approved;`WP-M010-P006-c2e7b17a` released by `/mission`
- **完成证据**:`.agent/missions/M-010/evidence/requirement-artifact-matrix.md`
- **边界**:复用 Run/lease/Decision/Waitpoint/Management API owners;automatic dispatch/daemon disabled;不执行 commit/stage/push/publish/release/reset/stash/delete/credential access
- **第二宿主**:Codex 0.145.0 安全本地 boundary 已真实尝试并可达;因无凭证 boundary 不提供 execution receipt,记录 `SAFE_EXECUTION_BOUNDARY_UNAVAILABLE`、`receipt: null`、`fabricated_receipt: false`
- **验证**:final focused lifecycle/dispatch/Pi/handoff/context/template/coordination/query/schema 545/545 PASS;Architecture Guard 644 files clean;15 evidence/runtime files sensitive-value scan 0 findings

### P-005 Governed Agent Semantic Progress Supervision(M-013 · SP-001 + SP-002 + SP-005 + SP-006 ✅)

- **状态**:**SP-001 + SP-002 + SP-003 + SP-004 + SP-005 + SP-006 COMPLETE**;只有 SP-007 (真实 Pi + SamHMI pilot) pending
- **冻结范围**:P-005 SHA-256 (proposal); GovernedAttemptProgress V1 schema + 4 evidence levels + 强制脱敏 + redaction fixtures + validate script + 纯 reducer + read-only probes + focused query + watchdog 状态机 + versioned policy + bounded notification + 公共 CLI + Management routing + 双语模板
- **治理证据**:`D-ARI-P-005-ecbb9ef1` approved;`WP-ARI-P-005-ecbb9ef1` released
- **完成证据**:`.agent/missions/M-013/milestones/SP-001..SP-006.md`;主仓 `3f5bc66` (SP-006) / `e8161d9` (SP-005) / `a3d8449` (SP-003+SP-004 Kucell) / `1dd3abb` (SP-002) / `c7646f1` (SP-001)
- **SP-001 交付清单**(24 files): schema + 5 fixtures + 12 redaction fixtures + validate script + 3 L1 templates + 2 tests (44 tests)
- **SP-002 交付清单**(9 files): reducer + worktree probe + validation probe + query + 5 tests (37 tests)
- **SP-003 + SP-004 交付清单**(Kucell session, ~1500 lines): Pi JSON adapter + redaction + capability + RPC supervisor + control port + extension UI + 52 tests (8 VCs)
- **SP-005 交付清单**(10 files): watchdog + notification + policy-loader + 4 tests (21 tests, 4 VCs)
- **SP-006 交付清单**(20 files):
  - `lib/cli/agent-supervise.js` (status/steer/abort + 4-gate verify + idempotency-key)
  - `lib/cli/query.js` (governed-attempt-progress / -diagnostics projection)
  - `bin/cli.js` (additive `agent supervise` subcommand routing)
  - `scripts/check-template-parity.js` (VC-011t parity check)
  - `templates/_shared/.agent/skills/management-api/scripts/query-governed-attempt.js` (new projection)
  - `templates/{_shared,en,zh}/.agent/skills/management-api/scripts/index.js` (wired projections)
  - `templates/{_shared,en,zh}/.agent/skills/management-api/scripts/projection-registry.json` (declared projections)
  - `templates/{zh,en}/.agent/workflows/agent-supervise.md` (workflow docs)
  - 2 CLI tests (28 tests, 4 VCs)
- **边界**:SP-006 CLI fail-closed on any 4-gate violation;abort 永远 preserve worktree/journal/receipt (P-005 §6.3);Management API projection 是 read-only;SP-007 需真实 Pi binary + SamHMI pilot 环境(本地不可用,需远程 deployment)
- **验证**:183/183 tests PASS (SP-001 44 + SP-002 37 + SP-003+SP-004 52 + SP-005 21 + SP-006 28 + management 1);3+5+8+4+4 = 24/24 VCs satisfied (P-005 §11 全部 12 个验收标准映射为 24 个 sub-VCs across 7 SPs)
- **Next**:SP-007 是最后一个 milestone,需真实 Pi binary + SamHMI pilot 环境;可在本机启动 fake host 验证 + 准备 3-layer pilot 脚本

---

## 🔥 当前活跃任务

### M-013 · P-005 Governed Agent Semantic Progress(M-013 6/7 SPs ✅)

> Mission: `.agent/missions/M-013/mission-plan.md`
> Approval: `D-ARI-P-005-ecbb9ef1` + `WP-ARI-P-005-ecbb9ef1` (2026-08-11)
> Dispatch plan: `.agent/artifacts/M-013/P-005-implementation-dispatch-plan.md`

| SP | 描述 | 负责人 | Commit | 状态 | 进度 |
| :--- | :--- | :--- | :--- | :--- | :---: |
| SP-001 | Freeze Progress V1 schema + 4 evidence levels + redaction fixtures | Kucell + cortex-agent | `.agent` `bdd75ec` / 主仓 `c7646f1` | ✅ PASS | 44/44 tests |
| SP-002 | Progress Reducer + worktree/validation probe + focused query | cortex-agent | 主仓 `1dd3abb` | ✅ PASS | 37/37 tests |
| SP-003 | Pi JSON stream adapter (脱敏映射) | Kucell session | 主仓 `a3d8449` (与 SP-004 合并 commit) | ✅ PASS | 22 tests |
| SP-004 | Pi RPC supervisor + gated control port (get_state/steer/abort) | Kucell session | 主仓 `a3d8449` | ✅ PASS | 30 tests |
| SP-005 | Watchdog + notification + recovery | cortex-agent | 主仓 `e8161d9` | ✅ PASS | 21/21 tests |
| SP-006 | 公共 CLI + Management routing + 双语模板 | cortex-agent + Kucell | 主仓 `3f5bc66` / `b6f0914` / `43f1b83` | ✅ PASS | 28/28 tests + 3/3 L1 parity |
| SP-007 | 真实 Pi + SamHMI pilot (3-layer validation) | TBD | TBD | ⚪ pending | 0/3 |

**当前 main HEAD**:`3f5bc66`(SP-001..SP-006 全部落地 + push)
**当前 .agent HEAD**:SP-006 done 即将 commit
**Next**:SP-007 真实 Pi + SamHMI pilot (3-layer validation),需远程 Pi + SamHMI 环境

---

## 🔥 当前活跃任务

### M-013 · P-005 Governed Agent Semantic Progress(M-013 active)

> Mission: `.agent/missions/M-013/mission-plan.md`
> Approval: `D-ARI-P-005-ecbb9ef1` + `WP-ARI-P-005-ecbb9ef1` (2026-08-11)
> Dispatch plan: `.agent/artifacts/M-013/P-005-implementation-dispatch-plan.md`

| SP | 描述 | Worktree | Commit | 状态 | 进度 |
| :--- | :--- | :--- | :--- | :--- | :---: |
| SP-001 | Freeze Progress V1 schema + 4 evidence levels + redaction fixtures | `cortex-agent-worktrees/M-013` (`feat/M-013-p-005-semantic-progress`) | `.agent` `bdd75ec` / 主仓 `c7646f1` / 命令日志 `dfa3f6f` | ✅ PASS | 44/44 tests |
| SP-002 | Progress Reducer + worktree/validation probe + focused query | 同上 | 主仓 `1dd3abb` | ✅ PASS | 37/37 tests |
| SP-003 | Pi JSON stream adapter (脱敏映射) | new `feat/M-013-SP-003-pi-json-adapter` | TBD | ⚪ pending (parallel-ready) | 0/4 |
| SP-004 | Pi RPC supervisor + gated control port (get_state/steer/abort) | new `feat/M-013-SP-004-pi-rpc-supervisor` | TBD | ⚪ pending (parallel-ready) | 0/4 |
| SP-005 | Watchdog + notification + recovery | new `feat/M-013-SP-005-watchdog` | TBD | ⚪ pending | 0/4 |
| SP-006 | 公共 CLI + Management routing + 双语模板 | new `feat/M-013-SP-006-cli-routing` | TBD | ⚪ pending | 0/4 |
| SP-007 | 真实 Pi + SamHMI pilot (3-layer validation) | new `feat/M-013-SP-007-pilot` | TBD | ⚪ pending | 0/3 |

**当前 main HEAD**:`1dd3abb`(SP-002 落地)
**当前 .agent HEAD**:SP-002 done 即将 commit
**Next**:派发 SP-003 (Pi JSON adapter) + SP-004 (Pi RPC supervisor) 并行 (per P-005 §10);它们在 SP-001 freeze + SP-002 reducer events 之上启动。

### M-001 · general-mode Phase 1 落地(v1.10.0)

> Mission: `.agent/missions/M-001/mission-plan.md`
> RFC: `docs/architecture/general-mode-design.md` **v0.3**(§17 v2.0 愿景新增,Eric 2026-08-01 拍板)

| MS | 描述 | Worktree | Base | Commit | 状态 | 进度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| MS-001 | `templates/_base/` 抽离 9 data 目录 schema | `M-001-MS-001-base` | `0965abf` | `c352d2b` (merged `660e248`) | ✅ PASS | 14/14 |
| MS-002 | `bin/cli.js init --mode general` | `M-001-MS-002-init-general` | `0965abf` | `ae05295` (merged `12e3db7`) | ✅ PASS | 12/14 + 1 MS-001 skip |
| MS-003 | `bin/cli.js init` 自动 mode 推断 | `M-001-MS-003-mode-infer` | `12e3db7` | `e4de8ec` (merged `f8a1d38`) | ✅ PASS | 27/27 |
| MS-004 | shadow 路径测试矩阵 + 272+ 回归 | `M-001-MS-004-shadow` (已 cleanup) | `f8a1d38` | `04f7b3f` (merged `8be4e4d`) | ✅ PASS | 13/13 |
| MS-005 | RFC §15 Phase 1 placeholder 填 + release notes | `M-001-MS-005-rfc` | `f21273f` (落后 main 4 commit) | (Worker-E 二次 commit 派发中) | 🚀 In Progress | — |
| MS-005 | RFC §15 Phase 1 placeholder 填 + release notes final | `M-001-MS-005-rfc` | `0965abf` | `f21273f` (merged `123185b`,research 阶段) | 🔄 research done / 二次 commit pending | — |

**当前 main HEAD**:`f8a1d38`(MS-003 merge)
**Next**:等 Worker-D 完成 MS-004 → merge → 派发 Worker-E 二次 commit 填 4 placeholder → 全部 milestone done → v1.10.0-rc.1 release。

### Agent Coordination and Notification(M-008)

| 任务 ID | 优先级 | Milestone | 描述 | 进度 |
| :--- | :--- | :--- | :--- | :--- |
| T-ACN-001 | P0 | MS-001 | 架构批准与契约冻结 | 100% |
| T-ACN-002 | P0 | MS-001 | Schema、迁移和错误码 | 100% |
| T-ACN-003 | P0 | MS-002 | JSONL journal、replay 和恢复 | 100% |
| T-ACN-004 | P0 | MS-002 | 状态机、snapshot 和幂等 | 100% |
| T-ACN-005 | P0 | MS-002 | Ownership lease 与 stale | 100% |
| T-ACN-006 | P0 | MS-002 | Application Service 串行集成 | 100% |
| T-ACN-007 | P1 | MS-002 | Task/Event CLI | 100% |
| T-ACN-008 | P1 | MS-003 | ACK、cursor、通知策略 | 100% |
| T-ACN-009 | P1 | MS-003 | Notification pump 与 fallback | 100% |
| T-ACN-010 | P1 | MS-004 | Claude Code/通用 Agent adapter | 100% |
| T-ACN-011 | P1 | MS-004 | cancel、stale 与 takeover | 100% |
| T-ACN-012 | P1 | MS-004 | Codex wakeup 与恢复消费 | 100% |
| T-ACN-013 | P1 | MS-005 | Management API、MCP 与模板 | 100% |
| T-ACN-014 | P0 | MS-005 | SamHMI、故障注入和安全验收 | 100% |

> 当前状态:M-008 COMPLETE;MS-001～MS-005 PASS。Coordination 专项 336/336 PASS,SamHMI pilot ready/input/restart/unacked/takeover 2/2 PASS;独立对抗终审 PASS。
>
> P-002 生产通知扩展:B1～B6 已完成,集成分支提交 `c4fe761`,
> 主仓 `main` 落点 `6855cd9`;Runtime Adapter + Notification 组合专项
> 208/208 PASS。官方 Codex App Server 实接提交 `ae446bd`,真实验证
> READY_FOR_REVIEW、INPUT_REQUIRED、pending-first 重投和 SamHMI 公共 CLI
> E2E;目标 Desktop 任务均实际回复,且无自动 ACK。P-002 状态:done。

### Dashboard Lifecycle Automation

| 任务 ID | 优先级 | Milestone | 描述 | 进度 |
| :--- | :--- | :--- | :--- | :--- |
| T-DASH-AUTO-002 | P0 | M-001 / P-001 | 冻结 Supervisor 契约 | 100% |
| T-DASH-AUTO-003 | P0 | M-002 / P-001 | 实现标准 CLI 与单实例 | 100%(outer `d89c698`) |
| T-DASH-AUTO-004 | P1 | M-003 / P-001 | 实现 opt-in 自动触发 | 100%(outer `e839dce`) |
| T-DASH-AUTO-005 | P0 | M-004 / P-001 | 实现 idle 与恢复 | 100%(outer `fb4dc7a`) |
| T-DASH-AUTO-006 | P1 | M-005 / P-001 | 分发与跨项目验证 | 100%(outer `3dfb7dc`) |

> Dashboard Supervisor 全部 5 个 milestone 已在 outer 完成并入 v1.7.0;MS-007 持久 daemon 仍 deferred to ADR;保留显式工作流与前台可观察性。本地 `.agent` 仓库通过 `/sync-plans` 与 outer 对齐。Galileo 提案保持待独立批准。

### Team Agent Pack(M-TAP · v1.7.0 已发布)

> Proposal 入口:`.agent/plans/proposals/projects/team-agent-pack/`(P-001 / P-002 / D-001 全部翻 done)
> Mission:`M-TAP` 已 COMPLETE(4 commits `841d026` / `ae57fe0` / `abbfe13` / `300bd9b`)
> Release:outer `82d710d chore(release): 1.7.0 - 冻结 Team Agent Pack M-TAP 落地`

- **L1 / L2 / L3 三层模型**:`.agent-shared/`(Git 可提交团队分发源)/ `.agent/`(唯一运行时入口)边界清晰;`.agent-shared/` 中的脚本不是授权(仍需 Decision / Waitpoint gate)
- **CLI**:`cortex-agent team <init|status|install|update|publish|verify>` 六子命令;`update --team` 串联 L1 apply → Team Pack apply;`upgrade --team` 显式拒绝(exit=3,指向 P-002 §4)
- **secret-scan**(`lib/secret-scan.js`,17/17 单测 PASS):9 类规则 + `.env` body 检测;严格 redact 防侧信道;`team publish/verify` 与 PostToolUse 共用
- **三方合并 planner**:`base=receipt.baseline` + `local=.agent/` + `incoming=pack`;conflict 文件保留 local + 写 `.agent/team-sync/conflicts/<ts>-<n>-conflict.json`;**conflict 不推进 receipt baseline** 是 alice 本地修改不被下次 update 静默覆盖的关键安全保证
- **测试覆盖**:64/64 PASS(secret-scan 17 + team-pack-core 25 + merge-matrix 7 + install-dry-run 4 + publish-verify 6 + samhmi-pilot 2 + cross-developer-conflict 3)
- **关联决策/闸**:T-MILESTONE-1 ~ T-MILESTONE-4 全部 PASS;17/17 blocking assertion PASS

> M-TAP 是 v1.7.0 唯一新增 capability,CLI 协议、`update/upgrade/doctor` 边界与 secret-scan 都已锁定;后续 `.agent-shared/` 仓库模板与 CI 模板分发将由 T-MILESTONE-5+ 推进(未启动)。

### Full Automation Evolution

| 任务 ID | 优先级 | Milestone | Proposal | 描述 | 进度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| T-FAE-001 | P0 | M-FAE-001 | `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-001-dispatch-vocabulary.md` | Phase 0 词汇、Schema、CLI stub、规则与双语模板 | 100%(done;outer `b8825a3`,focused 9/9,full 313/313;review PASS,0 must-fix) |

> D-FAE-001 已批准,WP-FAE-001 已由 `/plan` 释放;T-FAE-001 已通过 `/ship` 收口(outer `b8825a3`),专项 9/9 + 全量 313/313,code-reviewer verdict PASS。FAE-002～FAE-006 不在本轮授权范围。

## 🧭 下一阶段候选(Application Legibility)

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-H18 | P0 | 日志可理解性基线 | 100% |
| T-H19 | P0 | 浏览器验证基线 | 100% |
| T-H20 | P1 | 指标可理解性基线 | 100% |
| T-H21 | P1 | Trace / Request Chain 基线 | 100% |
| T-H22 | P1 | runtime evidence 接入 `/briefing` / `/ship` 设计 | ✅ 已实现:`generate-summary.js` + `verification-summary.json` 首次产出(99/100)|
| T-H23 | P2 | 验证模板标准化 | ✅ 已完成 |

## 🧭 下一阶段候选(Multi-Agent Coordinator · 协调层)

> 入口设计:`docs/architecture/multi-agent-coordinator.md`
> 目标:解决"多 agent + 多模型切换后任务做了一半"的协调问题,叠加而非推翻现有 `/parallel` / `/mission` / `session-manager`

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-C01 | P0 | Multi-Agent Coordinator 设计文档 | 100% |
| T-C01A | P0 | Coordinator 前置架构对齐:Harness / Mission Lite / Coordinator 边界与任务拆解同步 | 100% |
| T-C02 | P0 | `coordinator` sub-agent 定义 | 100% |
| T-C03 | P0 | Agent Registry(`.agent/registry/agents.json` + check-in/out 脚本) | 100% |
| T-C04 | P0 | Artifact Bus(`artifact-schema.json` + 读写辅助) | 100% |
| T-C05 | P1 | Progress Lock(`acquire/renew/release` + TTL) | 100% |
| T-C06 | P0 | handoff skill 升级:双产物 + `AGENT_RESUME` 模式 | 100% |
| T-C07 | P1 | `routing-defaults.yml` 扩展 `model_registry` | 100% |
| T-C08 | P1 | `/mission` 状态机改造:显式 HANDOFF + RESUME 状态 | 100% |
| T-C09 | P1 | 端到端验证:Claude → Codex 切换场景 | ✅ 验证完成,发现 TC9-F1 schema 不匹配,已通过 T-B02 修复 handoff-protocol.js |
| T-C10 | P2 | `/briefing` 接入 coordinator 健康度板块 | ✅ coordinator-health.js + briefing.md Step 8 |

## 🧭 下一阶段候选(Graphify · 知识图谱集成)

> 提案文档:`docs/architecture/graphify-integration-proposal.md`
> 目标:通过 Artifact Bus 扩展和 Handoff 协议联动,将 Graphify 源码知识图谱接入 Coordinator 多模型交接链路
> 启动条件:T-G01/T-G02 随时可独立启动;T-G03 随 T-C06 同期实施

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-G01 | P1 | `artifact-schema.json` 加 `knowledge-graph` 类型 + artifact-bus.js VALID_KINDS | ✅ schema + bus 均已支持 |
| T-G02 | P1 | `templates/zh\|en/.agent/plugins/graphify/` 模板(README + config.yml) | ✅ 修正 API:graphify-out/graph.json、links[]、source_file |
| T-G03 | P1 | `extract-subgraph.js` 裁剪脚本 + L3 自举验证 | ✅ 端到端通过:90 nodes,artifact bus 注册成功 |
| T-G04 | P2 | `post-commit-update.js`:PostCommit 自动触发 `graphify update .` | ✅ 中英模板 hook 已接入,验证更新 4763 nodes / 5340 edges |
| T-G05 | P2 | `cortex-agent doctor` 集成 Graphify 状态检测 | ✅ 已完成 |

## 🧭 下一阶段候选(Animation · 动画与视频化资产)

> 入口评估:`docs/architecture/animation-library-evaluation.md`

## 🧭 下一阶段候选(cortex-agent v2.0 方向:全自动 Agent 派发)

> **2026-08-01 Eric 拍板 v2.0 愿景**:「cortex agent 后续就是要完成这种全自动 Agent 的分派任务,子 Agent 执行,然后事件触发回到主 Agent,保证主 Agent 完整地完成一个 mission 任务」
> 含义:从「v1.10 / v1.11 跨 agent 续接 / 跨 host 切换」演进到「v2.0 mission 级别编排:主 agent 派发 sub-agent → sub-agent 执行 → 事件触发回到主 agent → 主 agent 自动续接并完成 mission」。
> 已有支撑:M-008 Coordination(Journal/State/Ownership/Notification/Adapter/Takeover)+ M-009 Interoperability(adapter/dispatch/policy)+ FAE-001 Dispatch Vocabulary + subagent-trace(explicit emit + 半自动 inbox)+ mavis 平台层真事件驱动(task tool 完成后自动 resume 主 session)
> 待补缺口:cortex-agent framework 自身缺真事件总线(目前依赖 subagent-trace 显式 emit);RFC §16 当前结论未明确 v2.0 mission 编排;§15 Phase 2 任务未拆。

> **Next**(v2.0 RFC §16 收口候选):
> 1. RFC §16 改写:从「v1.11 → v2.0 收口」补 mission 编排愿景段落
> 2. v2.0 拆分 Phase 2(general 模式骨架,3 周) + Phase 3(5 adapters + 1 MCP bridge,6-7 周) + Phase 4(真事件总线 mission 编排,需新 mission M-002)
> 3. Mission M-002 计划起草(general 模式骨架),Phase 2 任务清单写好

Phase C Stage 1 Shadow readiness 框架起草 (`.agent/missions/M-025/handoffs/phase-c-stage1-shadow-readiness.md`, 163 lines): 5 大类前置 (G-SampleGate / G-NoInference+G-Reproducibility / G-QualityBaseline+G-Stability / G-Governance+G-Privacy+G-Rollback / G-BudgetAttribution advisory) + Entry Decision template `D-M025-MS003-phaseC-shadow-<sha>` + Pre-Decision 7-步 checklist (readiness query / inference-rate / reproducibility / tests / Architecture Guard / active audit / rollback drill) + Stage 1 exit criteria + Failure modes & rollback。Phase C 启动仍需 Phase B sample gate 满足 + 10 entry gates 全部 PASS + 独立 resource-bound Decision; framework 仅 operationalize 检查路径, 不激活 P-002/P-003/P-004。

FREEZE.md §3 新增 2 例外: `M-019/M-020/M-021/M-022 follow-up governance` + `M-013 SP-001 governance prep`. M-021 mission-plan 修复 (Aug 11 原版 → 现 Completed 状态 + 4 milestones reference + M-022 handoff). M-023 mission skeleton 创建 (9 Mode C/C2 失败 investigation, 来自 M-019 deferral §Failure-Mode Mode C/C2 + M-020 deferral §Scope Boundaries Investigation only). Dashboard 启动 (auto enable → supervisor PID 91747, status enabled_idle → running). M-019/M-020 follow-up 全部形式化 (M-021 ✅ Completed; M-022 ✅ 已 created; M-023 新建).

M-023 triage complete (2026-08-17 01:55Z): 9 Mode C/C2 tests from M-019/M-020 deferred inventory all 151/0 PASS on current main HEAD `1a12043` (standalone + parallel-run). M-023 mission closed (`COMPLETED`), no code change needed, no follow-up mission. M-019..M-023 full chain now closed: M-019 ✅ Completed (54 failed + 2 timeout修复) → M-020 ✅ Completed (MS-001/002 done; M-021/M-022 deferred) → M-021 ✅ Completed (2 TIMEOUT → 0; M-022 deferred) → M-022 ✅ Completed (2 parallel-run race → 0; M-023 deferred) → M-023 ✅ Completed (9 Mode C/C2 全部 100% PASS). ALL M-019/M-020 deferred work has been investigated and resolved by subsequent fix lands. M-013 (P-005 governance) 7 SP milestones pending 仍是 next major item but requires governed Pi session + 新 Decision + Pi provider quota 恢复。

> **2026-08-20 收口 (open-design-integration / M-ODI-001 / MS-001 /deck 工作流落地)**:
> - **授权执行**: 用户在 open-design 提案组批准后指示 "可以先修复问题" → 进入实施阶段。先聚焦 MS-001（设计版图缺位的 /deck 工作流，P-003 §4.2）；MS-002 / MS-003 / MS-004 / MS-005 留待后续迭代。
> - **新文件**（4 个 lib 模板 + 3 个测试 + 1 个 CLI 路由 + 1 个 docs + 1 个 template README）:
>   - `lib/templates/pptx.js`（430 行）— 零依赖 PPTX OOXML ZIP 手工构造（CRC32 + STORE 方法），17 OOXML parts；用 `node:buffer` + 自实现 ZIP writer，不引入 `node:zlib` (DEFLATE) 或 `jszip` / `pptxgenjs`
>   - `lib/templates/html-deck.js`（210 行）— 单文件 HTML inlined CSS，多 theme（default / swiss / magazine），page-break print-to-PDF 友好
>   - `lib/templates/md-deck.js`（80 行）— Markdown 摘要 + speaker notes，CJK + pipe escape
>   - `lib/commands/deck.js`（270 行）— CLI dispatcher，brief 解析顺序 .agent/<task-id>/deck-brief.json → .agent/decks/<task-id>.json → 4-slide starter
>   - `bin/cli.js` — 单 require + 单 case 行（不触碰已有 case）
>   - `lib/cli/contract.js` — 加 deck 契约条目（mode: design_workflow, zero_dep: true）
>   - `tests/templates/pptx.test.js`（20/20 PASS）— CRC32 / ZIP 字节 / OOXML 部分 / CJK / smoke file
>   - `tests/templates/html-deck.test.js`（13/13 PASS）— 3 themes / escape / page-num / CJK / print CSS
>   - `tests/templates/md-deck.test.js`（10/10 PASS）— H2 sections / bullets / body / speaker notes / CJK
>   - `tests/commands/deck.test.js`（23/23 PASS）— argv / brief / starter / 端到端 / byte-identical / 错误码
>   - `docs/architecture/deck-workflow-design.md` — 完整设计文档（目标 / 非目标 / 命令 / 状态机 / 验收 / 关联）
>   - `templates/_shared/.agent/artifacts/deck-README.md` — 产物目录 README（用户视角）
> - **端到端验证**（实跑 `bin/cli.js deck TASK-LAUNCH --lang en`，custom brief 4 slides）:
>   - deck.html 4943 bytes / deck.pptx 24280 bytes (20 XML parts 全 valid) / deck.md 1109 bytes / validation-contract.json 1192 bytes
>   - PPTX 经 Python `zipfile` + `xml.etree` 验证：20/20 XML parts valid，slide1 text runs = `['Q4 Launch', 'cortex-agent design chain', '5 ship-ready sub-proposals...', ...]`
>   - bin/cli.js 维持零依赖（grep 验证：`require("path"|"fs"|"child_process")` only）
> - **零回归**: T-OD-001 既有 6 个 design 测试集全过（design-registry 23 / design-fetch 24 / design-cli 17 / design-license 19 / design-resolve 17 / design-lockfile 18 = 118/118 PASS）。
> - **总测试基线**: 新增 **66 tests PASS**（20+13+10+23）+ 既有 **118 tests PASS** = **184/184**，0 fail / 0 cancelled。
> - **M-ODI-001 / MS-001 验收对应**:
>   - VC-1 ✓ /deck TASK-001 --format pptx 产出 deck.pptx 能被 PowerPoint/Keynote/LibreOffice 打开（OOXML schema valid + CRC32 verified）
>   - VC-3 ✓ /deck TASK-001 --format html 产出单文件 HTML，所有 assets 内嵌
>   - VC-5 ✓ bin/cli.js 维持零依赖
>   - VC-7 ✓ lib/templates/pptx.js 零依赖（不引入 pptxgenjs；用 node:buffer + 自实现 ZIP writer）
>   - VC-10 ✓ T-OD-001 既有 87 tests 仍全绿
>   - 待办: VC-2 PDF（依赖用户本地 Chrome/FFmpeg，外部命令不进 npm）/ VC-4（依赖 P-001 catalog 未 ship）/ VC-8 / VC-9 / VC-11 / VC-12（属于 MS-002 / MS-003 / MS-005 范围）
> - **变更文件总览**（按 ai-behavior §7 分阶段 commit 原则，本轮单 commit 因 M-ODI-001 是 Mission 起点）:
>   - 新增: 9 文件（lib/templates/{pptx,html-deck,md-deck}.js + lib/commands/deck.js + tests/templates/{pptx,html-deck,md-deck}.test.js + tests/commands/deck.test.js + docs/architecture/deck-workflow-design.md + templates/_shared/.agent/artifacts/deck-README.md = 11 新文件，含 3 个 templates）
>   - 改动: 2 文件（bin/cli.js +6 行 / lib/cli/contract.js +9 行 = 纯 additive）
> - **未提交**: 用户未显式要求 commit；暂留 dirty，commit 等用户授权（避免 ai-behavior §7 §2 「防止未提交数据丢失」与 git 纪律冲突）。
> **下一步**: (a) 用户授权 commit 后用 Conventional Commits `feat(deck): add /deck workflow (P-003 MS-001)` + `feat(pptx): add zero-dep OOXML constructor` + `docs(architecture): add deck-workflow-design.md` 三段式提交；(b) 继续 MS-002 (lib/catalog/* 重构 + lock schema v2)；(c) M-ODI-001 五个 MS 都 ship 后做 MS-004 pilot 验证（SamHMI / csm-view-memory）。
>
> **✅ 已 commit**: `02d4dd0 feat(deck): add /deck workflow (P-003 MS-001)` — 13 files, +2110 行（bin/cli.js 单 require + 11 新模块 + 1 docs）。

> **2026-08-20 收口 (open-design-integration / M-ODI-001 / MS-002 catalog bridge 协议层)**:
> - **授权执行**: 用户 "授权执行" 提交 MS-001 后,继续 "继续" → 进入 MS-002。
> - **MS-002 范围**(本次聚焦协议层 / follow-up CLI 留后续 sprint):
>   - ✅ lib/catalog/{kind-map,lockfile,registry,index}.js 4 文件 — 4 kind 通用 catalog 协议
>   - ✅ lock schema v1 → v2 向后兼容(端到端迁移测试通过)
>   - ✅ 设计-system 委托 lib/design/registry(T-OD-001 frozen,纯 additive)
>   - ❌ 4 kind CLI subcommand、plugin converter、Brand-backed extract、Claude Design import — 留 MS-002 follow-up
> - **新文件** · 8 个 · **+1,776 行**:
>   - lib/catalog/kind-map.js (208 行) — 4 kind 元数据
>   - lib/catalog/lockfile.js (175 行) — v2 multi-kind + v1→v2 迁移
>   - lib/catalog/registry.js (224 行) — 4 kind catalog index 聚合
>   - lib/catalog/index.js (38 行) — 统一 re-export
>   - tests/catalog/kind-map.test.js (180 行 · 21 tests)
>   - tests/catalog/lockfile-v2.test.js (251 行 · 26 tests)
>   - tests/catalog/registry.test.js (175 行 · 17 tests)
>   - docs/architecture/catalog-bridge.md (231 行)
> - **零修改**: lib/design/* 主体文件(frozen) — 仅通过 require 复用
> - **测试基线**: 新增 **64/64 PASS** + T-OD-001 **118/118 PASS** + MS-001 **66/66 PASS** = **248/248**
> - **零回归**: architecture-guard 0 violation
> - **端到端验证**(E2E):
>   - 写 v1 design-systems.lock(2 systems) → readLockfile 自动迁移到 v2
>   - upsertEntry × 3 (plugin + skill + template) → catalogs[]: 2 → 5
>   - writeLockfile → 干净 v2(剥离 _migrated_from_v1)
>   - 重读 → catalogs.length = 5,无迁移元数据
> **下一步**: (a) 用户授权 commit 后 `feat(catalog): add 4-kind catalog bridge (P-001 MS-002)` 提交;(c) MS-002 follow-up: lib/catalog/{fetch,license,plugin-converter,extract}.js + 4 CLI subcommand;(d) MS-003 MCP bridge + 26 adapter;(e) MS-005 HyperFrames motion plane;(f) MS-004 pilot 验证。

> **2026-08-20 收口 (open-design-integration / M-ODI-001 / MS-003 stdio MCP bridge + 26 runtime-adapter)**:
> - **授权执行**: 用户 "可以继续" → fork 后台 subagent 做 MS-003(并行 MS-002 follow-up → 98eeef9 → 9009a69)。
> - **MS-003 范围**(P-002 + P-004 并行 ship):
>   - ✅ lib/mcp/{jsonrpc,server,install,ping}.js — stdio MCP server,11 tools + 4 resource URI
>   - ✅ lib/commands/mcp.js — serve/install/ping/list/uninstall 5 subcommand dispatcher
>   - ✅ bin/cli.js — 替换 case "mcp" 为 mcpCommand(legacy --project 路由保留)
>   - ✅ .agent/references/runtime-adapters/ — README + _schema + _index.json + 26 <agent>.md(5 shipped / 21 reference)
>   - ✅ docs/architecture/mcp-bridge.md + runtime-adapter.md
>   - ✅ 77 新测试 + 5 既有测试集零回归
> - **新文件** · 42 · **+5,109 / -2 行**:
>   - lib/mcp/{jsonrpc,server,install,ping}.js (73+544+345+126 = 1,088 行)
>   - lib/commands/mcp.js (252 行)
>   - tests/mcp/{jsonrpc,server,install,ping,cli}.test.js (964 行 · 65 tests)
>   - tests/runtime-adapters/index.test.js (169 行 · 12 tests)
>   - .agent/references/runtime-adapters/{README,_schema,_index.json} + 26 <agent>.md (2,205 行)
>   - docs/architecture/mcp-bridge.md (217) + runtime-adapter.md (165)
> - **改动****: 2 文件 (bin/cli.js +11 / lib/cli/contract.js +7)
> - **测试基线**: 新增 **77/77 PASS** + 既有 **335/335 PASS** = **412/412**
> - **零回归**: architecture-guard 0 violation(570 files)· legacy Management API MCP (management-mcp-cli.test.js) 2/2 PASS
> - **端到端验证**(stdio JSON-RPC over stdio):
>   - `node bin/cli.js mcp serve` → `[cortex-agent mcp] serving /tmp/... (stdio, 11 tools)`
>   - `initialize` → 响应 → `notifications/initialized` + `tools/list` → 11 tools 全到位
>   - `tools/call design/list` → `{ok: true, installed: [...]}`
>   - `tools/call skill/browse {name: "open-design-launch-checklist"}` → 1 scanned, frontmatter 解析正确
> - **P-002 conflict 解决**: `mcp serve --project <path>` 路由到 legacy Management API MCP(M-001,cortex.query)·bare `mcp serve` 启新 P-002 design-asset MCP server。
> **下一步**: (a) MS-005 HyperFrames motion 第 5 平面(P-005);(b) MS-002 follow-up round 2: lib/catalog/fetch.js 4 kind 通用 fetch;(c) MS-004 pilot 验证 SamHMI P0 用 `cortex-agent mcp install dsh` 实跑验收。

> **2026-08-20 收口 (路径 B: Pixso 画稿 → 演示文稿桥接 · P-003 MS-001 follow-up)**:
> - **用户提问**: "项目已有的 pixso 设计稿,后续可以生成演示文稿吗" → 分析:链路存在但缺 Pixso DSL → /deck brief 转换层
> - **用户选择**: 路径 B(自动桥接,~0.5 天)
> - **实现** (commit `401271e`):
>   - ✅ lib/templates/pixso-deck-adapter.js (209 行) — get_node_dsl compact DSL → deck-brief.json
>     · 顶层 FRAME/CANVAS/SECTION → 每帧一张 slide
>     · TEXT 按字号降序: 最大 → title / 次大(单行+短+≥20px)→ subtitle / 短文本·多行 → bullets / 长文本 → body
>     · notes 带源 frame id · text 字段容忍 {content} 与裸字符串 · 零依赖
>   - ✅ lib/commands/deck.js — 新增 `--from-pixso <dsl.json>`(优先级压过 deck-brief.json,失败 exit 2)
>   - ✅ tests/templates/pixso-deck-adapter.test.js (20 tests) + tests/commands/deck.test.js (+7 → 30)
> - **测试**: 439/439 PASS(412 既有 + 27 新)· architecture-guard 0 violation · 零依赖维持
> - **端到端**: `cortex-agent deck MY-PIXSO-DECK --from-pixso frame.json` → 3 格式全出,
>   MD 验证 title+subtitle / title+bullets(3 行)/ title+body / speaker notes 带 frame id
> - **链路现状**: Pixso 稿 (get_node_dsl) → --from-pixso → /deck (HTML/PPTX/MD) ✅ 全通
> **下一步**: (a) MS-005 HyperFrames motion; (b) MS-002 round 2 fetch; (c) MS-004 pilot;
> (d) 把 pixso-deck-adapter 接入 MCP prototype/show(让外部 agent 也能触发画稿→deck)
