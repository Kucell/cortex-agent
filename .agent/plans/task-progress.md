# 任务进度

> **当前阶段**：Mission Lite 设计期（Phase 8 进行中）
> **整体进度**：99%
> **最后更新**：2026-05-19

---

## 🗺️ 路线图

### Phase 1：核心 CLI（✅ 已完成）

- [x] `cortex-agent init`：初始化 `.agent/` 目录 + 平台符号链接
- [x] `cortex-agent upgrade`：纯加法升级，不覆盖已有文件
- [x] `cortex-agent doctor`：健康检查
- [x] `cortex-agent untrack` / `track`：Git 追踪管理
- [x] 双语模板（zh / en）

### Phase 2：Claude Code 深度集成（✅ 已完成）

- [x] `hooks.json` 模板 + `PostToolUse` 质量检查 Hook
- [x] `init` 时自动生成 `.claude/settings.json` 并注入 Hooks
- [x] `.claude-plugin/plugin.json` + 根目录插件发现入口（agents / commands / skills / hooks）
- [x] `commit.md` 工作流 —— AI 生成 Conventional Commits，禁 AI 署名
- [x] `commit-standards.md` 规则文件
- [x] 完善 `pre-commit-check.sh`：支持 Python ruff、Go vet、Java checkstyle、Swift swiftlint（T-001）

### Phase 3：平台管理与语言规则（✅ 已完成）

- [x] 多平台支持：Cline、Roo Code、Amazon Q Developer、Aider、Copilot、Continue
- [x] `PLATFORM_REGISTRY`：平台注册表统一管理
- [x] `cortex-agent add / remove / list`：平台增删查
- [x] `init` 交互选择平台 + `--platforms` 非交互模式
- [x] `.agent/.platforms` 状态文件持久化已安装平台
- [x] 语言规则模板：TypeScript / Python / Go（zh + en）
- [x] `configure.md` 加入语言选择步骤
- [x] 新增 Java、Swift 语言规则（T-002）
- [x] `configure.md` 自动写入语言规则到 `tech-stack.md`（T-003）

### Phase 4：代码架构优化（✅ 已完成）

- [x] `bin/cli.js` 拆分为 5 个 lib 模块（registry / platform / setup / git / commands）
- [x] `package.json` files 字段补全 lib/、hooks/、agents、commands、skills、.claude-plugin

### Phase 5：发布与分发（🔥 进行中）

- [x] 确认 npm 包名 `cortex-agent` 可用（T-004）
- [x] 发布到 npm registry —— `npx cortex-agent` 现已可用（T-006）
- [x] 完善 `package.json`：author、homepage、repository、files 字段（T-007）
- [ ] `README.md` 补充快速上手 GIF 演示（T-005）
- [ ] Claude Code 插件市场上架（T-008）

### Phase 6：Harness Engineering 优化（✅ 已完成）

> 设计方案：`docs/architecture/harness-optimization-design.md`
> 优先级顺序：P0 → P1 → P2 → P3

**P0 — 基础设施（已在进行）**

- [x] Skill 精简：合并 architecture-audit + architecture-check → `architecture-guard`（T-H01）
- [x] 新增 `skills/phase-gate`：阶段状态机前置条件检查（T-H01）
- [x] 新增 `config/reasoning-config.yml`：推理三明治成本模式配置（T-H02）
- [x] `sub-agents/planner.md`：模型 haiku → sonnet，引用 architecture-guard（T-H02）
- [x] `sub-agents/code-reviewer.md`：结构化评分输出 + 输入隔离声明（T-H03）
- [x] `workflows/ship.md`：状态机 + max_retry + LINT/REVIEW 阶段 Gate（T-H02）
- [x] `hooks/hooks.json`：双层 Hooks（linter 先行 + AI 后行）（T-H01）
- [x] 上下文预算基础设施：`context-index.json` + `skills/context-budget/`（T-H04）
- [x] `/start-task` 改造：插入 context-manifest 生成步骤（T-H04）
- [x] `/scan-project` 改造：reference 生成时自动加 frontmatter（T-H04）
- [x] `/update-refs` 改造：同步刷新 frontmatter 和 context-index（T-H04）

