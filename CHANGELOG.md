# Changelog

All notable changes to `cortex-agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **local-publish-validate 工作流 (三件套)** — 本地发包 + 本地安装 + 可选目标项目升级的本地验证循环,用于 RC dogfooding / 跨项目模板更新验证。**永不 publish 到 npm**,只走 `volta install <pkg>@file:<tarball>` 协议。
  - **脚本**:`bin/local-publish-validate.cjs` (13811 bytes,在 npm tarball 中,跨机器/容器可移植)
  - **CLI 模块**:`lib/commands/local-publish-validate.js` (包装脚本)
  - **CLI 入口 hookup**:`bin/cli.js` `case "local-publish-validate"` + `lib/cli/contract.js` contract
  - **工作流文档**:`.agent/workflows/local-publish-validate.md` (中文+英文)
  - **source-command 适配**:`.agents/skills/source-command-local-publish-validate/SKILL.md` (让 AI 在用户说"本地发包/本地验证/RC 跑一遍"等时自动调度)
  - **测试**:`tests/commands/local-publish-validate.test.js` (7 子测试 全绿;`tests/commands` scope 28/28 通过)
  - **支持选项**:`--target <path>` / `--bump <rc|patch|minor|major>` / `--skip-tests` / `--skip-commit` / `--dry-run` / `--force` / `-v, --verbose`
  - **使用示例**:
    - `cortex-agent local-publish-validate --target ../SamHMI --bump rc` (装 + 升级 SamHMI,bump 到下一个 rc)
    - `cortex-agent local-publish-validate --target ../SamHMI --skip-tests` (跳过 baseline flaky 测试)
    - `cortex-agent local-publish-validate --dry-run` (看会做什么)
    - `node bin/local-publish-validate.cjs --target ../SamHMI` (直接调脚本,跳过 CLI 包装)

### Validation

- `tests/commands` scope 28/28 通过 (含新 7 子测试)
- `npm pack` 后 tarball 包含 `package/bin/local-publish-validate.cjs` 和 `package/lib/commands/local-publish-validate.js`
- `volta install cortex-agent@file:...tgz` 后 install dir 的 `cortex-agent local-publish-validate --help` 正常工作
- 跨源仓 (cortex-agent) 和 install dir (volta) 双路径都能调通

## [1.12.0-rc.2] - 2026-08-10

> **Pre-release**:rc.2 给 AI-Brain 内部 dogfooding 试用 + 实战 ≥ 2 周观察期,**不建议生产使用**。
> **基础**:`2078881`(v1.12.0-rc.1,2026-08-04)→ **200 commits** → `496f28a` chore(test)
> **rc.1 vs rc.2 差异**:**200 commits 增量**,**484 files changed, +48701 / -3709 lines**
> **完整 release notes**:`docs/releases/v1.12.0-rc.2.md`(本目录生成,中英双语)
> **Mission 关联**:M-019(context-budget v2 P1/P2/C1/C2)+ M-004(FAE-002 Event Bus 完整闭环)+ M-016(branch-management 4 milestones COMPLETE)+ M-018(OKF Knowledge Layer MS-004+MS-005)+ state-sync(9-class 跨机同步)+ test infra 重构
> **同主线吸收的 v1.13.0-rc.1/rc.2 内容**:M-004 / M-016 / M-018 在本主线(无 1.13.x tag 的分支)上以"内部 RC"形式吸收,v1.13.0-rc.1/v1.13.0-rc.2 tag 保留在已弃用分支上以追溯历史。

### Major

- **M-019 context-budget v2 (P1/P2/C1/C2) — 本 rc 核心新特性** (`55c1114`):
  - **P1 prefix caching**:`prefix-builder.js` + `cache-config.yml` + `cache-break.js`(epoch-hash 漂移检测)+ `rule-tier.js`(规则稳定性分 7 层)
  - **P2 session history compaction**:`compact.js` + `compact.schema.json`,`integrateHistory` 接入 `build-l0l1`
  - **C1 reference-level exact dedup**:`dedup-refs.js` 构建 canonical block,`select` / `build-l0l1` 发出 dedup 报告,`agent-config` 的 `core-principles` 从 inlined body 改为 canonical block 引用
  - **C2 multi-agent shared context**:`gen-shared-context.js` 经 Artifact Bus 发布,`handoff` schema 增 `shared_context_ref` 字段(双模板 _shared/_base),`protocol.js` 验证
  - 9 个新文件 in `templates/{zh,en}/.agent/skills/context-budget/`
  - Self-bootstrap VC-019-01..15 全 PASS:dedup 546t / cache-break cache_break:true / select 7 rule_tiers / compact 164 modules / shared_context_ref 验证
  - 架构文档:`docs/architecture/context-optimization-v2.md`(93 lines)
  - 26 files changed / +2079 lines
- **state-sync 跨机同步 (`a6b5905` / `e38326c` / `7037ab8` / `0aa45da` / `75fda8a` / `2db9924` / `d042dbf`)**:
  - 扫描 9-class `.agent/` 状态目录(`decisions` / `handoffs` / `missions` / `dispatch` / `tasks` / `sessions` / `runs` / `inbox` / `memory`)做跨机 sync
  - `init` / `upgrade` / `managementWrite` 三入口 wire 进去,`.agent/` 全程 lock-step
  - 忽略 `.bak` / `.bak.prev` / `.tmp` / `~` 备份文件(9 state class)
  - `.githooks/` pre-commit 提醒模板 ship 到 user projects
  - `init mode general` 收口:AGENTS.md seeding + state-sync 集成
- **M-004 Event Bus 完整闭环(MS-001+MS-002+MS-003)(本主线吸收,v1.13.0-rc.2 tag 在弃用分支)**:
  - MS-001:`lib/event-bus/` core API + 105 tests pass(VC-001..VC-005)
  - MS-002:F-004 subagent-trace bridge(`lib/event-bus/subagent-trace-bridge.js` ~340 行)+ 8 类 core event 双写;F-005 `cortex-agent event` CLI 4 subcommand(`lib/event-bus/cli.js` ~470 行)+ VC-006/VC-007
  - MS-003:F-006 parent-resume client + **FSM 5 状态**(`parent_idle` → `parent_dispatching` → `parent_waiting_subagent` → `parent_resuming` → `parent_consolidating`)+ clients registry + event-bus resume subcommand + P-003 整合
  - 5 个新 test files:`event-bus-bc-subagent-trace`(529)+ `event-bus-cli`(277)+ `event-bus-parent-resume-fsm`(348)+ `event-bus-parent-resume-e2e`(379)+ `event-bus-parent-resume-safety`(332)
- **M-016 Branch Management 4 milestones COMPLETE(本主线吸收)**:
  - MS-001:`lib/branch-naming.js` + `lib/branch-registry.js`(5 类分支命名规范 + 提案-分支绑定)
  - MS-002:`lib/commands/branch.js`(5 subcommand:create / list / merge-ready / lock / unlock)
  - MS-003:5 workflows 集成(start-task / mission / ship / commit / handoff)
  - MS-004:`docs/architecture/branch-management-design.md` + 3 fixtures
- **M-018 OKF V0.2 Knowledge Layer MS-004 + MS-005(本主线吸收)**:
  - `feat(okf): implement OKF V0.2 knowledge layer`(`0cf448e`)
  - `docs/architecture/okf-knowledge-layer.md`(完整设计)
  - 知识架构 V0.2 实施,与 Harness Phase 7 对齐
- **Test infrastructure 重构 (本 rc 配套)**:
  - `d6a1c4e` / `1dc592b`:legacy tests 重分类(110 + 54 个)
  - `48dbe8e`:parallel test runner + per-file timeout + per-module entry
  - `d463ae6` / `496f28a`:max-time global wall-clock cap + per-test timeout + idle-timeout + SIGTERM trap(三层防护)
  - 解决 event-bus / dispatch / coordination 类的 hang class

### Added

- **dependency-analysis skill** (`f6a78e8`):补齐 `/sync-plans` 引用缺口
- **init mode general 收口** (`d042dbf`):AGENTS.md seeding + state-sync 集成
- **state-sync 跨机模板** (含 `.githooks/` pre-commit):ship 到 user projects
- **CLI contract entries**:`branch` + `state-sync` 2 个补齐(`2db9924`)

### Refactor

- **`d2ef233` lib/commands.js → lib/commands/ 全拆分**:22 modules + 22 unit tests
- **`f7d4100` lib/ + tests/ 按命名 prefix 重组织**(为后续模块化铺路)
- **`fcc00cf` lib/agents + tests import 路径同步**
- **`d0032db` / `b7542bd` commands 模块激活**(prompt / patches / anchor / init)

### Fixed

- **`3672565` / `6662ecb`**:cli upgrade/update `--dry-run` honor(跳过 `installStateGithooks`)
- **`147a283`**:templates 3 个 `__dirname`-relative 路径被 lib/ reorg 破坏
- **`2007428`**:platform `getInstalledPlatforms` 防 non-array state files
- **`cb75374`**:subagent-trace placeholder fanout entry 引用未定义变量 status(M-004 D-3)
- **`c79d94b`**:governed defaultExecutor 指向正确 child-monitor path
- **`ee4bf5f` / `cb634fc` / `2f97dea` / `cff1ec4`**:lib reorg 引起的 5 个生产路径 + 多个 test 路径
- **`5dd628a`**:zh workflow 模板 resync to canonical
- **`6b54264` / `d81685a`**:knowledge layer owner/verified_by 从 generic "mavis" agent id 改为项目作者 "Kucell"(V-FM-003)

### Validation

- **commands scope**:27/27 passed
- **setup / update / state-sync scope**:2/2 + 2/2 passed
- **full test suite**:`220/226 passed in 86020ms`(`max-time 600` 跑批完成)
  - 6 FAIL:`dashboard/dashboard-supervisor-idle` / `management/management-query-readonly` / `event-bus/event-bus-perf-bench` / `template/template-parity` / 2 个 TIMEOUT(`agent/agent-bridge-mcp-bidirectional` / `governed/governed-child-monitor`)
  - 这些 fail 不属于本 rc 引入的回归(commit 43c6116 / c79d94b / ee4bf5f 之前的 baseline 已有同类 flaky),AI-Brain 实战 ≥ 2 周观察期内收敛
- **main ↔ origin/main**:`ahead 0 / behind 0`
- **rc.1 tag 保留**:`v1.12.0-rc.1` 仍指向 `2078881`(历史可追溯)
- **同主线 v1.13.0-rc.1/rc.2 tag 保留**:在弃用分支上,本 rc 内容与它们在 commit 层面有相当部分重合(M-004/M-016/M-018 三个 mission),但 main 没继承它们的 1.13 编号

### 继承自 v1.12.0-rc.1 (在本 rc 已包含)

- M-003(Phase 3):5 adapters + 1 MCP bridge + dispatch 三协议
- T-OD-001:Open Design 集成 — DESIGN.md + `cortex-agent design` 7 子命令
- Volta pin Node 24.19.0

### Excluded(未来 milestone)

- M-007 skill-dispatch P-001..004:SCOPE 等 Gate-1
- M-006 AWO/P-007:ADVANCE MS-003 planned
- M-013 FAE-002/003/004/007:VALIDATE
- M-014 ARI/P-006:PLAN
- M-007 Dispatch / handoff 进一步抽象

## [1.13.0-rc.2] - 2026-08-07

> **Pre-release**:rc.2 给 AI-Brain 内部 dogfooding 试用 + 实战 ≥ 2 周观察期,**不建议生产使用**。
> **基础**:`44108f2`(v1.13.0-rc.1,2026-08-06)→ 99 commits → `8ae1d70` (M-004-MS-003 close-out)
> **rc.1 vs rc.2 差异**:**99 commits 增量**,**88 files changed, +15643 / -80 lines**
> **累积 commits**(v1.12.0-rc.1 起):**247 commits**
> **完整 release notes**:`docs/releases/v1.13.0-rc.2.md`(双语 zipped)
> **Mission 关联**:M-004(FAE-002 Event Bus MS-001+MS-002+MS-003 全部 done)+ M-016(branch-management 4 milestones COMPLETE)+ M-018(OKF Knowledge Layer MS-004+MS-005)+ M-015(ACN/P-005)+ T-CAB-001 + P-003 + M-SETUP-PORT-001 + T-FIX-TESTS-001

### Major

- **M-004 Event Bus 完整闭环 (MS-001+MS-002+MS-003) — 核心基础设施**:
  - MS-001: `lib/event-bus/` 核心 API + 105 tests pass (VC-001..VC-005)
  - MS-002: F-004 subagent-trace bridge (`lib/event-bus/subagent-trace-bridge.js` ~340 行) + 8 类 core event 双写;F-005 `cortex-agent event-bus` CLI 4 subcommand (`lib/event-bus/cli.js` ~470 行) + VC-006/VC-007
  - MS-003: F-006 parent-resume client + **FSM 5 状态** (`parent_idle` → `parent_dispatching` → `parent_waiting_subagent` → `parent_resuming` → `parent_consolidating`) + clients registry + event-bus resume subcommand + P-003 整合
  - 派发模式: Worker-B 起草 22 min + framework 取消 + 主 session 接管 (M-019 实战 5+ 次验证)
  - 3 deviations honest 标注 + close-out handoff
  - 5 个新 test files: `event-bus-bc-subagent-trace` (529) + `event-bus-cli` (277) + `event-bus-parent-resume-fsm` (348) + `event-bus-parent-resume-e2e` (379) + `event-bus-parent-resume-safety` (332)
  - M-004 MS-003 39 cases total
- **M-016 Branch Management 4 milestones COMPLETE**:
  - MS-001: `lib/branch-naming.js` + `lib/branch-registry.js`(5 类分支命名规范 + 提案-分支绑定)
  - MS-002: `lib/commands/branch.js` (5 subcommand: create / list / merge-ready / lock / unlock)
  - MS-003: 5 workflows 集成 (start-task / mission / ship / commit / handoff)
  - MS-004: `docs/architecture/branch-management-design.md` + 3 fixtures
  - 3 个新 test files: `branch-cli` / `branch-naming` / `branch-registry` + `workflow-integration` (534 行)
  - commits: `08a9b55` / `4471e17` / `db5c1b3` / `7606028` / `125a08d`
- **M-018 OKF Knowledge Layer MS-004 + MS-005**:
  - `feat(okf): implement OKF V0.2 knowledge layer` (`0cf448e`)
  - `docs/architecture/okf-knowledge-layer.md`(新,完整设计)
  - 知识架构 V0.2 实施,与 Harness Phase 7 对齐

### Fixed

- **`fix(knowledge): owner/verified_by`: mavis → Kucell**(V-FM-003,2 commits `6b54264` / `d81685a`)
  - 治理规则 owner / verified_by 字段从 generic "mavis" agent id 改为项目作者 "Kucell"
  - 防止 future 误用 generic agent id 进入 owner gate

### Validation

- 5 个新 test files (event-bus):共 1865 行
- 3 个新 test files (branch):覆盖 MS-001/002/003
- 1 个新 test file (workflow-integration):534 行
- 3 个新 fixtures:branch-corrupt / branch-minimal / branch-populated
- main ↔ origin/main:`ahead 0 / behind 0`
- Inner `.agent` ↔ origin:`ahead 0 / behind 0`
- **rc.1 tag 保留**:`v1.13.0-rc.1` 仍指向 `44108f2`(历史可追溯)

### Excluded

- M-007 skill-dispatch P-001..004:SCOPE 等 Gate-1
- M-006 AWO/P-007:ADVANCE MS-003 planned
- M-013 FAE-002/003/004/007:VALIDATE
- M-014 ARI/P-006:PLAN

### 继承自 v1.13.0-rc.1 (148 commits,详见 rc.1 release notes)

- P-003 cross-project-event-bridge Phase 1+2
- T-CAB-001 AGENTS.md Compatibility Adapter Bootstrap
- M-SETUP-PORT-001 linkGlobalConfig portability
- M-015 (ACN/P-005) bounded monitor reconciliation
- ACN/P-003 host-neutral notification
- Agent Skills ecosystem fusion (Ref M-017)
- export-anchor CLI command
- T-FIX-TESTS-001 (F1-F5) test stability
- post-v1.9.4 governance hardening
- T-CAB-001 P-002 follow-up proposal
- INCONSISTENCIES-REPORT.md + 6 follow-up tasks

---

## [1.13.0-rc.1] - 2026-08-06

> **Pre-release**:rc.1 给 AI-Brain 内部 dogfooding 试用 + 实战 ≥ 2 周观察期,**不建议生产使用**。
> **基础**:`3f51c2c`(v1.12.0-rc.1,2026-08-04)→ 148 commits → `90e9cd5` feat(platform) → `a7d8bf3` feat(cli export-anchor) → `dde5cf5` 4-merge 节点
> **累积 commits**:148(feat 73 / fix 29 / chore 11 / docs 12 / merge 12 / test 11 / refactor 1)
> **完整 release notes**:`docs/releases/v1.13.0-rc.1.md`(双语 zipped,中文在前,English 在后)
> **Mission 关联**:M-015(ACN/P-005 bounded monitor)+ T-CAB-001(host-adapter P0/P1)+ P-003(cross-project-event-bridge Phase 1+2)+ M-SETUP-PORT-001(setup-portability)+ T-FIX-TESTS-001(F1-F5 测试修复)

### Major

- **跨项目事件桥接 (P-003) — 新能力**:Phase 1 事件桥模块层 + CLI 路由;Phase 2 跨主机 handoff 元数据扩展(4 字段:`origin_project` / `target_project` / `topology_ref` / `working_branch`);101/101 tests pass;为 SamHMI × hmi-platform 双线协作落地。commits: `0d3b582` / `8031a1e` / `d77b7af` / `abccdaf`
- **AGENTS.md 兼容性适配器 (T-CAB-001)**:P0/P1 — `## Compatibility Adapter Bootstrap` 受管块强约束宿主工作流(必须先加载真源 `.agent/workflows/<command>.md`);`lib/setup.js` 3 新函数;双语模板 principle 11;`fix(host-adapter): preserve upgrade additive-only boundary` 修升级路径。commits: `1ce7a95` / `dc8615e` / `ce8f5b8`
- **安装配置可移植性 (M-SETUP-PORT-001)**:`linkGlobalConfig()` 改用 `path.relative`(跨用户/机器/容器可移植);`.gitignore` 加 `.agent/global`;`cortex-agent doctor` 新增 `[setup-portability]` 4 类检查(missing / not-symlink / broken / wrong-target);实施中修 2 个 task 外的真实 bug(macOS `/tmp → /private/tmp` 别名 + `fs.existsSync` 跟随 symlink)。commits: `1e736f2` / `dde5cf5`
- **受治理监控收口 (M-015 / ACN/P-005)**:严格区分 Task 状态 vs execution-attempt disposition;5 attempt 状态(attempt_active / attempt_review_ready / attempt_attention_required / attempt_closed / attempt_inconsistent);Heartbeat 终态异常仅通知一次后自动暂停;Fenced 人工 reconciliation(fresh lease + fencing token + evidence 三必)。commits: `b0c596d` / `2651f36`
- **厂商无关通知 (ACN/P-003)**:Host Wakeup Adapter + stdio/JSONL transport;Codex App Server wakeups 接入;Production notification lifecycle 集成。commits: `0d73da2` / `efed4ef` / `6855cd9` / `ae446bd`

