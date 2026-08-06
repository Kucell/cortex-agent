# Mission Plan: M-004 — FAE-002 Framework Event Bus

## Goal

把 cortex-agent framework 从「显式 emit + 半自动 inbox + journal 轮询」演进为「真事件总线 + sub-agent 自动 emit + 父端自动 subscribe & resume」,落地 `lib/event-bus/` + 8 类 core event + 4 个 client + parent-resume FSM,使 framework 在脱离 mavis 平台时也能跑「主 agent 派发 sub-agent → 事件触发回主 agent → 主 agent 完整完成 mission」闭环。完成 v2.0 启动条件 #5。

## Non-Goals

- 不动 mavis 平台层(已具备真事件驱动,赠品加速器)
- 不实现持久守护进程 daemon(MS-007 deferred to ADR)
- 不实现 5 adapters(Phase 3 / M-003,独立 mission)
- 不实现 SQLite / 数据库(决策 D-FAE-002-2 已拍 A:纯 JSONL)
- 不实现跨 host 联邦 event bus(Phase 5 future work)
- 不实现 schedule / cloud 化(本地优先 + 文件系统优先)
- 不破坏现有 `runs/<id>.json#subagent_fanout[]` 读侧接口

## Scope Boundaries

- In scope:`lib/event-bus/` 5 模块 + 8 schema + 4 client + 5 类测试 + e2e + perf + BC + CLI 子命令
- Out of scope:mavis 平台 / 5 adapters / daemon / cross-host / 跨 phase
- Ownership constraints:`subagent-trace` SKILL 升级由 MS-002 负责(不破坏现有 4 类 event),M-008 coordination 复用 journal 双源(coordination-sync client)

## Features

| Feature ID | Description | Owner | Status |
| :--- | :--- | :--- | :--- |
| F-001 | lib/event-bus/ 核心(publish / subscribe / ack / list / history) | MS-001 | **done** (Eric 8-05/06 + Mavis 8-05) |
| F-002 | 8 类 core event JSON Schema draft-07 + extension namespace | MS-001 | **done** (Eric 8-05/06 + Mavis 8-05) |
| F-003 | Persistence(events.jsonl + subs.json + archive + 10MB cap) | MS-001 | **done** (Eric 8-05/06 + Mavis 8-05) |
| F-004 | subagent-trace 升级(成功 / 失败 / 取消 自动 emit) | MS-002 | **done** (Mavis 8-06 cherry-pick) |
| F-005 | `bin/cli.js event-bus` 子命令(publish / subscribe / list-events / history) | MS-002 | **done** (Mavis 8-06 cherry-pick) |
| F-006 | parent-resume client(FSM + mission 上下文 resume) | MS-003 | **done** (Mavis 8-06 主 session 接管 Worker-B 取消) |
| F-007 | E2E 验证(派发 3 sub-agent → 完成 → 父 agent 自动 resume) | MS-003 | **done** (Mavis 8-06 主 session 接管 Worker-B 取消) |
| F-008 | coordination-sync client(M-008 journal 双源) | MS-004 | spec-approved |
| F-009 | dashboard-push client(实时面板) | MS-004 | spec-approved |
| F-010 | notification-pump client(跨 host 通知) | MS-004 | spec-approved |
| F-011 | RFC v0.5 + v2.0.0-rc.1 release notes | MS-005 | spec-approved |
| F-012 | AI-Brain 实战 2 月观察期 | MS-005 | spec-approved |

## Milestones

| Milestone ID | Goal | Depends On | Validation Contract | Status |
| :--- | :--- | :--- | :--- | :--- |
| MS-001 | lib/event-bus/ 核心 + 8 schema + tests(5 类 / 110 cases) | spec-approved | validation-contract.json VC-001..VC-005 | **done** (Eric 8-05/06 + Mavis 8-05, 110/110 pass, perf 1636 ev/s + 16ms) |
| MS-002 | subagent-trace 升级 + bin/cli.js event-bus 子命令 + BC tests | MS-001 | `validation-contract.json` VC-006..VC-007 | **done** (Mavis 8-06 cherry-pick to origin, 142/142 tests, 3 deviations D-1/D-2/D-3 ⚠️) |
| MS-003 | parent-resume client + e2e(派 3 sub → 父 resume)+ 端到端验证 | MS-002 | `validation-contract.json` VC-008..VC-010 | **done** (Mavis 8-06 主 session 接管 Worker-B 取消, 181/181 tests pass, merged `68d7fae`, 3 deviations D-1/D-2/D-3) |
| MS-004 | coordination-sync + dashboard-push + notification-pump 3 client | MS-003 | `validation-contract.json` VC-011..VC-013 | spec-approved (派发准备) |
| MS-005 | RFC v0.5 + v2.0.0-rc.1 release notes + AI-Brain 实战 2 月 | MS-004 | `validation-contract.json` VC-014..VC-016 | spec-approved |

