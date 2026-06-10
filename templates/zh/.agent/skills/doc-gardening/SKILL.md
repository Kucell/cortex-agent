---
name: doc-gardening
description: 基于 knowledge-health.json 生成文档整理建议，输出 doc-gardening-report.json，帮助团队持续做低风险知识维护。
---

# Doc-Gardening

## 目标

把 knowledge lint 的结构性发现转成可执行的整理建议，让知识维护进入稳定、低风险、可见的节奏。

## 输入

- `.agent/metrics/knowledge-health.json`

如果 knowledge health 尚未生成，先运行：

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

## 输出

脚本执行后会写入：

```text
.agent/metrics/doc-gardening-report.json
```

并在终端输出建议摘要。

## 使用方式

```bash
node .agent/skills/doc-gardening/scripts/index.js
```

## 设计原则

- 只生成建议，不自动大改文档
- 优先输出高回报、低风险动作
- 和 knowledge lint 保持解耦，但复用其结果
- 输出必须进入仓库指标文件，而不是只停留在对话里

## 适用动作

- 修复断链与失效锚点
- 补知识域 README
- 提醒 plan 生命周期迁移
- 提醒同步架构文档与真实结构
