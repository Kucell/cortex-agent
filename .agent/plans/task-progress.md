# 任务进度

> **当前阶段**：Harness Engineering 优化期（Phase 6 完成）
> **整体进度**：90%
> **最后更新**：2026-03-27

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

### Phase 6：Harness Engineering 优化（🔥 进行中）

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

---

## 🔥 当前活跃任务

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-H01 | P0 | **[待提交]** Skill精简 + phase-gate + 双层Hooks | 95% |
| T-H02 | P0 | **[待提交]** 推理三明治：reasoning-config + planner模型升级 + ship状态机 | 90% |
| T-H03 | P0 | **[待提交]** code-reviewer结构化输出 + 输入隔离 | 100% |
| T-H04 | P0 | 上下文预算控制：context-index + context-budget skill + workflows改造 | 100% |
| T-H05 | P1 | Sub-agent防火墙：输出摘要器契约 + 上下文清洗 + 路由配置 | 100% |
| T-H06 | P2 | 熵治理闭环：entropy-scanner + PostCommit hook + briefing集成 | 100% |
| T-H07 | P3 | 渐进式退化：harness-manifest + maturity-tracker | 100% |
| T-H08 | P3 | Workflow精简：降级重定向 | 100% |
| T-005 | P1 | README 补充快速上手 GIF 演示 | 20% |
| T-001 | P1 | 完善 pre-commit-check.sh 多语言支持（ruff、go vet） | 100% |
| T-002 | P1 | 新增 Java / Swift 语言规则模板（zh + en） | 100% |
| T-003 | P2 | configure.md 自动激活语言规则逻辑 | 100% |
| T-008 | P3 | Claude Code 插件市场上架 | 0% |

---

## ✅ 最近完成

- **Harness Engineering P0 基础设施**：architecture-guard + phase-gate + reasoning-config + ship状态机 + code-reviewer结构化输出（T-H01/02/03，待提交）
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

- **[Harness] upgrade 不覆盖已有文件**：改造文件（ship.md/planner.md 等）在已安装用户侧不会自动同步，需版本说明或迁移指南
- **[Harness] context-index.json 准确性**：reference frontmatter 的 `estimated_tokens` 依赖人工维护，初期可能不准确
- **[Harness] 推理三明治成本**：balanced 模式比原来贵约 1.5-2x，需在 README 中明确说明
- npm 包名 `cortex-agent` 可能已被占用 → 发布前必须先检查
- Claude Code 插件市场上架流程尚不明确（官方文档不完整）
- `bin/cli.js` 的 `#!/usr/bin/env node` shebang 依赖系统 PATH，Volta 用户需确认兼容性
