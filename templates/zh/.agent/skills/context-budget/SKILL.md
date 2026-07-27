---
name: context-budget
description: 基于 L0/L1/L2 分层摘要的上下文预算控制（受 OpenViking 启发）。从 `.agent/references/` 中按 L0 关键词筛选、L1 排序、最后才加载 L2 全文，将注入量控制在模型上下文窗口的 40% 以内。零额外 token（前端启发式），输出 context-manifest.json + retrieval trajectory。
---

# 上下文预算控制 (Context Budget Skill) — L0/L1/L2 版

## 目标

在 `/start-task` 的规划阶段，从 `.agent/references/` 中按层级选择最相关的上下文文档，将注入量控制在模型上下文窗口的 40% 以内。

## 为什么升级到 L0/L1/L2

v0 的纯启发式算法对全量文档打分，无 L0/L1 摘要时需要在 budget 内逐个 keyword 匹配全文，导致大型项目 references/ > 50 时打分成本急剧上升。

受 OpenViking `viking://` 三层载荷启发，cortex-agent 引入 L0/L1：

| 层 | 大小 | 用途 | 何时加载 |
|---|---|---|---|
| L0 abstract | ~100 tokens | 一句话摘要 | 总是加载（filter） |
| L1 overview | ~2k tokens | 章节结构 + 关键段落 | 候选命中后加载（rerank） |
| L2 detail | 全量 | 完整原文 | 预算允许 + 分数 ≥ 7 时加载 |

L0/L1 摘要由 `scripts/build-l0l1.js` 离线生成（基于 frontmatter + 首段 + 标题大纲，**零 LLM 调用**），可作为 PostCommit hook 自动刷新。

## 选择算法

### Step 1：读取上下文索引

读取 `.agent/context-index.json`，获取所有 module 的元数据：
- `l0` / `l1` 摘要（可选，没有时回退到 `summary`）
- `l0_tokens` / `l1_tokens` / `l2_tokens`
- `keywords` / `module_path` / `dependencies`

如果 `context-index.json` 不存在或为空，提示用户先运行 `/scan-project` + `build-l0l1.js --all`。

### Step 2：L0/L1 关键词匹配

```
score = L0 命中数 × 1 + L1 命中数 × 1 + 关键词命中数 × 0.5
路径前缀命中额外 +5
```

> **关键差异（vs v0）**：v0 是全量文本匹配；v1 优先在 L0（~100 tokens）上匹配，未命中再扫 L1（~2k tokens），L2 仅在分数 ≥ 7 且预算允许时加载。**整轮打分成本近似 O(L0_sum)，与 references/ 数量解耦**。

### Step 3：依赖图扩展

对评分 ≥ 7 的模块，读取 `dependencies`，将直接依赖模块纳入候选集（分数设为 6）。

### Step 4：分层预算分配

**预算计算**：
- 总预算 = llm-window × 40%
- 固定开销 = system(3000) + rules(5000)
- 可用预算 = 总预算 - 固定开销

**分层策略**：

| Tier | 分数 | 处理方式 |
|---|---|---|
| Tier 1 | ≥ 7 | 加载 L2 全文 |
| Tier 2 | 4-6 | 加载 L1 概览（~2k tokens）而非 L2 |
| Tier 3 | 1-3 | 仅 L0 一句话（~100 tokens） |

Greedy 填充：按分数降序，分数相同优先选 token 少的。

### Step 5：输出 manifest + trajectory

- `context-manifest.json` 写入 `.agent/plans/`（planner / implementer / phase-gate 读取）
- 同时经 `retrieval-trajectory/scripts/record.js` 写入 `.agent/runtime-evidence/trajectory/{task-id}_{ts}.jsonl`（用于回放与回归 fixture）

### Step 6：URI 标注

每个选中的 module 在 `selected.tier1/tier2/tier3_summaries` 中额外附带 `uri` 字段（`cortex://references/{module_path}`），便于跨项目复制。

## 使用方式

```bash
# 1. 先生成 L0/L1（首次或 PostCommit）
node .agent/skills/context-budget/scripts/build-l0l1.js --all --write --inject-index

# 2. 在 /start-task 的 planner 阶段调用
node .agent/skills/context-budget/scripts/select.js \
  --task "实现 OAuth 第三方登录" \
  --task-id T-DEMO-001 \
  --llm-window 128000

# 3. 单独文件构建（增量更新）
node .agent/skills/context-budget/scripts/build-l0l1.js \
  --file .agent/rules/core-principles.md --write
```

## 边界情况

- **没有任何 module 有 L0/L1**：自动回退 v0 行为（用 `summary` 字段做关键词匹配），不破坏现有项目
- **所有模块 score = 0**：注入 Tier 0 + 分数最高的 3 个模块（最小保障）
- **预算不足**：优先保留 Tier 1，Tier 2 降级为 L1 → L0，Tier 3 完全丢弃
- **context-index.json 不存在**：跳过预算，注入所有 references（旧行为），提示先跑 `/scan-project`

## 兼容性

- `context-manifest.json` schema 完全向后兼容 v0（新增 `uri` 字段、`l0_tokens/l1_tokens/l2_tokens` 字段，旧消费者忽略）
- 旧项目无 L0/L1 字段时 selector 自动用 `summary` 当 L0，不会报错

## 验收

- L0/L1 生成率：`build-l0l1.js --all` 在 1 个实战项目（>50 references）跑通，>95% module 有 L0/L1
- 检索加速：一次 context-budget 评估时，对 references/ 全量匹配的字符数 ≤ 100 chars × N（vs v0 的全文匹配）
- Token 节省：同等 query 下，context-manifest.json 报告 `used < v0_baseline × 0.7`

## 与其他组件的关系

- 输入：`context-index.json`（`/scan-project` + `build-l0l1.js` 双源生成）
- 输出：`context-manifest.json`（planner / implementer / phase-gate）+ `.agent/runtime-evidence/trajectory/{task-id}_*.jsonl`（retrieval-trajectory）
- 维护：`/update-refs` 和 PostCommit entropy-scanner 调度 `build-l0l1.js --all` 增量
- 配套：`uri-resolver` skill 解析 `cortex://references/...` 为路径
