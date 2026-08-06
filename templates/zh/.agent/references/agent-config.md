---
module: agent-config
module_path: .agent
module_type: "项目 Harness 配置"
keywords:
  - harness
  - rules
  - workflows
  - skills
  - sub-agents
  - hooks
  - plans
  - metrics
  - task-progress
  - ship
  - briefing
  - entropy
  - context-budget
estimated_tokens: 600
last_updated: 2026-06-08
last_commit: 957cc7b
dependencies:
  - templates-zh
summary: "cortex-agent 项目自身的 Agent Harness 配置，由 zh 模板安装，当前活跃运行"
status: stable
owner: Codex
last_verified: 2026-06-08
verified_by: Codex
sources:
  - .agent/
  - templates/zh/.agent/
linked_decisions:
  - D-M002-self-bootstrap
---

# agent-config 架构参考

> **项目路径**: `.agent/`
> **模块类型**: 项目 Harness 配置（cortex-agent 自用）
> **核心功能**: 本项目自身的 AI agent 治理配置（harness 即产品，亦即 dogfooding）
> **文档生成时间**: 2026-06-08
> **对应 git commit**: 957cc7b

---

## 🎯 模块概述

cortex-agent 项目自身使用 zh 模板安装的 Harness。这是一个典型的 dogfooding 配置：产品即框架，框架即治理自身开发过程。`.agent/` 是由 `templates/zh` 复制并在本项目持续演进的活跃配置。

## 🏗️ 核心架构

### 关键状态文件
| 文件 | 用途 |
|------|------|
| `plans/task-progress.md` | 项目路线图 + 活跃任务 + 已完成记录（整体进度 99%）|
| `metrics/component-health.json` | Harness 组件表现指标（当前无记录，待首次 /ship 后初始化）|
| `metrics/knowledge-health.json` | Knowledge Lint 健康度（最近一次：100/100）|
| `metrics/doc-gardening-report.json` | Doc-Gardening 建议（最近一次：healthy）|
| `context-index.json` | 模块上下文索引（由 /scan-project 维护）|

### 活跃工作流（Phase 8 完成后状态）
- `/ship`：状态机交付，含 ENTROPY_SCAN + CLEAN
- `/briefing`：每日简报，含 Knowledge Health + Harness 成熟度看板
- `/mission`：长周期任务编排（create / status / resume / validate）
- `/start-task`：任务启动 + context-manifest

### 关键 Sub-agents
planner（sonnet）、implementer、researcher、code-reviewer（结构化评分）、entropy-scanner、session-manager

### Hooks
- **PostToolUse**：Lint 先行（ESLint / prettier / ruff 等）
- **PostCommit**：L0 熵清理（自动修复漂移的 reference frontmatter）

## 📌 关键文件路径

- 进度追踪: `.agent/plans/task-progress.md:1`
- 推理模型配置: `.agent/config/reasoning-config.yml`
- Harness 组件声明: `.agent/harness-manifest.yml`
- 熵治理配置: `.agent/entropy-config.yml`
- context 索引: `.agent/context-index.json`

## 🛡️ 关键约束与注意事项

- 当前 Phase：8（Mission Lite 设计完成），整体进度 99%
- 活跃任务：T-005（README GIF 20%）、T-008（插件市场 0%）
- `runtime-health.json` / `browser-verification.json` 仍在设计层，未实现
- `.agent/references/` 由 `/scan-project` 维护，用 `/update-refs` 增量刷新
