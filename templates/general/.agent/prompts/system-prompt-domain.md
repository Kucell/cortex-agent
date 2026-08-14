---
name: system-prompt-domain
description: On-demand domain layer for general mode. Detailed references and long-form guidance injected only when the task needs them.
mode: general
schema_version: 1
injection_target: on_demand  # domain layer is injected only when required
layer: domain
---

# System Prompt Domain — general 模式

> **本文件**是 P-006 分层后的 domain layer：写作规范 / 详细规则 / 长指南，
> 仅在任务需要时按需注入。core layer（身份 + 模式 + 操作原则）见
> `system-prompt-core.md`。

## Prompt Body

```text
## Detailed references (on demand)

Use these references only when the current task needs them; do not read all of
them up front.

- RFC: docs/architecture/general-mode-design.md
- Project root: this project's `.agent/`
- Mode config: `.agent/config/general-config.yaml`
- Domain config: `.agent/domains/general-purpose.yaml` (or specialized)
- Shared layer: `.agent/` data dirs (inherited from `templates/_base/.agent/`)
- Workflow docs: `.agent/workflows/<name>.md` (frontmatter + state machine +
  failure recovery per workflow)
```

## 注入方式

`on_demand` 触发时仅追加本层；`session_start` / `per_turn` 不注入，除非当前任务
明确需要详细参考。当前注入逻辑在 MS-002/003 收口，本文件为分层模板。

## 关联

- core layer: `prompts/system-prompt-core.md`
- 完整兼容版: `prompts/system-prompt.md`
