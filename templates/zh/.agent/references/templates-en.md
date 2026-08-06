---
module: templates-en
module_path: templates/en/.agent
module_type: 英文模板集
keywords:
  - template
  - english
  - workflows
  - skills
  - sub-agents
  - rules
  - hooks
  - config
estimated_tokens: 400
last_updated: 2026-06-08
last_commit: 957cc7b
dependencies: []
summary: "cortex-agent 英文模板集，与 templates/zh 结构完全对称，内容以英文表达"
status: stable
owner: Codex
last_verified: 2026-06-08
verified_by: Codex
sources:
  - templates/en/.agent/
linked_decisions:
  - D-M002-self-bootstrap
---

# templates-en 架构参考

> **项目路径**: `templates/en/.agent`
> **模块类型**: 英文模板集
> **核心功能**: `cortex-agent init --lang=en` 时复制到目标项目的完整 .agent/ 框架
> **文档生成时间**: 2026-06-08
> **对应 git commit**: 957cc7b

---

## 🎯 模块概述

英文版 Agent Harness 模板集，与 `templates/zh` 结构完全对称，所有规则、工作流、技能、子代理和钩子均以英文编写。在非中文系统或显式指定 `--lang=en` 时使用。

## 🏗️ 核心架构

目录结构与 `templates/zh` 完全相同，参见 [[templates-zh]]。

关键差异点：
- 所有 Markdown 内容以英文撰写
- `rules/language.md` 指定 `lang: en`
- 同步维护节奏：zh 有改动须同步到 en

## 🛡️ 关键约束与注意事项

- 与 `templates/zh` 保持结构同步是开发者责任（无自动同步机制）
- 新增技能或工作流时，必须同时在 zh 和 en 两侧添加
