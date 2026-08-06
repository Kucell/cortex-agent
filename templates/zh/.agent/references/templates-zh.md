---
module: templates-zh
module_path: templates/zh/.agent
module_type: 中文模板集
keywords:
  - 模板
  - 中文
  - workflows
  - skills
  - sub-agents
  - rules
  - hooks
  - config
  - 工作流
  - 技能
  - 规则
estimated_tokens: 700
last_updated: 2026-06-08
last_commit: 957cc7b
dependencies: []
summary: "cortex-agent 中文模板集，包含完整的 workflows/skills/sub-agents/rules/hooks 配置"
status: stable
owner: Codex
last_verified: 2026-06-08
verified_by: Codex
sources:
  - templates/zh/.agent/
linked_decisions:
  - D-M002-self-bootstrap
---

# templates-zh 架构参考

> **项目路径**: `templates/zh/.agent`
> **模块类型**: 中文模板集
> **核心功能**: `cortex-agent init --lang=zh` 时复制到目标项目的完整 .agent/ 框架
> **文档生成时间**: 2026-06-08
> **对应 git commit**: 957cc7b

---

## 🎯 模块概述

中文版 Agent Harness 模板集，包含所有规则、工作流、技能、子代理和钩子的完整实现。与 `templates/en` 结构完全对称，内容以中文表达。`cortex-agent init` 默认在中文系统环境下使用此模板。

## 🛠️ 技术栈

- 纯 Markdown 配置文件 + YAML + JSON
- Node.js 脚本（knowledge-lint / doc-gardening 的 scripts/ 目录）

## 🏗️ 核心架构

### 目录结构
```
templates/zh/.agent/
├── config/               # reasoning-config.yml（模型配置）
├── hooks/                # hooks.json（PostToolUse + PostCommit）
├── metrics/              # knowledge-health.json / doc-gardening-report.json 模板
├── plans/                # task-progress.md 模板
├── plugins/              # 插件配置
├── resources/templates/  # Mission Lite 模板（mission-plan / command-log / MS-xxx）
├── rules/                # 核心规则（architecture-design / code-standards / language / tech-stack 等）
│   └── languages/        # TypeScript / Python / Go / Java / Swift 规范
├── skills/               # 16 个专项技能
│   ├── architecture-guard/
│   ├── context-budget/
│   ├── doc-gardening/      # scripts/index.js
│   ├── knowledge-lint/     # scripts/index.js
│   ├── validation-contract/
│   └── ...
├── sub-agents/           # planner / implementer / researcher / code-reviewer / documenter / entropy-scanner / session-manager
└── workflows/            # 24 个工作流命令（/ship / /start-task / /briefing / /mission 等）
```

### 关键工作流
| 工作流 | 功能 |
|--------|------|
| `ship.md` | 状态机交付流程：PLAN→IMPLEMENT→LINT→REVIEW→ENTROPY_SCAN→CLEAN |
| `start-task.md` | 任务启动 + context-manifest 生成 |
| `briefing.md` | 每日简报 + 知识库健康度看板 |
| `mission.md` | 长周期任务编排（create/status/resume/validate）|
| `handoff.md` | 跨 agent / 跨会话轻量交接 |
| `configure.md` | 项目初始化配置向导 |

### 关键技能
| 技能 | 功能 |
|------|------|
| `architecture-guard` | 架构守护 + Phase Gate |
| `context-budget` | 上下文预算 Tier 0-3 裁剪 |
| `validation-contract` | CREATE/CHECK/SUMMARIZE 验证契约 |
| `knowledge-lint` | 断链 + README + 计划 + 架构一致性检查 |
| `doc-gardening` | 文档整理建议生成 |
| `maturity-tracker` | 组件表现指标收集 |

## 📌 关键文件路径

- 推理配置: `config/reasoning-config.yml`
- 路由配置: `sub-agents/routing-defaults.yml`
- Claude 入口: `integrations/claude/CLAUDE.md`（引导 Claude Code 加载 `.agent/`）
- hooks: `hooks/hooks.json`

## 🛡️ 关键约束与注意事项

- `upgrade` 不覆盖已有文件，已安装用户需手动同步改造后的 ship.md / planner.md
- `scripts/index.js` 由 Node.js 直接执行，无需构建，输出写入 `metrics/` 目录
- 与 `templates/en` 结构完全对称，任何新增技能/工作流须同时更新两侧
