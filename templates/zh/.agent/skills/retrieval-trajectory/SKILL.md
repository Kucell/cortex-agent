---
name: retrieval-trajectory
description: 记录与回放检索轨迹（受 OpenViking observable-retrieval 启发）。每次 context-budget / knowledge-retrieval / skill-selector 执行后写入 `.agent/runtime-evidence/trajectory/{task-id}_{ts}.jsonl`，支持回放 + URI 解析验证 + fixture 导出。
---

# 检索轨迹 (Retrieval Trajectory)

## 目标

把检索过程从"黑盒"变成"可观测"——`viking://` 风格的 directory-browsing trajectory，cortex-agent 适配为:

1. **记录**：`context-budget/scripts/select.js` 在评分、greedy 填充时实时输出到 `trajectory/{task-id}_{ts}.jsonl`
2. **回放**：`replay.js` 重放轨迹，重建当时每一步决策
3. **验证**：`--verify-resolve` 同时把 `cortex://` URI 解析回路径，捕获"路径失效但 URI 没失效"或反之
4. **Fixture**：`--as-fixture` 输出标准 JSON，供 e2e 测试用

## 写入位置

```text
.agent/runtime-evidence/trajectory/
└── {task-id}_{iso-timestamp}.jsonl
```

每行一条 JSON，事件类型：
- `header` — 任务元数据（task_id / task / scoring_strategy / l0_l1_available）
- `step` — 单次决策（scan/tokenize/score/promote/l0_only/load/skip/error）
- `summary` — 结尾（自动算 step_count / promoted_count / total_tokens）

完整 schema 在 `trajectory.schema.json`。

## 使用方式

### 1. 现有 context-budget 自动写

`context-budget/scripts/select.js` 已经在主线流程里写轨迹，无需额外操作。

### 2. 手动追加（自定义检索脚本）

```bash
node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 \
  --step 1 --action scan --candidates 42

node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 \
  --step 3 --action promote --tier tier1 \
  --uri "cortex://skills/context-budget" \
  --tokens 1200 --reason "score=9"

node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 --summary
```

### 3. 回放最近任务

```bash
node .agent/skills/retrieval-trajectory/scripts/replay.js --task-id T-DEMO-001

# 同时验证 URI 解析
node .agent/skills/retrieval-trajectory/scripts/replay.js \
  --task-id T-DEMO-001 --verify-resolve

# 导出为 test fixture
node .agent/skills/retrieval-trajectory/scripts/replay.js \
  --task-id T-DEMO-001 --as-fixture
```

## 与其他组件的关系

- **写入方**：`context-budget/scripts/select.js`、`knowledge-retrieval/scripts/recall.js`（后续增加）、`skill-selector/scripts/select.js`（后续增加）
- **读取方**：`agent-dashboard/scripts/generate.js` 增加的 "Retrieval Trace" 面板
- **fixture 输出口**：`tests/openviking-borrow-e2e.test.js` 读取 `--as-fixture` 输出做 regression
- **隐私**：默认原样记录 query 描述（截断到 200 字符）。如果涉及敏感内容，在 caller 侧做脱敏后再调用 `record.js`

## 边界

- **不记录**实际 L2 内容（避免内容泄露 + 增大日志）
- **不实现**实时流式写入（每条按行追加，进程崩溃会丢最后一条）
- **不压缩**超过 30 天的旧轨迹（auto-archive 由 future entropy-scanner 增量做）
- **不强制**每条检索都要写——脚本失败时仅记 `error` action

## 验收

- 写盘率：100% context-budget 调用都生成至少 3 行（header + scan + score）
- 回放通过率：同一 task-id 在 context-index.json 未变更时，`--verify-resolve` 100% 通过
- Fixture 复用：e2e 测试读取 fixture → 跑同任务 → 比对 `expected_promoted` 集合
