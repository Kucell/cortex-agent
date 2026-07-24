# 技能调度四层防御体系 (Skill Dispatch Quad-Layer Defense)

## 概述

解决 Agent 技能库膨胀后的"选择困难"问题。在 35 个技能规模下，建立从用户输入到技能执行的完整调度链路。

## 架构

```
用户输入
  │
  ▼
Layer 1: 意图锚定 (intent-classifier)
  - 输入 → intent + domain + confidence + is_composite
  - 显式命令：100% 命中
  - 关键词：归一化置信度
  - 排除关键词：避免跨域误判
  │
  ▼
Layer 2: 技能海选 (skill-selector)
  - skill-index.json (37 个技能，3 维元数据)
  - intent + domain 匹配 → 前置条件预检 → 去重
  │
  ▼
Layer 3: 优先级仲裁 (skill-arbiter)
  - 4-D 评分：relevance + success_rate + speed + user_pref
  - 位置因子：专精 intent 优先
  - 固定基线：避免相对归一化偏差
  │
  ▼
Layer 4: 执行熔断 (skill-executor)
  - 超时熔断 + 连续失败熔断
  - management-api checkpoint 集成
```

## 各层组件

| Layer | 技能 | 文件 | 关键能力 |
|-------|------|------|---------|
| 1 | intent-classifier | `skills/intent-classifier/scripts/classify.js` | 8 个 domain，50+ intent |
| 2 | skill-selector | `skills/skill-selector/scripts/select.js` | 37 个技能索引 |
| 3 | skill-arbiter | `skills/skill-arbiter/scripts/arbitrate.js` | 4-D 评分 + 阈值决策 |
| 4 | skill-executor | `skills/skill-executor/scripts/execute.js` | timeout + circuit breaker |

## 踩坑案例与修复

| 案例 | 涉及层 | 修复 |
|------|--------|------|
| "查询代码结构"误判复合意图（knowledge_query vs code_explore） | Layer 1 | 排除关键词 + 专精意图优先 |
| graphify 被选中但 graph.json 不存在 | Layer 2 | 前置条件文件存在性预检 |
| knowledge-retrieval 因更快胜过 experience-recall | Layer 3 | 位置因子 + 固定 speed 基线 + success_rate 权重 |
| runtime-continuity warm --auto 守护进程卡死 | Layer 4 | 超时熔断 + 连续失败降级 + checkpoint |

## 使用方式

```bash
# 全链路
cortex-agent skill dispatch --input "帮我审查代码"

# 分层调用
node .agent/skills/intent-classifier/scripts/classify.js --input "..."
node .agent/skills/skill-selector/scripts/select.js --intent code_review
node .agent/skills/skill-arbiter/scripts/arbitrate.js --intent code_review

# 集成测试
node .agent/tests/skill-dispatch-integration.test.js
```

## Mission 链路

- M-007 MS-001: Phase 1 基础框架 ✅
- M-007 MS-002: Phase 2 意图锚定 ✅
- M-007 MS-003: Phase 3 优先级仲裁 ✅
- M-007 MS-004: Phase 4 熔断集成 ✅

## 验证摘要

| 阶段 | 测试数 | 通过率 |
|------|--------|--------|
| MS-001 | 7 | 100% |
| MS-002 | 5 | 100% |
| MS-003 | 4 | 100% |
| MS-004 | 5 | 100% |
| **合计** | **21** | **100%** |

## 未来扩展

- ML-based relevance scoring (Phase 2)
- 多轮对话状态累积 (Phase 3)
- 跨机器熔断同步 (Phase 4)