---
name: knowledge-lint
description: 对仓库知识结构做确定性检查，发现断链、缺 README、计划生命周期异常和架构文档引用失配，并输出 knowledge-health.json。
---

# Knowledge Lint

## 目标

为仓库知识系统提供第一版确定性检查，优先发现结构性问题，而不是直接重写文档。

## 检查范围

- Markdown 断链与失效锚点
- 关键知识目录缺少 README
- active/completed plan 生命周期异常
- `docs/architecture.md` 中对 workflow / sub-agent / skill 的失配引用

## 输出

脚本执行后会写入：

```text
.agent/metrics/knowledge-health.json
```

并在终端输出简要摘要。

## 使用方式

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

## 设计原则

- 只做确定性检查
- 保持零依赖
- 优先输出高信噪比问题
- 不自动重写大段文档

## 后续集成方向

- `/briefing` 读取 `knowledge-health.json`
- `/ship` 后执行轻量 knowledge lint
- doc-gardening 基于 lint 输出做小步维护
