# 任务进度

> **当前阶段**：已发布 → 推广与迭代期
> **整体进度**：90%
> **最后更新**：2026-03-19

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
- [ ] 完善 `pre-commit-check.sh`：支持 Python ruff、Go vet（T-001）

### Phase 3：平台管理与语言规则（✅ 已完成）

- [x] 多平台支持：Cline、Roo Code、Amazon Q Developer、Aider、Copilot、Continue
- [x] `PLATFORM_REGISTRY`：平台注册表统一管理
- [x] `cortex-agent add / remove / list`：平台增删查
- [x] `init` 交互选择平台 + `--platforms` 非交互模式
- [x] `.agent/.platforms` 状态文件持久化已安装平台
- [x] 语言规则模板：TypeScript / Python / Go（zh + en）
- [x] `configure.md` 加入语言选择步骤
- [ ] 新增 Java、Swift 语言规则（T-002）
- [ ] `configure.md` 自动写入语言规则到 `tech-stack.md`（T-003）

### Phase 4：代码架构优化（✅ 已完成）

- [x] `bin/cli.js` 拆分为 5 个 lib 模块（registry / platform / setup / git / commands）
- [x] `package.json` files 字段补全 lib/、hooks/、agents、commands、skills、.claude-plugin

### Phase 5：发布与分发（🔥 进行中）

- [x] 确认 npm 包名 `cortex-agent` 可用（T-004）
- [x] 发布到 npm registry —— `npx cortex-agent` 现已可用（T-006）
- [x] 完善 `package.json`：author、homepage、repository、files 字段（T-007）
- [ ] `README.md` 补充快速上手 GIF 演示（T-005）
- [ ] Claude Code 插件市场上架（T-008）

---

## 🔥 当前活跃任务

| 任务 ID | 优先级 | 描述 | 进度 |
| :--- | :--- | :--- | :--- |
| T-005 | P1 | README 补充快速上手 GIF 演示 | 20% |
| T-001 | P1 | 完善 pre-commit-check.sh 多语言支持（ruff、go vet） | 0% |
| T-002 | P1 | 新增 Java / Swift 语言规则模板（zh + en） | 0% |
| T-003 | P2 | configure.md 自动激活语言规则逻辑 | 30% |
| T-008 | P3 | Claude Code 插件市场上架 | 0% |

---

## ✅ 最近完成

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

- npm 包名 `cortex-agent` 可能已被占用 → 发布前必须先检查
- Claude Code 插件市场上架流程尚不明确（官方文档不完整）
- `bin/cli.js` 的 `#!/usr/bin/env node` shebang 依赖系统 PATH，Volta 用户需确认兼容性
