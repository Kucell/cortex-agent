---
name: context-budget
description: 基于启发式规则的上下文预算控制。为任务选择最相关的 reference 文档，防止上下文溢出导致 AI 性能下降。使用确定性规则（零额外 token），输出 context-manifest.json。
---

# 上下文预算控制 (Context Budget Skill)

## 目标

在 `/start-task` 的规划阶段，从 `.agent/references/` 中智能选择最相关的上下文文档，将注入量控制在模型上下文窗口的 40% 以内。

## 为什么需要预算控制

Harness Engineering 研究表明：**Agent 性能在上下文利用率超过 40% 后开始下降**。
- 不相关上下文稀释关键信息，导致 AI 注意力分散
- 全量注入在大型项目中可能占用 80%+ 上下文窗口
- 预算控制后，AI 专注于任务真正需要的模块，质量更高

## 选择算法（确定性，零额外 Token）

### Step 1：读取上下文索引

读取 `.agent/context-index.json`，获取所有 reference 模块的元数据（模块名、关键词、token 估算、依赖关系）。

如果 `context-index.json` 不存在或为空，提示用户先运行 `/scan-project`。

### Step 2：关键词匹配评分

从任务描述中提取关键词，与每个模块的 `keywords` 字段做交集计算：

```
score = 关键词命中数 / 模块关键词总数 × 10
```

同时检查任务描述中是否包含文件路径。若路径与模块的 `module_path` 存在前缀匹配，额外加 5 分（直接相关模块）。

### Step 3：依赖图扩展

对评分 ≥ 7 的模块，读取其 `dependencies` 字段，将直接依赖模块纳入候选集（分数设为 6）。

### Step 4：分层预算分配（Tier 贪心填充）

**预算计算**：
- 总预算 = `estimated_context_tokens` × 40%（来自 `context-index.json._meta`）
- 已占用 = 系统指令估算（约 3000 tokens）+ rules 估算（约 5000 tokens）
- 可用预算 = 总预算 - 已占用

**分层策略**：

| Tier | 条件 | 处理方式 |
|------|------|---------|
| Tier 0（必选）| task-progress.md + 当前任务描述 | 始终注入，不占预算 |
| Tier 1（高相关）| score ≥ 7 | 按分数降序，分数相同优先选 token 少的，贪心填充至预算 |
| Tier 2（中相关）| score 4-6 | 剩余预算允许时填入 |
| Tier 3（低相关）| score 0-3 | 只注入摘要首行（模块名 + 一句话描述），不注入完整文档 |

### Step 5：输出 context-manifest.json

在 `.agent/plans/` 下写入 `context-manifest.json`：

```json
{
  "task_id": "{任务 ID}",
  "generated_at": "{ISO 时间}",
  "budget": {
    "total_available": 32000,
    "used": {
      "system": 3000,
      "rules": 5000,
      "tier0": 1500,
      "tier1": 8400,
      "tier2": 2100,
      "tier3_summaries": 300,
      "total": 20300
    },
    "utilization": "25.4%",
    "within_limit": true
  },
  "selected": {
    "tier1": [
      { "module": "auth-service", "tokens": 1200, "score": 9, "path": ".agent/references/auth-service.md" }
    ],
    "tier2": [
      { "module": "redis-cache", "tokens": 900, "score": 5, "path": ".agent/references/redis-cache.md" }
    ],
    "tier3_summaries": ["payment-service", "notification-service"]
  }
}
```

## 使用方式

在 `/start-task` 工作流的 planner 阶段调用此 skill：

1. 读取 `context-index.json` 和任务描述
2. 执行上述评分算法
3. 输出 `context-manifest.json` 到 `.agent/plans/`
4. 向 planner 提供选中的 Tier1 + Tier2 文档内容，Tier3 只提供摘要

## 边界情况

- **context-index.json 不存在**：跳过预算控制，注入所有 references（同旧行为），并提示用户运行 `/scan-project`
- **所有模块 score = 0**：注入 Tier 0 + 分数最高的 3 个模块（最小保障）
- **预算不足**：优先保留 Tier 1，裁剪 Tier 2，Tier 3 降级为摘要
- **单个模块超过可用预算**：注入该模块的前 50 行（摘要截断）并标注 `[truncated]`

## 与其他组件的关系

- **输入**：`context-index.json`（由 `/scan-project` 生成）
- **输出**：`context-manifest.json`（供 planner 和 implementer 使用，也作为 phase-gate 的检查依据）
- **维护**：`/update-refs` 和 PostCommit entropy-scanner（Phase 3 实现）负责保持 `context-index.json` 更新