**P1 — 完整防火墙（Sub-agent 输出契约）**

- [x] `sub-agents/planner.md` 增加结构化输出摘要（plan_summary JSON 契约）（T-H05）
- [x] `sub-agents/implementer.md` 增加结构化输出摘要（execution_report JSON 契约）（T-H05）
- [x] `workflows/ship.md` DONE 后增加 context_cleanup 步骤（T-H05）
- [x] 新增 `sub-agents/routing-defaults.yml`：自动路由配置（保留 5 个 sub-agent）（T-H05）

**P2 — 熵治理闭环**

- [x] 新增 `sub-agents/entropy-scanner.md`：扫描逻辑 + 分级策略（T-H06）
- [x] 新增 `entropy-config.yml`：扫描频率 + L0-L3 分级规则（T-H06）
- [x] `hooks/hooks.json` 增加 PostCommit L0 自动清理（T-H06）
- [x] `workflows/ship.md` 追加 ENTROPY_SCAN → CLEAN 状态（T-H06）
- [x] `workflows/briefing.md` 增加知识库健康度板块（T-H06）

**P3 — 渐进式退化 + Workflow 精简**

- [x] 新增 `harness-manifest.yml`：全组件退化条件 + 路径 + 回滚策略（T-H07）
- [x] 新增 `skills/maturity-tracker/`：组件表现指标收集（T-H07）
- [x] `workflows/briefing.md` 增加成熟度看板（T-H07）
- [x] Workflow 精简（降级重定向）：/code-review /done /sync-plans /parallel /weekly-report 加入"推荐用 /ship"提示（T-H08）

### Phase 7：知识架构与可理解性地基（✅ 已完成）

> 设计方案：`docs/architecture/harness-optimization-design.md`
> 目标：先补齐知识架构，再继续推进 application legibility 与 knowledge lint

- [x] 建立 `docs/quality`、`docs/reliability`、`docs/security`、`docs/exec-plans` 与 `docs/tech-debt.md` 基础骨架（T-H09）
- [x] 更新 `docs/architecture.md` 与 `docs/architecture/harness-optimization-design.md`，同步到当前真实实现（T-H10）
- [x] 新增 active exec plan，并把技术债务统一沉淀到 `docs/tech-debt.md`（T-H11）
- [x] 设计 knowledge lint 与 doc-gardening 的下一轮落地方案（T-H12）
- [x] 实现第一版 `knowledge-lint` skill 与 `knowledge-health.json` 输出（T-H13）
- [x] 将 `knowledge-health.json` 接入 `/briefing` 工作流说明（T-H14）
- [x] 将轻量 `knowledge-lint` 接入 `/ship` 工作流说明（T-H15）
- [x] 实现第一版 `doc-gardening` skill，并接入 `/briefing` 与 `/ship`（T-H16）
- [x] 新增知识维护 Runbook，为 heartbeat / cron 接入提供统一入口（T-H17）

### Phase 8：Mission Lite 长周期任务编排（🔥 设计中）

> 设计入口：`docs/architecture.md`、`docs/architecture/mission-lite-design.md`、`docs/architecture/harness-optimization-design.md`
> 目标：在现有 `/start-task`、`/ship`、`/handoff` 之上，补齐多 milestone 长周期任务的验证契约、结构化交接和独立验证机制。

- [x] Mission Lite 架构设计：三角色模型、状态机、核心产物、验证契约与边界（T-H24）
- [x] 新增 `validation-contract` skill：定义 CREATE / CHECK / SUMMARIZE 三种模式和 JSON 契约模板（T-H25）
- [x] 新增 `/mission` workflow：覆盖 SCOPE / PLAN / CONTRACT / EXECUTE / VALIDATE 状态（T-H26）
- [x] 扩展 planner / reviewer 输出契约：planner 产出 validation contract，reviewer 按 contract 验证（T-H27）
- [x] 命令日志与 milestone 模板标准化：提供 `mission-plan.md`、`command-log.md` 与 `milestones/MS-xxx.md` 模板（T-H28）