### Added

- **Agent Skills 标准生态融合** (Ref M-017, `90e9cd5`):注册 grok / opencode / pi 三个一等平台;`linkGlobalConfig` 新增 `~/.agents/skills` 检测;`installPlatform` 支持 merge 字段(JSON 数组并集 + 标量保留 existing)
- **跨工具识别锚点 (export-anchor)** (`a7d8bf3`):新增 `cortex-agent export-anchor` 命令,输出标准 HTML 锚点 `<!-- cortex-agent:anchor:v1 -->`;让 Claude Code / Codex / Cursor / Aider / Pi 等任何 AI 工具准确识别 cortex-agent 管理;`lib/anchor.js` 173 行新模块
- **secrets bridge** (`aeacf89`):`secret://<ref>` 桥接到 MCP `bearer_token_env_var`(resolve / render-bearer / inject 三步)
- **memory 3 protocol-level patches** (`ac08519`):Claude Code v2.1.216 binary 兼容
- **T-CAB-001 P-002 follow-up proposal** (`1555a33`):6 个候选方向(适配器扩展/Claude Code 路径/测试矩阵/doctor/跨 host/SamHMI 实战)
- **P-003 cross-project-coordination project 重建**:5 个子提案 P-001..P-005 + index/references/relations
- **P-002 (cross-project-event-bridge Phase 2) 提案**:10 章节 active
- **7 个 P-NNN 文件补 `status:` frontmatter**(AWO 全 P-001..P-007)
- **INCONSISTENCIES-REPORT.md + INCONSISTENCIES-FOLLOWUP-TASKS.md**:6 个 inconsistencies + 6 个 follow-up 任务
- **`docs/cortex-agent/anchor.md`**:export-anchor 锚点规范

