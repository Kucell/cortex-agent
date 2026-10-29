# 项目模块索引

> 由 /scan-project 自动生成，最后更新：2026-06-08

## 模块列表

| 模块 | 类型 | 核心功能 | 文档 |
| :--- | :--- | :--- | :--- |
| cli-core | CLI 工具核心 | cortex-agent 全部命令的入口解析与执行逻辑 | [cli-core.md](./cli-core.md) |
| templates-zh | 中文模板集 | zh 模板集，包含完整的 workflows/skills/sub-agents/rules/hooks | [templates-zh.md](./templates-zh.md) |
| templates-en | 英文模板集 | en 模板集，与 zh 结构完全对称 | [templates-en.md](./templates-en.md) |
| agent-config | 项目 Harness 配置 | 本项目自身的 AI agent 治理配置（dogfooding）| [agent-config.md](./agent-config.md) |

## 全局技术栈

- **Runtime**: Node.js >= 14.0.0
- **语言**: JavaScript（CommonJS）+ Markdown + YAML + JSON
- **包管理**: npm（无外部运行时依赖）
- **发布**: npm registry（`npx cortex-agent`）
- **支持平台**: cursor, claude, windsurf, aider, copilot, continue, codex, cline, roo-code, amazon-q
