# Cortex-Agent Token Savings — 实战项目降耗指南

> 状态：stable · 验证基线：cortex-agent self-host, 2026-08-14
> 复现脚本：`scripts/token-savings-demo.js` · 测试：`tests/scripts/token-savings-demo.test.js`

## 结论

在 cortex-agent 仓库自身作为实战项目的场景下，单次任务 turn 的输入 token 可以从
~7500 降到 ~1100，**降幅 85.1%**（6418 tokens）。降幅由三个机制叠加产生，
每个独立可测。

| 机制 | 基线 | 优化后 | 降幅 |
| --- | ---: | ---: | ---: |
| 系统提示词（base_instructions） | 4935 | 843 | 82.9% |
| 任务上下文（full task.json） | 583 | 166 | 71.5% |
| Skills 描述（44 张卡片） | 2021 | 112 | 94.5% |
| **合计** | **7539** | **1121** | **85.1%** |

数据来源：Codex `cc-switch-model-catalog.json` 中 `gpt-5.6-terra` 的 `base_instructions`
（19737 chars ≈ 4935 token），cortex-agent 仓库内真实任务 `T-TCP-001`（2161 chars），
以及 44 个 skill 库的 frontmatter 卡片。
Token 估算使用 `cjk/1.5 + latin/4`，与 `lib/memory/select.js` 的 tokenize 一致。

## 三层机制

### 1. P-006 core layer（替代 Codex base_instructions）

Codex 的 `cc-switch-model-catalog.json` 中每个模型条目内嵌完整 `base_instructions`
（约 19.7KB），包括人设、行为指令、写作规范、工具定义、沟通规则等。
其中**写作规范 / 设计指令 / 沟通规则约占 50%**，对非前端任务不必须。

P-006 把 base_instructions 拆为两层：

- `system-prompt-core.md`（core layer，必注入，约 3.2KB ≈ 843 token）：身份、模式
  意识、6 条操作原则、路由表
- `system-prompt-domain.md`（domain layer，按需，约 1.4KB）：详细参考路径

**集成方式**：把 `prompt-inject inject --layer core` 的输出配置为 Codex 的
system prompt 替代默认 base_instructions：

```bash
# 一次输出 core layer
node .agent/general/.agent/skills/prompt-inject/scripts/inject.js --layer core --lang en > ~/.codex/system-prompt-core.txt
# 之后：Codex 启动时读取该文件作为 system prompt（prefix），不再使用 cc-switch 的
# 完整 base_instructions
```

**直接收益**：base_instructions token 从 4935 降到 843（-82.9%）。

### 2. M3 task-state projection（按需 query 替代全文注入）

agent 处理长任务时，常把 `cat .agent/tasks/T-XXX.json` 的全文贴进上下文。
`query task-state --task T-XXX` 返回紧凑摘要（约 0.5KB）：

```bash
node .agent/skills/management-api/scripts/index.js query task-state --task T-TCP-001 --project .
```

返回字段：`task_id / title / status / stage / priority / owner / subtasks_count /
acceptance_criteria[] / validation_commands[]`，**省略 description / dependencies /
source_refs 全文 / artifacts / gates / created_at / updated_at**。需要详情时再
`query task-state` 一次（按需）。

**直接收益**：任务上下文 token 从 583 降到 166（-71.5%）。

### 3. M2 skill browse（按需发现替代全量卡片）

Codex/opencodex 当前可能将所有 skill 描述全集注入 system prompt（每个 skill 约
200-500 chars 的 name+area+summary）。`skill browse --area X --top-n N` 返回指定 area
的 N 张卡片：

```bash
# 当前任务的 area（从任务元数据或 P-002 minimal-context 评分推断）
node bin/cli.js skill browse --area agent-tuning --top-n 3
```

**直接收益**：skill 卡片 token 从 2021（44 张全量）降到 112（agent-tuning 的 3 张）。

## 集成步骤

1. **替换 base_instructions**（最大头）
   - 生成 core layer：`node .agent/general/.agent/skills/prompt-inject/scripts/inject.js --layer core --lang en > ~/.codex/system-prompt-core.txt`
   - 配置 Codex（或 opencodex）使用该文件作为 system prompt prefix
   - 验证：cc-switch 仍保留 base_instructions 供 model 描述用，但 host 渲染时
     用 core 替代

2. **改造 agent 工作流**（M3 替代 M2+M3 增量）
   - agent 启动时 `query task-state --task T-XXX` 拉任务状态（不进上下文，靠 query）
   - 工具调用需要 task 详情时再 `query task-state` 一次（按需）

3. **按 area 注入 skill**（M2）
   - host 或 agent 推断当前任务 area（基于任务 stage / 类型 / 关键词）
   - 注入 `skill browse --area X --top-n 3` 卡片
   - 不要全量 44 张卡片同时注入

4. **自举验证**
   - `cortex-agent upgrade` 同步新模板到 `.agent/`
   - `node scripts/token-savings-demo.js T-XXX` 跑实测
   - 比对 `baseline.total_tokens` 与 `optimized.total_tokens`

## 复现

```bash
# 跑实测，输出 JSON 报告
node scripts/token-savings-demo.js T-TCP-001

# 跑测试
node --test tests/scripts/token-savings-demo.test.js
```

## 边界与风险

- **base_instructions 来源**：P-006 替代的是 cc-switch 的内嵌 base_instructions。
  如果 host 不是 Codex/opencodex，或用其他 model catalog，节省幅度不同。
- **P-006 Host 侧**（把 cc-switch 配置为用 prompt-inject 的 core layer）需要用户/部署
  侧动作，cortex-agent 仓库不能直接改 host 配置。本提案只提供工具，不自动激活。
- **M2 skill 路由的 area 推断**：当前 demo 硬编码 `agent-tuning`（与 T-TCP-001 主题对齐）。
  真实集成需要 P-002 minimal-context 评分或简单关键词匹配来推断 area。
- **首次会话没有"已沉淀的"稳定结论**：memory scope 在第二及之后的会话才显现价值。
  首次会话的节省主要来自 P-006 + M2 + M3。

## 与提案的关系

本指南是 P-007（Session & Task Context Offload，proposal-only draft）的实测
依据。具体三份提案（按 P-007 提案序号）：

- **P-006**（Host-side Context Optimization，request-level）：本指南 §1 直接落地
  的 core layer 替换
- **P-007**（Session & Task Context Offload，session/task-level）：本指南 §2 + §3 是其
  template 层（Memory scope M1 + Skill browse M2 + Task workspace M3）落地后的
  "host 怎么用" 指引

实测数据（6418 tok / 85.1%）说明 cortex-agent 框架在实战项目具备"降 token 消耗"
的能力。三层机制独立可测、可增量启用，不需要全部上线。
