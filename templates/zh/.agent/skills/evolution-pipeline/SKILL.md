---
name: evolution-pipeline
description: OpenViking 风格的异步自我进化管线。Session 归档 (`runtime-continuity/archive`) 后自动 enqueue，worker 后台提取 observation 写入 `.agent/memory/{feedback,project,experiences}/`。零 LLM 依赖（v1）。
area: agent-tuning
summary: OpenViking 风格的异步自我进化管线。Session 归档 (`runtime-continuity/archive`) 后自动 enqueue，worker 后台提取 observation 写入 `.agent/memory/{feedback,project,experiences}/`。零 LLM 依赖（v1）。
---

# Self-Evolution Pipeline (Phase 2.2)

## 目标

把 OpenViking 的 `session.commit()` 异步 memory extraction 适配到 cortex-agent：

- `runtime-continuity` 每次归档后自动创建 evolution task
- `evolve.js --worker` 后台处理，分类写入 4 个 memory scope
- 支持重试、死信队列、幂等去重
- v1 = 纯确定性规则分类（零 token 消耗）

## 架构

```
runtime-continuity/archive
         ↓ (manual or --auto)
evolve.js --enqueue-from-latest
         ↓
.agent/tasks/evolution/EVO-YYYY-MM-DD-NNN.json
         ↓ (poll loop)
evolve.js --worker --loop --interval 30
         ↓
.classifyArchive() → {user, feedback, project, experiences} routes
         ↓
writeMemoryItem() → .agent/memory/{scope}/{name}.md
         ↓
updateMemoryIndex() → .agent/memory/MEMORY.md
```

## 命令

```bash
# 入队（手动）
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue-from-latest
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue-from-latest --max 5
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue --archive RC-20260724_053807_983

# worker
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --once
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --loop --interval 30

# 管理
node .agent/skills/evolution-pipeline/scripts/evolve.js --status
node .agent/skills/evolution-pipeline/scripts/evolve.js --list --status failed
node .agent/skills/evolution-pipeline/scripts/evolve.js --replay EVO-2026-07-24-001
node .agent/skills/evolution-pipeline/scripts/evolve.js --dead-letter
```

## 分类规则（v1 = 确定性）

| 类别 | 触发条件 | 写入目录 |
|---|---|---|
| feedback | state.blockers[] + state.in_progress | memory/feedback/ |
| project fact | state.done[] (非 lesson) + state.next[] | memory/project/ |
| experience | state.done[] + keywords: lesson/trap/regression/root cause/防复发 | experiences/ |
| user | (v2) 用户偏好关键词提取 | memory/user/ |
| dropped | 无 match 或重复 | - |

## 与其他组件的边界

- **与 `runtime-continuity`**: 不修改 guard/archive 逻辑，只做下游消费
- **与 `memory-protocol.md`**: 100% 兼容 frontmatter 格式 + MEMORY.md 索引约定
- **与 `experience-recall`**: 写入 lessons 到 `experiences/` 供检索
- **与 LLM extraction**: classifyArchive() 函数可替换而不改变入队/worker contract
- **与 `skill-selector`**: v1 暂不做显式 skills 提取（OpenViking 有 skill/ 目录但 cortex-agent 已有）

## 幂等与收敛

- 相同 archive → 相同 content hash → 相同文件名
- 重复写入覆盖文件本身（append 语义由 MANIFEST 跟踪）
- 每个 evolution task status: pending → running → completed/failed → dead
- 重试 max_retries 次后转入 `_dead/` 目录

## 验收

- 入队：`--enqueue-from-latest` 创建 task 文件
- 执行：`--worker --once` 更新 status → completed，创建 memory/ 文件
- 索引更新：MEMORY.md 新增对应条目
- 失败重试：人工 bug fix 后 `--replay` 可重跑
- 死信队列：超限后转入 `_dead/`
