---
name: system-prompt-domain
description: general 模式按需注入的 domain 层(中文版)。详细参考与长篇幅指南,仅在任务需要时注入。
mode: general
schema_version: 1
language: zh
injection_target: on_demand  # domain 层仅在需要时注入
layer: domain
---

# System Prompt Domain — general 模式(中文版)

> **本文件**是 P-006 分层后的 domain layer:写作规范 / 详细规则 / 长指南,
> 仅在任务需要时按需注入。core layer(身份 + 模式 + 操作原则)见
> `system-prompt-core.zh.md`。

## Prompt Body

```text
## 详细参考(按需读取)

仅当前任务需要时再读取以下参考,不要一次性全部读完。

- RFC: docs/architecture/general-mode-design.md
- 项目根: 本项目的 `.agent/`
- 模式配置: `.agent/config/general-config.yaml`
- Domain 配置: `.agent/domains/general-purpose.yaml`(或 specialized)
- 共享层: `.agent/` data 目录(从 `templates/_base/.agent/` 继承)
- Workflow 文档: `.agent/workflows/<name>.md`(每个 workflow 的
  frontmatter + 状态机 + 失败回滚规则)
```

## 注入方式

`on_demand` 触发时仅追加本层;`session_start` / `per_turn` 不注入,除非当前任务
明确需要详细参考。当前注入逻辑在 MS-002/003 收口,本文件为分层模板。

## 关联

- core layer: `prompts/system-prompt-core.zh.md`
- 完整兼容版: `prompts/system-prompt.zh.md`
