# Changelog

All notable changes to `cortex-agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Kucell/cortex-agent/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Kucell/cortex-agent/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/Kucell/cortex-agent/compare/v1.1.0...v1.4.1
[1.1.0]: https://github.com/Kucell/cortex-agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Kucell/cortex-agent/releases/tag/v1.0.0