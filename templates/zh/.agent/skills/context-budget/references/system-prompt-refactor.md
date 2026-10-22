# System Prompt 精简方案

## 目标

将 System Prompt 从 ~90,000 token/次调用压缩到 ~5,000 token，核心方法是分层拆分 + 按需注入。

## 核心设计

### 1. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    System Prompt                             │
├─────────────────┬─────────────────┬─────────────────────────┤
│  Core (固定)    │  Domain (注入)  │  Dynamic (按需)          │
│  ~500 tokens   │  ~1K tokens    │  ~500 tokens            │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### 2. Core Prompt（固定共享前缀）

```javascript
const CORE_PROMPT = `你是一个协作编程助手。
核心能力：代码阅读、修改、调试。
安全约束：不提交、不推送、不删除。
工作目录：{cwd}
`;
```

### 3. Domain Prompt（按任务类型注入）

| 任务类型 | Domain Prompt | Token |
|:---|:---|:---|
| 代码审查 | 审查代码变更、提出改进建议 | ~500 |
| 错误修复 | 定位问题、修复Bug、验证 | ~800 |
| 功能开发 | 理解需求、实现功能、测试 | ~1000 |
| 代码优化 | 性能分析、重构建议 | ~600 |

### 4. Dynamic Prompt（运行时生成）

- 当前任务摘要
- 关键上下文引用
- 工具使用约束

## 实现方案

### Phase 1: Core/Domain 拆分

```javascript
// prompt-builder.js
function buildPrompt(taskType, context) {
  const core = loadCorePrompt();
  const domain = loadDomainPrompt(taskType);
  const dynamic = buildDynamicPrompt(context);
  return [core, domain, dynamic].join('\n\n');
}
```

### Phase 2: 历史裁剪集成

```javascript
// prune-history.js 集成
function buildContextWithPruning(history, budget) {
  const pruned = pruneHistory(history, {
    budget: budget * 0.5,  // 50% budget for history
    mode: 'auto'
  });
  return buildPrompt(taskType, pruned);
}
```

## Token 节省估算

| 组件 | 原始 | 优化后 | 节省 |
|:---|:---|:---|:---|
| System Prompt | ~5000 | ~500 | 90% |
| MCP Schema | ~5000/工具 | ~50/工具 | 90% |
| 历史 (10轮) | ~80000 | ~5000 | 93.75% |
| **总计** | **~90000** | **~5500** | **~94%** |

## 实施计划

| 阶段 | 内容 | 依赖 |
|:---|:---|:---|
| Phase 1 | Core/Domain 拆分脚本 | compact-mcp-schema.js |
| Phase 2 | 历史裁剪集成 | prune-history.js |
| Phase 3 | 运行时 prompt 组装 | MS-008 |

## 验证方法

```bash
# 测试压缩效果
node compact-mcp-schema.js <original-schema.json> | jq '.stats.compression_ratio'

# 测试历史裁剪
node prune-history.js history.json --budget 50000 --mode auto

# 验证功能完整性
node --test tests/context-budget/*.test.js
```

