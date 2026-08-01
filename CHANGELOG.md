# Changelog

All notable changes to `cortex-agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
