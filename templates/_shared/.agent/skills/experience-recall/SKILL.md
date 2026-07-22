---
name: experience-recall
description: 检索与当前任务相关的历史经验教训，避免重复犯错。基于标签、关键词和文件路径的混合匹配，返回 Top-K 相关经验及防复发检查项。
---

# Experience Recall

## 目标

在新任务开始前，主动检索历史经验，避免重蹈覆辙。

## 触发时机

- `/start-task` 第一步：识别风险时
- `agent-update` 需求分析阶段
- `architecture-guard` 审计
- 显式调用 `/experience-recall`

## 使用方式

```bash
# 基础检索（使用关键词）
node .agent/skills/experience-recall/scripts/index.js --query "schema handoff"

# 带标签检索
node .agent/skills/experience-recall/scripts/index.js --tags "schema,artifact-bus"

# 带文件路径检索
node .agent/skills/experience-recall/scripts/index.js --files ".agent/handoffs/scripts/handoff-protocol.js"

# 组合检索
node .agent/skills/experience-recall/scripts/index.js \
  --tags "schema,workflow" \
  --files ".agent/workflows/ship.md" \
  --query "L1 L3 分层"
```

## 输出

```json
{
  "matched_experiences": [
    {
      "id": "EXP-001",
      "title": "handoff JSON schema 与 artifact wrapper 不匹配",
      "relevance": 0.85,
      "matched_on": ["tags", "files"],
      "key_lesson": "任何在多个存储位置间流转的结构化数据，必须在第一个版本就定义统一的 schema 适配层...",
      "path": ".agent/experiences/EXP-001.md"
    }
  ],
  "warnings": [
    "⚠️  此任务涉及 handoff schema，请检查 EXP-001 教训"
  ],
  "total_experiences_scanned": 2
}
```

## 检索算法

| 维度 | 权重 | 说明 |
|------|------|------|
| 标签匹配 | 0.5 | 任务 tags 与经验 tags 的 Jaccard 相似度 |
| 关键词匹配 | 0.3 | 分词后扫描 title / key_lesson 字段 |
| 文件路径匹配 | 0.2 | modified_files 与 related_files 重合度 |

仅返回 `relevance >= 0.3` 的结果，最多返回 5 条。

## 经验存储位置

```text
.agent/experiences/
├── index.json        # 轻量索引（标签、路径、摘要）
├── TEMPLATE.md       # 创建新经验的模板
├── EXP-001.md        # 具体经验记录（ADR 风格）
└── EXP-002.md
```

## 设计原则

- 零依赖（仅 Node.js 内置模块）
- 读取 `experiences/index.json` 而非扫描所有 `.md` 文件（性能优先）
- 相关性低时静默退出（不打扰正常流程）
- 输出写入 `.agent/metrics/experience-recall-result.json`