## Sequencing

1. Eric review spec(`docs/architecture/framework-event-bus-design.md`)+ 5 决策拍板 → spec-approved
2. MS-001 串行(1 周):核心 + schema + tests,无并行
3. MS-002 串行(3-4 天):subagent-trace 升级 + CLI 子命令,依赖 MS-001
4. MS-003 串行(1 周):parent-resume + e2e,依赖 MS-002
5. MS-004 串行(1 周):3 个可选 client,依赖 MS-003
6. MS-005 串行(1 周 + 2 月实战):RFC + release notes + 实战观察,依赖 MS-004
7. v2.0 启动条件 #5 满足 → 评估 v2.0 GA

## Risks

| Risk | Severity | Mitigation |
| :--- | :---: | :--- |
| 跨平台 fs.watch 行为差异 | High | macOS / Linux / Windows 全测试 + polling fallback(1s) |
| events.jsonl 无限增长 | Medium | 10MB cap rotate,100MB 总 cap 删最旧 archive |
| parent-resume 误 resume 错 mission | High | mission_id + lease 双重校验,3 次失败 escalate |
| 8 类 event schema 与 M-008 journal 冲突 | Medium | event-bus event 名前缀 `eb:`,journal event 不加前缀 |
| ack 超时重投致 sub-agent 重跑 | High | sub-agent 状态机防(已 DONE 不重跑),event-bus dedupe 兜底 |
| mavis 平台层已具备真事件驱动,FAE-002 可能被视作 mavis 专属 | Medium | 明确「framework 真事件总线」独立于平台,跨 host 都受益 |
| 0 npm install 承诺被破 | Low | CI 加 lockfile 增量检查,引入依赖 PR 即 fail |
| 272+ regression 套件 0 新增 fail 失败 | High | BC 测试覆盖 subagent-trace 显式 emit,event-bus 双写 subagent_fanout[] |
| AI-Brain 实战 2 月长尾 | Medium | MS-005 不阻塞 v1.11 LTS,实战 2 月内发现的问题回 v1.11 patch |

## Exit Criteria

- [ ] Eric review + spec-approved 状态
- [ ] 5 milestones PASS 或有 explicit waiver
- [ ] Blocking validation assertions 全部满足
- [ ] Command log 记录所有 milestone exit codes
- [ ] Handoffs 完整(每 MS 一次)
- [ ] RFC v0.5 + v2.0.0-rc.1 release notes final
- [ ] AI-Brain 实战 ≥ 2 月稳定运行
- [ ] v2.0 启动条件 #5 满足

## 当前状态(实施阶段)

- State: VALIDATE
- Current milestone: MS-001 (lib/event-bus/ 核心 + 8 schema + persistence + tests)
- Blocked by: none (approved 2026-08-04, ready for implementation)
- Last updated: 2026-08-04
- Worktree commit: `b3d8f53`(docs/architecture/framework-event-bus-design.md + framework-event-bus-quickstart.md)

## 决策项(已拍板:2026-08-01 选 A 全部默认)

| # | 决策点 | 拍板结果 | 拍板时间 |
| :--- | :--- | :--- | :--- |
| D-FAE-002-1 | 启动条件 | M-002 + M-003 完成后启动,4-5 周 mission | ✅ 2026-08-01(选 A 全部默认) |
| D-FAE-002-2 | 事件总线存储 | 纯 JSONL(零依赖,简单) | ✅ 2026-08-01(选 A 全部默认) |
| D-FAE-002-3 | fan-out 进程形态 | 可选(默认纯 push) | ✅ 2026-08-01(选 A 全部默认) |
| D-FAE-002-4 | parent-resume 失败回滚 | 3 次重试 + 写 decision 让人工介入 | ✅ 2026-08-01(选 A 全部默认) |
| D-FAE-002-5 | 与 mavis 平台事件桥接 | 双向桥(mavis task tool 完成 → emit eb:task_completed;反之亦然) | ✅ 2026-08-01(选 A 全部默认) |

## 关联文档

- **Detail design spec**:`docs/architecture/framework-event-bus-design.md`(本 mission 实施依据)
- **Quickstart**:`docs/architecture/framework-event-bus-quickstart.md`
- **提案**:`.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-002-framework-event-bus.md`
- **RFC v0.3**:`docs/architecture/general-mode-design.md` §17.1 - §17.6
- **M-008 mission artifacts**:`.agent/missions/M-008/`(coordination 复用)
- **subagent-trace SKILL**:`.agent/skills/subagent-trace/SKILL.md`(升级目标)
- **FAE-001 词汇**:`.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-001-dispatch-vocabulary.md`