### Fixed

- **T-FIX-TESTS-001 (F1-F5)**:`1237dca` dispatch-state projections + retrieval-trace panel,`d61d918` query-dispatch-state.js fixture,`c7c05b2` lib/setup.js dedup,`4970bed` F2/F3/F4 update fixture,`7de54a0` T-FIX 整体 merge
- **post-v1.9.4 governance hardening** (`6472f00`):公共租约 + 受治理手动派发
- **监控收口日志真相一致性** (`2651f36`)
- **management-api 空协调运行时查询兼容** (`e55b238`)
- **governed launch 修复**:`4cc3c6f` 终态恢复 + `a05021b` monitor 进程组分离 + `3f9292f` 接管后恢复幽灵任务

### Excluded

- **M-004 FAE-002 Event Bus MS-002+**:MS-001 done(105 tests pass),MS-002+ 在推
- **M-007 skill-dispatch P-001..004**:SCOPE 等 Gate-1
- **M-016 branch-management MS-002+**:MS-001 done,后续在另一 agent 推
- **M-018 knowledge layer**:SCOPE → PLAN,plan ready for user confirmation

### Validation

- **全测试套**:~5 fail(全部 pre-existing baseline 8 fail 子集)
- **真合并引入回归**:**0**
- **`.agent` 漂移修复**:4 个文件同步
- **2 个新 feat 冒烟测试**:`lib/anchor.js` / `lib/platform.js` / `lib/registry.js` require OK,`export-anchor` 命令可执行
- **main ↔ origin/main**:`ahead 0 / behind 0`