---

## 🔥 当前活跃任务

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-008 | P3 | Claude Code 插件市场上架 | 0% |

## 🧭 下一阶段候选（Application Legibility）

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-H18 | P0 | 日志可理解性基线 | 100% |
| T-H19 | P0 | 浏览器验证基线 | 100% |
| T-H20 | P1 | 指标可理解性基线 | 100% |
| T-H21 | P1 | Trace / Request Chain 基线 | 100% |
| T-H22 | P1 | runtime evidence 接入 `/briefing` / `/ship` 设计 | 100% |
| T-H23 | P2 | 验证模板标准化 | 0% |

## 🧭 下一阶段候选（Multi-Agent Coordinator · 协调层）

> 入口设计：`docs/architecture/multi-agent-coordinator.md`
> 目标：解决"多 agent + 多模型切换后任务做了一半"的协调问题，叠加而非推翻现有 `/parallel` / `/mission` / `session-manager`

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-C01 | P0 | Multi-Agent Coordinator 设计文档 | 100% |
| T-C02 | P0 | `coordinator` sub-agent 定义 | 0% |
| T-C03 | P0 | Agent Registry（`.agent/registry/agents.json` + check-in/out 脚本） | 0% |
| T-C04 | P0 | Artifact Bus（`artifact-schema.json` + 读写辅助） | 0% |
| T-C05 | P1 | Progress Lock（`acquire/renew/release` + TTL） | 0% |
| T-C06 | P0 | handoff skill 升级：双产物 + `AGENT_RESUME` 模式 | 0% |
| T-C07 | P1 | `routing-defaults.yml` 扩展 `model_registry` | 0% |
| T-C08 | P1 | `/mission` 状态机改造：显式 HANDOFF + RESUME 状态 | 0% |
| T-C09 | P1 | 端到端验证：Claude → Codex 切换场景 | 0% |
| T-C10 | P2 | `/briefing` 接入 coordinator 健康度板块 | 0% |

---

## ✅ 最近完成