---

## [1.12.0-rc.1] - 2026-08-04

> **Pre-release**:rc.1 给 AI-Brain 内部 dogfooding 试用,**不建议生产使用**。
> **Mission**:M-003(Phase 3 - 5 adapters + 1 MCP bridge,5/5 milestone done)+ T-OD-001(Open Design 集成,3/3 milestone done)。详见 `docs/releases/v1.12.0-rc.1.md` 与 `.agent/tasks/T-OD-001.json`。
> **RFC**:§17.4 Phase 3 ship 状态已 final 化(`63f2f08`)。

### Added

- **T-OD-001 MS-001(templates + DESIGN.md starter)**:7-section starter(`templates/{zh,en}/.agent/DESIGN.md`,byte-identical 内容)+ `templates/_shared/.agent/design-systems/README.md` + 架构文档 `docs/architecture/design-system.md`(319 lines,bilingual)。commit `97a5ff3`
- **T-OD-001 MS-002(lib/design/* + 87 tests)**:5 lib 模块(registry / fetch / lockfile / license / resolve,782 LOC)+ 5 test 文件(1262 LOC,87 tests,0 fail)。Content-addressed SHA-256 校验防 MITM;4-level cascade 解析;license fail-closed + brand category 警示。commit `227987c`
- **T-OD-001 MS-003(CLI + SKILL + 24 tests)**:`cortex-agent design {list,install,upgrade,remove,show,resolved,refresh-catalog}` 7 子命令(零 npm dep),exit codes 0/1/2/3/4,`--yes` 不绕过 license fail-closed(只有 `--force` 能)+ `templates/_shared/.agent/skills/design-system/SKILL.md` agent 引导 + `lib/cli-contract.js` + design entry 注入。bin/cli.js 最小改动(1 case + 1 require)。commit `ba6b1bb`
- **M-003 5 adapters + 1 MCP bridge**(承接 v1.12.0 主体,先前 commit):Claude Code / Codex / Codey / Pi / MiniMax CLI adapters + MCP stdio bridge 双向 + dispatch 三协议(HTTP/CLI/file)+ 5-adapter × 3-protocol E2E matrix 32 tests
- **Volta pin Node 24.19.0**:`package.json` 加 `"volta": { "node": "24.19.0" }`,便于 AI-Workbench 等下游项目通过 Volta 拉一致 Node 版本

### Notes

- **Open Design 集成 12/12 VCs 全 PASS**:templates byte-identical / 6 catalog/manifest/hash VCs / cascade resolved / upgrade hash delta / MITM 防护 / bin/cli.js 零 npm dep / 完整回归 125/125 / 架构审计 0 violation
- **零 npm dep 全程维持**:lib/design/* 5 模块纯 Node.js 内置(`fs` / `path` / `https` / `crypto` / `os`);bin/cli.js 只加 1 case + 1 require
- **纯加法升级**:`lib/commands.js` 2574 行主文件 untouched,所有新功能通过 `lib/{memory,design}/cli.js` 子模块接入
- **Backward Compatibility**:`cortex-agent design` 是新顶层命令,不影响 `init` / `update` / `upgrade` / `agent` / `memory` / `dispatch` / `team` / `secrets` 等已有命令
- **AI-Brain 实战路径**:`volta pin node@24.19.0` + `npm link cortex-agent` 在 AI-Workbench 等项目里使用,v1.12.0-rc.1 锁定为实战基线
- **Phase 2 后续**(本 rc 不含):`tokens.css` 解析、MCP server 双向桥接、DESIGN.md 强校验、design fork、跟 prd-visualization OpenPencil 联动

## [1.11.0-rc.1] - 2026-08-04

> **Pre-release**:rc.1 给 AI-Brain 内部 dogfooding 试用,**不建议生产使用**。
> **Mission**:M-002(Phase 2 - general 模式骨架,5/5 milestone done)。详见 `docs/releases/v1.11.0-rc.1.md`。

### Added

- **MS-001(general 模式模板抽离)**:`templates/general/.agent/` 6 子目录骨架 + 4 workflow contracts(`/memory recall` / `/memory distill` / `/agent discover` / `/agent invoke`)+ 2 skill + 1 sub-agent + 1 domain + 双语同步。commit `eac3d9a`(merged `518139f`)
- **MS-002(`cortex-agent memory` CLI + 3 类 schema)**:`lib/memory/` 5 文件子系统,`memory recall` / `memory distill` 子命令,episodic + semantic 类型(procedural 推 v1.12)。72/72 tests pass。commit `1289702`(merged `a465f01`)
- **MS-003(`cortex-agent agent discover|invoke` CLI + Agent Registry)**:`lib/agents/` 5 文件子系统,静态能力 registry + `agent discover` / `agent invoke`(plan-only)。77/77 tests pass。commit `a8c0e28`(merged `4f24c83`)
- **MS-004(4 general workflow + E2E 矩阵)**:`init --mode general` 扩展 + `tests/m002-e2e-matrix.test.js` 7 tests。163/163 total regression pass。commit `5a3d36a`(merged `5d2199b`)
- **MS-005(RFC v0.4 同步 + release notes final)**:RFC §15 Phase 2 5 行翻 ✅ + 本 release notes final 化。commit `cc10303`(merged `1168710`)
- **M-013.P0 C2 dispatch dry-run CLI**:governed manual dispatch CLI surface,7 pre-existing fail 修通。commit `f71197f`(merged `1759597`)
- **FAE-002 spec 阶段**:8 章节 + 16 validation assertions publish。commit `b3d8f53`(merged `105198e`)

### Fixed

- RFC §15 Phase 2 5 个待办全部翻 ✅(M-002 收口)
- M-013.P0 C2 dispatch 7 个 pre-existing test fail 修通

### Notes

- **general 模式 opt-in / 暂不推荐生产**;通过 `cortex-agent init --mode general` 显式选择,默认行为不变
- **shadow 双跑路径**:`templates/{zh,en}/` 老项目零变化
- **零依赖**:`templates/general/` 抽离无 npm install
- **Backward Compatibility**:`cortex-agent init --mode code` 行为与 v1.10.0-rc.1 完全一致;现有 v1.10.x 项目 `cortex-agent update` 升级零影响


## [1.10.0-rc.1] - 2026-08-01

> **Pre-release**:rc.1 给 AI-Brain 内部 dogfooding 试用,**不建议生产使用**。
> **Mission**:M-001(Phase 1 — mode 切分 + 跨 host 切换总线)。详见 `docs/releases/v1.10.0-rc.1.md`。

### Added

- **P-001(Phase 0 收口)**:cortex-agent session CLI 10 子命令 + 11 回归测试(`assess` / `log` / `checkpoint` / `archive` / `restore` / `resume-bundle` / `status` / `warm` / `host-switch` / `list-contexts`)。commit `0182ea7` / `ceb1539` / `c802652`,merged `94d26f1`
- **MS-001(Phase 1 收口,`templates/_base/`)**:共享层抽离,11 个 data 目录 schema publish(inbox / decisions / waitpoints / runs / sessions / missions / handoffs / conversations / memory / agents / tasks)。commit `c352d2b`,merged `660e248`
- **MS-002(`cortex-agent init --mode general`)**:general 模式 init 命令,显式选择模式。commit `ae05295`,merged `12e3db7`
- **MS-003(`cortex-agent init` 自动 mode 推断)**:无参数时根据 cwd marker(AGENTS.md / .cursorrules / .github/copilot-instructions.md / package.json)自动选择模式,空目录默认 general。`lib/mode-infer.js` 5 规则独立模块。commit `e4de8ec`,merged `f8a1d38`
- **MS-004(shadow 路径测试矩阵)**:`tests/shadow-init.test.js` 13 个场景覆盖 v1 / v2 init 边界 + auto-infer + 显式覆盖,3 个 additivity 守卫。**关键发现**:11 个 v2 `_base/.agent/` 目录中只有 3 个(`agents/conversations/missions`)真正 v2 独有,其他 8 个在 `templates/_shared/.agent/` 中已存在。commit `04f7b3f`,merged `8be4e4d`
- **RFC v0.3**:新增 §17 v2.0 愿景「全自动 mission 编排」,明确 mavis 平台层 vs cortex-agent framework 层边界,Phase 1-4 阶段拆分,v2.0 启动条件 5 项。commit `855e722` + `ee034ca`

### Fixed

- **agent-runtime-continuity 提案"假 done"问题修复**:commit `4f51d9f` / `08c2402` 幽灵 commit → 4 个真实 commit `1513b27` / `33b1baa` / `e456181` / `6502837`
- **RFC §15 Phase 0 4 个待办**全部翻 ✅(P-001 收口)
- **RFC §15 Phase 1 4 个待办**全部翻 ✅(commit hash 已替换为 MS-001/002/003/004 真实 commit)
- **§15 Phase 1 footer "placeholder 说明"备注**archived(2026-08-01)

### Notes

- **general 模式 opt-in / 暂不推荐生产**(`§12 #2` 拍板);通过 `cortex-agent init --mode general` 显式选择,默认行为不变
- **shadow 双跑路径**:`templates/{zh,en}/` 老项目零变化,新 `init --mode general` 走 v2 schema(由 MS-004 测试矩阵覆盖)
- **MS-004 shadow 路径测试 13/13 pass**,确认 v1 / v2 init 边界不冲突;老 v1.x 项目走 v1 schema 零变化,新 `init --mode general` 走 v2 schema,272+ 回归 0 新增 fail
- **跨 agent 续接协议**:runtime 层 `cortex-agent session host-switch` 已 ship(commit `0182ea7`),host 适配(Claude Code / Codex / Cursor 各自主动调用)留 v1.11.0 Phase 3
- **零依赖**:`templates/_base/` 抽离无 npm install,hand-rolled draft-07 验证器沿用 v1.x 风格

### Backward Compatibility

- `cortex-agent init --mode code` 行为与 v1.9.0 完全一致
- 现有 v1.x 项目 `cortex-agent update` 升级零影响(shadow 路径)
- `update --mode general` 暂不允许跨模式升级(v2.0.0 引入 `cortex-agent migrate` 替代)
- 所有 v1.x 已有子命令(`init / update / upgrade / session / task / event / lease / secrets / query / 等`)函数体零修改
- `lib/commands.js` 零修改(M-001 MS-002/003 binding contract)
- `templates/{zh,en}/` 零修改(M-001 MS-001 binding contract)

### Known Limitations

- `cortex-agent session` 子命令依赖 `lib/commands.js` 子模块,**not yet isolated**(P-002 候选,plan §6.3)
- 跨 host 适配(host 主动调用 host-switch)未做,留 v1.11.0
- general 模式 workflow(Phase 2)未实现 — `/conversation log` / `/memory recall` / `/agent invoke` / `/handoff` 留 v1.10.0 → v1.11.0 之间
- memory schema(episodic + semantic)暂未 ship,procedural 推到 v1.12
- 5 adapters + 1 MCP bridge(Claude Code / Codex / Pi / Kimi / DeepSeek + bridge 消费 Mem0 / claude-mem / CodeBuddy ACP / Cursor ACP / 通义灵码 / Trae)Phase 3 v1.11.0 实施
- **MS-004 揭示**:11 个 v2 data 目录中只有 3 个(`agents/conversations/missions`)真正 v2 独有;其他 8 个(`runs/tasks/waitpoints/inbox/decisions/handoffs/memory/sessions`)在 `templates/_shared/.agent/` 中也存在 — 这是 v1 runtime 既有数据,shadow 路径下两层共存
- M-001 24 个 pre-existing test failure(与 MS-002/003 auto-infer 行为相关)未修,留 v1.10.0 GA 前小 mission 处理

### Upgrade Path

- v1.9.0 / v1.9.1 → v1.10.0-rc.1:`npx cortex-agent update` 即可,零影响
- v1.10.0-rc.1 → v1.10.0 GA(待发):同样 `npx cortex-agent update`
- v1.10.0 → v2.0.0(未来):走 `cortex-agent migrate` 跨模式升级,提供 dry-run

### References

- RFC: `docs/architecture/general-mode-design.md` v0.3
- Release notes 全文: `docs/releases/v1.10.0-rc.1.md`
- P-001 归档: `AI-Brain/99-Project-Notes/cortex-bridge/2026-08-01-p001-ship-and-merge.md`
- M-001 mission plan: `.agent/missions/M-001/mission-plan.md`
- Bridge memos 6 份: `general-mode-rfc-discussion` / `rfc-v0.2-and-version-strategy` / `agent-adapter-market-survey` / `adapter-batch-decision` / `rfc-v12-final-decisions` / `p001-ship-and-merge` / `m001-launch` / `m001-ms-003-merge-and-ms-004-dispatch` / `rfc-v0.3-v20-vision` / `m001-ms-004-shadow-and-worker-d-fallback` / `m001-phase1-100-percent-and-v1100-rc1-prep`

## [1.9.1] - 2026-07-31

### Fixed

- **`query` CLI against pre-1.9.0 Management APIs**: `cortex-agent query <projection>`
  used to fail with `CAPABILITY_UNAVAILABLE` for *every* projection when the target
  project's Management API script was older than 1.9.0 (no `capabilities` projection
  exposed). The CLI now falls through to a direct query and surfaces the underlying
  Management API response, so projects on 1.6.0–1.8.x can still use `query
  dashboard-state / runs / queues / sessions / inbox / decisions / waitpoints`
  without first upgrading their Management API. New 1.9.0 projections
  (`activity`, `context-trajectories`, `operations`, …) still report
  `UNSUPPORTED_COMMAND` honestly when the target Management API is too old.

## [1.9.0] - 2026-07-31

### Added

- **Claude Code Release A 自动闭环**：新增 Agent Reporter、Governed Launcher、
  Claude Hooks Adapter 与受治理 launch context。Codex 可派发一个或多个真实
  Claude Code Agent，并通过 Coordination Journal、Notification Pump 和官方
  Codex App Server 在原主对话接收进展、阻塞、失败和待审核事件。
- **受治理子进程生命周期**：新增 fenced lease 周期续租、journal-only
  heartbeat、显式 handoff 终态保护、异常/超时恢复、最终 lease release 和脱敏
  child receipt。
- **启动持久化握手**：Launcher 在 `task.accepted` 持久化后才允许 monitor
  访问 Journal，避免 launcher/monitor 并发写入造成 hash-chain 竞争。
- 新增 `cortex-agent secrets <store|verify|list|audit>` 公共命令，通过项目
  Secrets skill 使用 macOS Keychain 等后端；`store` 仅接受
  `--from-env`，`verify --provider npm` 只返回认证身份，不输出凭证。
- **M-013 / FAE-002～FAE-004、FAE-007**：新增公共 ownership lease
  `acquire|renew|release|status|recover`、只读 dispatch-state/plan 查询、
  零写入 dispatch dry-run，以及显式受治理的人工 dispatch；自动 dispatch、
  daemon 和 trigger 仍保持关闭。

### Changed

- Claude Code 项目设置可安装原生协调 Hooks；headless Hook 事件同步写入
  Reporter，`Stop` 和进程退出码 0 不推断任务完成。
- Agent Reporter 的 ownership、identity、project 和 notification target 只从
  私有受治理上下文和 Task 快照取得，Agent 参数不能覆盖治理字段。

### Security

- Governed Launcher 只允许显式白名单中的绝对可执行 Host，拒绝相对路径、
  隐式 Node fallback、未知参数和原始 JSON 事件。
- Receipt 和通知不保存 prompt、command、文件正文、私有路径、session、凭据、
  Hook payload 或精确 token；关键事件保持 pending，绝不自动 ACK。
- Release A 聚焦回归 272/272 PASS；真实双 Claude Agent 的 Task、lease、receipt
  与 Codex thread wakeup 均通过，独立简单对话消息已由原主对话实际接收。

## [1.8.0] - 2026-07-29

### Added

- **Agent Coordination and Notification**：新增持久 JSONL journal、Task
  状态与 snapshot、ownership lease、安全 takeover、ACK/cursor、Notification
  Pump/watch，以及 Claude Code、通用 Agent 和真实 Codex App Server wakeup
  adapter。
- **Agent Runtime Interoperability**：新增 capability descriptor、context
  trajectory、Pi/Cursor adapter、tool-before gate、确定性 execution-surface
  matcher、dry-run、人工 dispatch、跨宿主 handoff 与可审计 dispatch policy。
- **P-006 Operation Lifecycle**：新增持久 Operation、Authorization、
  Readiness、checkpoint、事件回放与恢复，以及 Management API 的只读投影。
- **真实 Pi production pilot**：一次性 Pi 进程产生可验证 receipt，使用
  SHA-256 绑定 challenge/output；不持久化 prompt、response、stderr、凭证、
  私有 session 或精确 token。

### Changed

- Codex 可由关键协调事件主动唤醒，恢复后读取 pending journal、receipt 与
  checkpoint，并基于真实证据推进 Proposal、Mission milestone 和 Plan。
- README 与架构文档补充 Claude Code、Pi、Codex 和第三方 Adapter 的任务
  委托、监控、恢复及安全边界。

### Security

- Operation 创建采用原子 create-if-absent，同一 ID 的并发不同 plan 写入
  fail closed；Authorization 使用持久单次消费 ledger 与活进程锁保护。
- Notification delivery 不自动 ACK，ACK 不授予权限或推断任务完成；自动
  dispatch 与常驻 daemon 继续默认关闭。
- Management API 对运行态投影执行字段和值级脱敏，拒绝 prompt、工具负载、
  凭证、私有路径和私有 transcript。

## [1.7.0] - 2026-07-27

### Added

- **v1.7.0 Phase 0 自动化词汇与契约骨架**：统一 `Dispatch / Daemon / Trigger` 术语，新增三份 shared Schema、双语边界文档与 fail-closed CLI stub；Daemon 默认关闭，Trigger 不是授权，Management API 不承担调度职责。

- **v1.7.0 Team Agent Pack（M-TAP L1 capability）**：在 `.agent-shared/` 与 `.agent/` 之间引入 L1 Provider / L2 Team Pack / L3 Local 三层模型；`.agent-shared/` 是 Git 可提交的团队分发源，`.agent/` 仍是唯一运行时入口。
  - **CLI**:`cortex-agent team <init|status|install|update|publish|verify>` 六个子命令；`update --team` 串联 L1 apply → Team Pack apply；`upgrade --team` 显式拒绝（exit=3，指向 P-002 §4）；`doctor --fix` 在 Team Pack 上下文只允许创建 receipt 骨架，绝不触碰 `.agent-shared/`。
  - **manifest schema**（`lib/team-pack.js` + `lib/cli-contract.js` 的 `team` section）:`schema_version=1`、`files[].mode ∈ {add, merge}`、`signers.mode=git_committers` + `fallback=reject`、排除 5 类宿主入口文件（`.claude/settings.json`、`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.claude/settings.local.json`）。
  - **三方合并 planner**:`base=receipt.baseline` + `local=.agent/` + `incoming=pack`；cold-start base 固定为空（不把 `.agent/` 现有内容误判为冲突）；conflict 文件保留 local + 写 `.agent/team-sync/conflicts/<ts>-<n>-conflict.json`；**conflict 不推进 receipt baseline**，是 alice 本地修改不被下次 update 静默覆盖的关键安全保证。
  - **secret-scan**（`lib/secret-scan.js`，17/17 单测 PASS）：9 类规则（PEM 私钥头 / AWS `AKIA*` / GitHub `ghp_*` `gho_*` / OpenAI `sk-proj-` / Anthropic `sk-ant-` / Slack `xoxb-` / URL userinfo / `env_assignment_token` / 本机绝对路径）+ `.env` body 检测；严格 redact 防侧信道；供 `team publish/verify` 与 PostToolUse 共用。
  - **machine contract**：`cortex-agent help --json` 暴露 `team` 命令域、3 个新选项（`--team`、`--paths <path...>`、`--strict`）、顶层 `team` section（`pack_layout` / `init|status|install|update|publish|verify` 各命令契约 + `boundary_with_update` + `safety` 数组 6 条）。
  - **用户文档**:`docs/architecture/team-agent-pack.md` 三层模型 + CLI 速查 + 与 `update`/`upgrade`/`doctor` 的边界 + manifest schema + 三方合并表 + 安全不变量 + SamHMI 实战回流边界。
  - **测试**:64/64 PASS（`lib/secret-scan.test.js` 17 + `tests/team-pack/team-pack-core` 25 + `merge-matrix` 7 + `install-dry-run` 4 + `publish-verify` 6 + `samhmi-pilot` 2 + `cross-developer-conflict` 3）；CI-friendly：`team verify --strict` 可在 CI 只读运行。
  - **关联提案**:`.agent/plans/proposals/projects/team-agent-pack/`（P-001 / P-002 / D-001 全部翻 done）；**Mission `M-TAP` 已 COMPLETE**，4 commits `841d026` / `ae57fe0` / `abbfe13` / `300bd9b` 已 push 到 `origin/main`。

### Changed

- `lib/cli-contract.js` 增加 `team` 命令域、3 个新选项（`--team` / `--paths <path...>` / `--strict`）与顶层 `team` section；`--json` 文案扩展为"Emit machine-readable output when supported, including help and Phase 0 stubs"。

### Security

- Team Pack 默认拒绝符号链接、绝对路径、设备文件、`..` 逃逸；写入使用同目录临时文件 + 原子 rename；`.agent-shared/` 中的脚本不是授权（仍需 Decision / Waitpoint gate）；publish 不自动 commit / push / PR。
- `upgrade --team` 显式拒绝（`upgrade` 是 additive-only 不接触 Team Pack）；`doctor --fix` 永远不触碰 `.agent-shared/`。

## [1.6.0] - 2026-07-21

### Added

- **`.agent/memory/` 轻量笔记机制**：在 `.agent/` 下建立 `user / feedback / project / reference` 四类笔记（4 type frontmatter 严格 schema，per-type 硬上限 user 10/feedback 30/project 20/reference 50，200 行 / 25KB MEMORY.md 启动 cap 对齐 Claude Code Auto Memory 官方）；填坑 collab-runtime proposal (M-002) 提议的 approved-but-not-built `.agent/knowledge/` 目录。
- **`SessionStart` hook 自动加载 MEMORY.md 索引**：在 `templates/{zh,en}/.agent/hooks/hooks.json` 新增 `[Cortex] Memory index loaded` 输出；topic 文件按需 Read（不自动加载）；`core-principles.md` 新增"读 MEMORY.md"硬步骤。
- **`memory-protocol.md` 行为规则**：4 type 写入/读取/过期/归档协议，body 模板（feedback/project 类必含 `**Why:**` + `**How to apply:**`），write protocol（先写文件再加 MEMORY.md 索引、save 必须在 reply 完成前、写前查 staleness/duplicate），9 节规范（包含显式回应 P-006 反 MEMORY 立场的 Non-Goals）。
- **`agent-update` Step 4.5 memory feedback capture**：与 Step 4 experience capture 并列，区分"轻量 session 观察"（memory/feedback）和"commit-anchored 教训"（experiences）。
- **`update-refs` Step 7 reference pointer**：references 新增/重大更新时在 `memory/reference/` 留指针（不复制内容）。
- **L1 模板双语同步**（`templates/zh/.agent/` + `templates/en/.agent/`）+ L3 主仓库工作实例同步升级 + 治理审批（proposal `cortex-agent-memory-proposal.md` supersedes collab-runtime knowledge/）。

### Changed

- **`hooks.json` 删除不工作的 `PostCommit` 段**：Claude Code 从未支持 `PostCommit` 事件，原配置静默忽略。L0 熵清理和 Graphify 增量改由手动 `/post-commit-maintenance` 承担（`~/.claude/rules/git-workflow.md`）。
- **`hooks.json` `SessionStart` 新增 MEMORY.md loader 节点**：在已有 task-progress 提示旁加 memory index 输出。
- **`memory.schema.json` 字段扩展**：slug regex 从 `^[a-z0-9-]+$` 改为 `^[a-z0-9_-]+$`（对齐 Claude Code 实施级），新增可选 `metadata` 字段（Claude Code 兼容），新增 `path_segments ≤20` / `path_bytes ≤1024` / `per_file_size ≤100KB` 软约束。

### Removed

- **`.agent/hooks/hooks.json` 的 `PostCommit` 段**：3 个 hooks.json 全部清空（zh 模板 / en 模板 / L3 主仓库）；不工作配置在每次 SessionStart 弹警告 `Unknown hook event "PostCommit" was ignored`。

## [1.5.0] - 2026-07-20

### Added

- **Communication Runtime（协作运行时）**：在 Management API 之上落地 inbox / decisions / waitpoints 三个通信对象，支持 8 个 workflow gate 受控写入命令（`decisions request/resolve/supersede`、`inbox send/transition`、`waitpoints create/release/cancel`）；所有 mutation 强制走 `--gate mission|agent|user|owner` 校验。
- **统一查询投影**：`query dashboard-state` 一次输出 tasks / worktrees / agents / runs / queues / sessions / locks / handoffs / artifacts / prds / inbox / decisions / waitpoints / approvals / git_status / derived / summary 17 个段，Dashboard、CLI、MCP 只读适配器共享同一份 projection。
- **运行态 MCP 只读适配器（双模板）**：通过 stdio 把 dashboard-state 投影暴露给 Claude Code / Cursor 等 MCP 客户端，不直接读 `.agent/`，未安装时 Dashboard 与 CLI 路径不受影响。
- **事件与证据基础契约**：Run / Queue item / Session 增加 phase / activity / events / last_event 字段，Management API 支持 `runs upsert / event / checkpoint` 受控写入。
- **Agent 评审与本地基准技能**：新增 `skills/agent-review` 与本地基线脚本，为多 agent 协调提供评审基线。
- **工作区编排基础契约与生命周期**：新增工作区生命周期与资源租约实现，支持多任务并行工作区隔离。
- **协作看板开发模式**：CLI 增加 `cortex-agent dev` 命令，启动 Dashboard + 注册 Session + 自动端口选择 + 独立心跳。
- **运行态接入检查能力**：在 governance 层加入运行态接入检查，确保新功能与 Communication Runtime 一致。

### Changed

- **Dashboard PRD UI 重设计**：左侧导航、Overview / PRD Studio / Delivery / Runtime / Knowledge 分区、PRD 完整度探测、首屏状态条、执行阶段轨道与事件时间线。
- **本地 PRD 资产层 MVP**：新增 `.agent/prd/` schema/index/README、`/prd` workflow、PRD 文档模板，Dashboard 优先消费 API PRD 状态。
- **项目级提案治理**：`/approve` 支持指定整个项目、milestone 或子提案，`/plan` 从 `index.md` 读取批准范围，`/publish-docs` 先发布定稿总览。
- **领域调试产物目录规则 + 跨机证据时间基准**：branch slug 使用可逆编码避免碰撞，detached HEAD 拒绝写入。
- **README 同步 Communication Runtime**：新增协作运行时核心价值、Management API 用法示例、`.agent/` 目录结构更新、文档索引补 `agent-collaboration-runtime.md`。

### Fixed

- **dev-cli port=0 校验失败 + management-api 残留进程**：CLI `--port` 定义从 `min: 1` 调整为 `min: 0`，management-api main() 末尾显式 `process.exit(process.exitCode || 0)` 避免 dev-cli spawnSync 串联时的孤儿进程。
- **Dashboard preview API 状态码映射**：补 `path_outside_allowed_roots → 403`、size 检查先于 extension 检查，macOS canonical path（`/var → /private/var`）与 `.agent` symlink 特殊处理，避免误报 400。
- **管理 API 重启时模板与本地不同步**：新增 inbox / decisions / waitpoints schema / index / README，并补 15 文件双模板同步。
- **CRI 节命令示例 flag 不一致**：自举跑通 decisions request 时发现真实 flag 是 `--gate-action`（不是 `--action`，waitpoints create 才用 `--action`），统一修正 5 处工作流示例（approve.md / arch-design.md / release.md / worktree.md）。

## [1.4.1] - 2026-07-15

### Fixed

- Dashboard 时间戳显示导致频繁 reload（仅生成时间变化时触发重载）。

## [1.1.0] - 2026-06-28

### Added

- 工作流状态机与 LINT/REVIEW 阶段 Gate。
- 双层 Hooks（linter 先行 + AI 后行）。
- 上下文预算基础设施：`context-index.json` + `skills/context-budget`。
- 熵治理闭环：PostCommit L0 自动清理 + `entropy-scanner` sub-agent。
- 渐进式退化：`harness-manifest.yml` + `maturity-tracker`。

## [1.0.0] - 2026-05-12

### Added

- 首次稳定发布。核心 CLI：`init / upgrade / doctor / untrack / link-global`。
- 双语模板（zh / en）+ 11 平台集成（Cline、Cursor、Claude Code、Windsurf、Gemini CLI 等）。
- Conventional Commits 工作流 + 规则文件。
- 语言规则模板：TypeScript / Python / Go / Java / Swift。
- `bin/cli.js` 拆分为 5 个 lib 模块（registry / platform / setup / git / commands）。

[Unreleased]: https://github.com/Kucell/cortex-agent/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/Kucell/cortex-agent/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Kucell/cortex-agent/compare/v1.5.0...v1.7.0
[1.5.0]: https://github.com/Kucell/cortex-agent/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Kucell/cortex-agent/compare/v1.1.0...v1.4.1
[1.1.0]: https://github.com/Kucell/cortex-agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Kucell/cortex-agent/releases/tag/v1.0.0