- **T-005**：README 快速上手演示落地（SVG/CSS 动画版），新增 `docs/assets/quick-start.svg` + `docs/assets/README.md`，README "快速开始" 节嵌入 5 步上手流程
- **T-C01**：完成 Multi-Agent Coordinator 设计稿，新增 `docs/architecture/multi-agent-coordinator.md`，定义 Agent Registry / Artifact Bus / Progress Lock / Handoff 协议四个核心构件，与现有 `/parallel` / `/mission` / `session-manager` 关系明确，10 个子任务 T-C02~T-C10 拆解完成
- **T-H24**：完成 Mission Lite 架构设计，新增 `docs/architecture/mission-lite-design.md`，补充三角色模型、验证契约、命令日志、milestone 状态机与 `/handoff` 衔接方式
- **T-H25**：新增 `validation-contract` skill，定义 CREATE / CHECK / SUMMARIZE 模式、assertion 类型、契约规则和最小 JSON 模板
- **T-H26**：新增 `/mission` workflow，定义 create / status / resume / validate 子命令、mission 状态机、文件结构和质量标准
- **T-H27**：扩展 planner / code-reviewer 输出契约，planner 可产出 `validation_contract`，reviewer 可输出 `contract_results`
- **T-H28**：新增 Mission Lite 模板集，标准化 `mission-plan.md`、`command-log.md` 和 `milestones/MS-xxx.md`，并在 `/mission` workflow 中引用
- **Phase 7 知识架构地基**：补齐 `docs/quality` / `reliability` / `security` / `exec-plans` / `tech-debt`，并更新架构与设计文档（T-H09/10/11）
- **T-H12**：完成 knowledge lint / doc-gardening 设计，明确检查范围、触发方式与后续落点
- **T-H13**：实现第一版 `knowledge-lint` 技能，提供断链、README、计划生命周期和架构文档一致性检查
- **T-H14**：将知识健康度接入 `/briefing`，使 knowledge lint 结果进入每日可见面
- **T-H15**：将轻量 knowledge lint 接入 `/ship`，使交付后可自动刷新知识健康度
- **T-H16**：实现第一版 `doc-gardening` 技能，输出整理建议并接入 `/briefing` / `/ship`
- **T-H17**：新增知识维护 Runbook，明确 heartbeat / cron 的输入、边界与 prompt 约定
- **2026-04-21**：完成 application legibility 的 Phase 8 路线图与任务拆解，明确 logs / browser / metrics / traces 的推进顺序
- **T-H18**：完成日志可理解性基线，明确日志入口、字段优先级、排查顺序和标准输出模板
- **T-H19**：完成浏览器验证基线，明确页面入口、交互顺序、截图留证和标准输出模板
- **T-H20**：完成指标可理解性基线，明确指标分层、健康度表达方式和标准输出模板
- **T-H21**：完成 Trace / Request Chain 基线，明确 request_id / trace_id 优先级、链路排查顺序和断点判断模板
- **T-H22**：完成 runtime evidence 接入设计，明确 `/briefing` 与 `/ship` 应优先消费结构化 runtime summary
- **Harness Engineering Phase 6**：上下文预算、推理三明治、防火墙、熵治理与渐进式退化全部落地（T-H01 ~ T-H08）
- **npm 正式发布** —— `npx cortex-agent` 全球可用（kucelleric/cortex-agent）
- `cortex-agent add / remove / list` 命令实现
- `cortex-agent track` 命令实现（开启 .agent Git 追踪）
- 多平台注册表（PLATFORM_REGISTRY）+ 9 个平台支持
- init 交互选择平台 + --platforms 非交互模式
- .agent/.platforms 状态文件持久化
- bin/cli.js → lib/（registry / platform / setup / git / commands）模块拆分
- package.json files 字段补全（修复发布缺失 lib/ 的 Bug）

## ✅ 历史已完成

- 核心 CLI 命令（init / upgrade / doctor / untrack / link-global）
- 双语模板体系（zh + en）
- Claude Code Hooks 自动配置（hooks.json + settings.json 生成）
- Claude Code 插件入口（plugin.json + 根目录符号链接）
- Conventional Commits 工作流 + 规则文件（禁 AI 署名）
- 语言规则模板（TypeScript / Python / Go）
- configure.md 语言选择步骤

---

## ⚠️ 风险与阻塞

- **[Knowledge] knowledge lint 与 doc-gardening 已接入 `/briefing` 与 `/ship` 说明层**：真实 heartbeat / cron automation 仍未创建
- **[Runtime] runtime evidence 摘要文件尚未实现**：`runtime-health.json` / `browser-verification.json` / `verification-summary.json` 仍停留在设计层
- **[Mission Lite] 当前为模板级编排**：`/mission`、验证契约和模板已可用，但尚未引入自动脚本或 CLI 状态管理
- **[Coordinator] T-C02~T-C10 暂存中**：Multi-Agent Coordinator 设计稿已落地（`docs/architecture/multi-agent-coordinator.md`），用户决策走 **C 模式（暂存）**——等 T-005 / T-008 收尾后启动 T-C02 → C03 → C04 → C06 串行基线，再并行 C05/C07/C08，最后 C09/C10
- **[Harness] upgrade 不覆盖已有文件**：改造文件（ship.md/planner.md 等）在已安装用户侧不会自动同步，需版本说明或迁移指南
- **[Harness] context-index.json 准确性**：reference frontmatter 的 `estimated_tokens` 依赖人工维护，初期可能不准确
- **[Harness] 推理三明治成本**：balanced 模式比原来贵约 1.5-2x，需在 README 中明确说明
- npm 包名 `cortex-agent` 可能已被占用 → 发布前必须先检查
- Claude Code 插件市场上架流程尚不明确（官方文档不完整）
- `bin/cli.js` 的 `#!/usr/bin/env node` shebang 依赖系统 PATH，Volta 用户需确认兼容性
