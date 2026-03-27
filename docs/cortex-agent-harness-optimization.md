# Cortex Agent × Harness Engineering 优化方案

> 基于 Harness Engineering 六大支柱，对 cortex-agent 框架的系统性优化提案。
> 核心理念：Agent 的可靠性瓶颈不在模型，而在模型周围的系统。

---

## 一、现状评估

### 1.1 Cortex Agent 当前架构概览

Cortex Agent 是一个为 AI 编程助手设计的治理与指令框架，通过 Rules、Workflows、Skills、Sub-agents、Hooks 五大模块将 AI 从代码生成器提升为具有架构意识的"资深工程师"。

当前架构已具备的能力：

- `.agent/` 作为唯一真理来源（Single Source of Truth）
- 5 个 Sub-agent（planner / implementer / researcher / code-reviewer / documenter）
- 3 个 Skill（architecture-audit / architecture-check / code-evaluation）
- 13+ 个 Workflow 覆盖从方案设计到任务交付的完整链路
- Hooks 事件驱动自动化（PostToolUse 写完即检）
- 多平台集成（Cursor / Claude Code / Windsurf / Gemini CLI 等）

### 1.2 Harness 六大支柱对照

| 支柱 | Cortex Agent 现状 | 差距评估 |
|------|-------------------|---------|
| ① 上下文架构 | `references/` + `/scan-project` 已在做"给地图不给百科全书" | **缺少量化预算控制**，无 40% 利用率监控 |
| ② 架构约束 | `rules/` + `hooks/` + `skills/` 提供约束体系 | **待强化**：工具面过大（~25 个决策点），hooks 依赖 AI 判断而非确定性工具 |
| ③ 自验证循环 | `code-review` + `hooks` 提供验证能力 | **缺少推理三明治**（规划高/执行中/验证高）和死循环防护 |
| ④ 上下文隔离 | Sub-agents 已有基本隔离（独立模型和工具权限） | **待强化**：父级仍看到子 agent 完整输出，无结构化摘要机制 |
| ⑤ 熵治理 | `/update-refs` 半自动更新 | **缺少自动闭环**：依赖人手动触发，无后台 agent 自维护 |
| ⑥ 可拆卸性 | 模块化设计，但无退化策略 | **缺少退化配置**：组件只会增加不会移除 |

### 1.3 优化优先级

- **P0**：上下文预算控制 — 立即可做，ROI 最高
- **P1**：推理三明治 — 防死循环/跳步，提升交付质量
- **P2**：熵治理闭环 — references 自动维护，长期复利
- **P3**：工具精简 + 隔离强化 + 可拆卸性 — 渐进优化

---

## 二、上下文预算控制

### 2.1 问题定义

Harness 指出：Agent 性能在上下文利用率超 40% 后开始下降。当前 cortex-agent 的 `/start-task` 没有控制注入多少上下文——所有 rules、references、plans 可能全量灌入，导致关键信息被稀释。

### 2.2 设计方案

在 `/start-task` 的 planner 阶段插入"上下文选择器"，让 AI 在有限预算内选择最有价值的上下文片段。

**Step 1：构建上下文索引**

改造 `/scan-project` 和 `/update-refs`，为每个 reference 文件增加 YAML frontmatter 元数据：

```yaml
---
module: auth-service
keywords: [JWT, OAuth, session, login, token-refresh]
estimated_tokens: 1200
last_updated: 2026-03-20
dependencies: [user-service, redis-cache]
---
```

在 `.agent/` 下新增 `context-index.json`，聚合所有 reference 的元数据。此索引文件本身极小（几十个模块不过几 KB），可安全全量注入给 planner。

**Step 2：相关性评分**

改造 planner sub-agent 的 prompt，在任务拆解之前先做"上下文匹配"。planner 拿到任务描述和 `context-index.json` 后，为每个模块打 0-10 相关性分：

```json
{
  "task_plan": { "..." : "..." },
  "context_selection": [
    { "module": "auth-service", "relevance": 9, "reason": "任务直接修改认证逻辑" },
    { "module": "user-service", "relevance": 7, "reason": "认证依赖用户模型" },
    { "module": "redis-cache",  "relevance": 3, "reason": "间接依赖，可能不需要" }
  ]
}
```

**Step 3：预算分配算法**

新增 `skills/context-budget.md`，实现分层贪心填充：

- **总预算** = 模型上下文窗口 × 40% − 系统指令 − rules
- **Tier 0（必选）**：task-progress + 当前任务描述，始终注入
- **Tier 1（高相关，relevance ≥ 7）**：按分数降序填入，分数相同时优先选 token 少的
- **Tier 2（中相关，4-6）**：剩余预算允许时填入
- **Tier 3（低相关，0-3）**：仅注入摘要首行（一句话描述），AI 知道其存在但不占预算

**Step 4：输出上下文清单**

每次 `/start-task` 执行后，planner 在 `.agent/plans/` 下生成 `context-manifest.json`：

```json
{
  "task_id": "T-001",
  "model": "claude-sonnet-4.5",
  "window_size": 200000,
  "budget_limit": 80000,
  "allocated": {
    "system_instructions": 3200,
    "rules": 4800,
    "tier_0": 2100,
    "tier_1": [
      { "module": "auth-service", "tokens": 1200, "relevance": 9 }
    ],
    "tier_2": [
      { "module": "redis-cache", "tokens": 600, "relevance": 4 }
    ],
    "tier_3_summaries": ["payment-service", "notification-service"],
    "total_used": 12700,
    "utilization": "15.9%"
  }
}
```

### 2.3 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `skills/context-budget.md` | 预算计算和分配逻辑 |
| 新增 | `context-index.json` | 聚合所有 reference 元数据的索引 |
| 改造 | `sub-agents/planner.md` | 增加"上下文选择"步骤 |
| 改造 | `workflows/start-task.md` | 在 planner 后插入 context-manifest 生成步骤 |
| 改造 | `workflows/scan-project.md` | 生成 reference 时自动加 frontmatter |
| 改造 | `workflows/update-refs.md` | 更新 reference 时同步刷新 frontmatter 和索引 |

---

## 三、工具精简

### 3.1 问题定义

Vercel 的经验：移除 80% 工具后可靠性反而更高。当前 cortex-agent 的"工具面"约 25 个决策点（5 sub-agent + 3 skill + 13+ workflow + hooks 路由），AI 在每次交互时的选择负担过大。

### 3.2 Sub-agent 精简：5 → 3

**合并 researcher → planner**

planner 在任务拆解时本身就需要技术调研。分离导致 Orchestrator 多一次"该派给 planner 还是 researcher"的路由判断。合并后 planner 的 prompt 增加调研职责。

**合并 documenter → implementer**

写代码的 agent 拥有最完整的实现上下文，它生成的文档天然更准确。分离引入同步问题（implementer 改了代码但 documenter 不知道）。合并后 implementer 每次完成编码后同步更新相关文档。

**保留 code-reviewer**

审查和实现之间需要"对抗性张力"——同一 agent 既写又审容易自我放行。

### 3.3 Skill 精简：3 → 2

**合并 architecture-audit + architecture-check → architecture-guard**

两者的区别是粒度（整体 vs 细节），但这个区分让 AI 多一个选择题。合并为单入口，内部分两阶段（先粗后细），调用者不需要判断粒度。

**保留 code-evaluation**

独立的质量评分能力，与架构检查职责不同。

### 3.4 Workflow 精简：13 → 7

**保留为独立 workflow（7 个）**

`/configure`、`/scan-project`、`/briefing`、`/arch-design`、`/plan`、`/start-task`、`/ship` — 高频、每日必用、不可替代。

**降级为 workflow 内部步骤（4 个）**

`/code-review`、`/commit`、`/done`、`/sync-plans` — 90% 场景由 `/ship` 串联。降级后用户只需 `/ship T-xxx`，无需判断调用顺序。如需单独执行可用参数变体（如 `/ship --review-only`）。

**合并或移除（4 个）**

- `/parallel` → `/start-task T-001 T-002 T-003`（多 task ID 自动并行）
- `/weekly-report` → `/briefing --weekly`
- `/migrate-rules` → `/configure` 子流程
- `/agent-update` → 手动编辑 `.agent/` 文件即可

### 3.5 Hooks 改造：从 AI 判断到确定性触发

将 hook 执行分成两层：

```yaml
PostToolUse(Write, Edit):
  layer_1: "npx eslint {file} && npx tsc --noEmit"   # 确定性，零 token
  layer_2: "code-evaluation"                           # AI，仅语义层
  gate: layer_1 必须通过才触发 layer_2
```

第一层用 linter/formatter/compiler 做机械化验证（pass/fail，无歧义）。第二层才调用 AI 做架构合规审查。大量简单错误被第一层拦截，AI 专注于 linter 无法覆盖的语义级问题。

### 3.6 精简后的用户体验

日常开发只需 3 个命令：`/briefing` → `/start-task` → `/ship`。内部 sub-agent 调度、skill 调用、hook 触发全部自动化，用户无需感知。工具面从 ~25 个决策点降至 ~12 个。

---

## 四、推理三明治

### 4.1 问题定义

当前 sub-agent 模型分配是静态的（planner=haiku, implementer=sonnet, reviewer=sonnet），存在三个问题：规划用弱模型导致任务拆解粗糙；验证和执行同级导致验证深度不够；无机械化保障导致死循环或跳过验证。

### 4.2 核心原则

推理三明治的结构是 **高 → 中 → 高**：

- **规划层（高推理）**：深度思考任务边界、依赖关系、风险点
- **执行层（中推理）**：按计划忠实翻译为代码，不自行做架构决策
- **验证层（高推理）**：严格审查正确性，推理强度 ≥ 执行层

### 4.3 动态模型分配

新增 `.agent/reasoning-config.yml`：

```yaml
reasoning_sandwich:
  planning:
    default: sonnet
    complex_task: opus        # 任务依赖 ≥ 3 个模块时升级

  verification:
    default: sonnet
    critical_path: opus       # 涉及核心模块时升级

  execution:
    default: sonnet
    simple_task: haiku        # 单文件修改时降级

  escalation:
    max_retry: 2
    escalate_to: opus
    fallback: human           # 最终兜底
```

关键改动：planner 从 haiku 升级到 sonnet（默认），复杂任务升 opus。这是对整体质量提升最大的单一改动。

### 4.4 死循环防护

在 `/ship` 内部增加重试计数器。每次 reviewer 打回时：

1. blocking issues 被结构化记录到 `context-manifest.json`
2. 下次 implementer 执行时，上次失败原因作为 Tier 0 必选上下文强制注入
3. 当 `review_attempts` 达到 `max_retry`（默认 2），触发升级或暂停

```json
{
  "review_attempts": [
    { "attempt": 1, "result": "rejected", "blocking_issues": ["缺少错误处理"], "model": "sonnet" },
    { "attempt": 2, "result": "rejected", "blocking_issues": ["修复不完整"], "model": "sonnet" }
  ],
  "escalation_triggered": true,
  "escalated_to": "opus"
}
```

超过 max_retry 后绝不进入第三次循环——这是硬性确定性约束，不是 AI 自己判断的。

### 4.5 跳步防护：阶段状态机

在 `/ship` workflow 中定义严格状态机，每个转换有确定性前置条件：

```
PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE
```

| 转换 | 硬性前置条件 | 检查方式 |
|------|-------------|---------|
| PLAN → EXECUTE | plan 文件存在且 steps.length > 0 | 文件存在性检查 |
| EXECUTE → LINT | git diff --name-only 非空 | shell 命令 |
| LINT → REVIEW | linter 退出码 = 0 | 进程返回值 |
| REVIEW → COMMIT | review.score ≥ 7 且 blocking_issues = 0 | JSON 字段检查 |
| COMMIT → DONE | git log -1 成功 | shell 命令 |

这些都是确定性检查，不依赖 AI 判断"差不多可以了"。

### 4.6 Sub-agent Prompt 改造

**planner 增加：**

```
你是规划层，处于三明治的"上层面包"。你的输出将被推理强度更低的
implementer 执行。因此你必须：
- 把每个步骤拆解到"无需额外判断即可执行"的粒度
- 明确标注每个步骤的验收标准（可机械化检查的）
- 标注哪些步骤有风险，需要验证层重点审查
```

**implementer 增加：**

```
你是执行层，处于三明治的"馅料"。忠实翻译 planner 的计划为代码，
不要自行做架构决策。如果计划有歧义，标记为 BLOCKED 并说明原因。
```

**reviewer 增加结构化输出要求：**

```json
{
  "score": 8,
  "blocking_issues": [],
  "warnings": ["考虑增加 retry 逻辑"],
  "verdict": "PASS"
}
```

verdict 只有 PASS 或 FAIL，没有中间状态。这让状态机可以机械化解析。

### 4.7 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `reasoning-config.yml` | 三明治模型分配和升级策略 |
| 新增 | `skills/phase-gate.md` | 阶段转换前置条件检查逻辑 |
| 改造 | `sub-agents/planner.md` | 默认模型 haiku → sonnet，增加推理强度声明 |
| 改造 | `sub-agents/code-reviewer.md` | 增加结构化评分输出要求 |
| 改造 | `sub-agents/implementer.md` | 增加推理强度声明和 BLOCKED 机制 |
| 改造 | `workflows/ship.md` | 嵌入状态机 + max_retry 计数逻辑 |

---

## 五、子代理防火墙

### 5.1 问题定义

当前子 agent 的完整输出（推理链、工具调用日志、中间错误）全部回传给 Orchestrator，造成三个泄漏：上下文膨胀（~8000 tokens 的噪音）、reviewer 确认偏误（看到 implementer 思路后失去独立性）、跨任务污染（T-001 的残留影响 T-002）。

### 5.2 变更 1：输出摘要器

在每个 sub-agent 的 prompt 尾部增加强制输出格式。不新增独立 agent，而是让每个 agent 自己在末尾生成结构化 JSON。Orchestrator 只解析最后一个 JSON 代码块，其余丢弃。

**planner 输出契约：**

```json
{
  "type": "plan_summary",
  "task_id": "T-xxx",
  "steps": [
    {
      "id": "S1",
      "action": "创建 auth middleware",
      "file_targets": ["src/middleware/auth.ts"],
      "acceptance": "JWT 验证通过 + 未授权返回 401",
      "risk": "low"
    }
  ],
  "estimated_complexity": "medium",
  "context_needed": ["auth-service", "user-service"],
  "risk_flags": ["涉及 session 存储迁移"]
}
```

**implementer 输出契约：**

```json
{
  "type": "execution_report",
  "task_id": "T-xxx",
  "files_changed": ["src/middleware/auth.ts (created)", "src/tests/auth.test.ts (created)"],
  "tests_added": 3,
  "tests_passed": true,
  "deviations": [],
  "blocked_steps": []
}
```

**reviewer 输出契约：**

```json
{
  "type": "review_verdict",
  "task_id": "T-xxx",
  "score": 8,
  "blocking_issues": [],
  "warnings": ["建议增加 token 过期的边界测试"],
  "verdict": "PASS"
}
```

效果：Orchestrator 上下文占用从 ~8000 tokens 降到 ~2000 tokens。

### 5.3 变更 2：Reviewer 输入隔离

reviewer 的输入严格限定为三个来源：

1. `plan_summary` — planner 的结构化输出（任务目标和验收标准）
2. `execution_report` — implementer 的结构化输出（改了什么、测了什么）
3. `git diff` — 实际代码变更（唯一需要深度阅读的内容）

reviewer 看不到：implementer 的推理过程、调试日志、内部重构历史。这确保 reviewer 基于"代码是否满足验收标准"独立判断，而非沿着 implementer 的思路确认。

在 `sub-agents/code-reviewer.md` 中显式声明：

```
如果你在输入中发现了不属于以上三份材料的内容，
忽略它们并在输出中标注 "input_contamination": true。
```

### 5.4 变更 3：任务间上下文清洗

`/ship` 完成后（DONE 状态），执行上下文清洗：

```yaml
context_cleanup:
  archive:
    from: ".agent/plans/T-001/"
    to: ".agent/archive/T-001/"
  retain:
    - task-progress.md
    - context-manifest.json
  purge:
    - "*.plan_summary.json"
    - "*.execution_report.json"
    - "*.review_verdict.json"
```

归档后的文件不被 `context-index.json` 索引，不影响后续任务。但可用于事后复盘。

### 5.5 变更 4：读写权限分离

| Sub-agent | 可读 | 可写 | 禁止 |
|-----------|------|------|------|
| planner | task-progress, references/\*, rules/\* | plan_summary.json | 其他 agent 输出 |
| implementer | plan_summary.json（只读） | 源代码, 测试, execution_report.json | 修改 plan, 读取 review |
| reviewer | plan_summary + execution_report + git diff（全只读） | review_verdict.json | 修改任何源代码 |

权限在 prompt 层面为软约束，可通过 hooks 做硬性检查加固（reviewer 的工具调用出现写文件操作时直接拦截）。

### 5.6 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 改造 | `sub-agents/planner.md` | 增加输出摘要器 + 权限声明 |
| 改造 | `sub-agents/implementer.md` | 增加输出摘要器 + 权限声明 |
| 改造 | `sub-agents/code-reviewer.md` | 增加输入隔离声明 + 污染检测 |
| 改造 | `workflows/ship.md` | DONE 后增加 context_cleanup 步骤 |

---

## 六、熵治理闭环

### 6.1 问题定义

`.agent/` 知识库有四种熵源：references 过时（模块重构后描述不准）、rules 与实践脱节（声明 REST 但代码已迁移到 gRPC）、plans 残留（已完成任务未标记）、context-index 偏移（新模块无索引、删除模块仍在索引里）。

当前 `/update-refs` 需手动触发，Harness 要求后台 agent 自动检测偏差、修复、验证。

### 6.2 entropy-scanner Sub-agent

新增最轻量的 sub-agent：

- **模型**：haiku（成本最低）
- **工具权限**：read-only + git，仅可写 `.agent/` 目录
- **输入**：`git diff --stat`（上次扫描点 → 当前 HEAD），不读完整文件内容
- **无 Skill 挂载**：不需要架构审计能力，只做检测

检测五个维度：

| 维度 | 检测方式 | 分级 |
|------|---------|------|
| `stale_refs` | 变更文件路径 vs reference 覆盖范围 | L1 |
| `missing_refs` | 新增目录不在任何 reference 覆盖范围内 | L1 |
| `rule_drifts` | tech-stack.md vs package.json/go.mod 实际依赖 | L2 |
| `orphan_plans` | 已完成任务仍标记为进行中 | L0 |
| `index_drift` | context-index.json vs references/ 实际文件列表 | L0 |

### 6.3 分级修复策略

| 级别 | 行为 | 示例 |
|------|------|------|
| L0：确定性修复 | 完全自动，零 token | 删除已删模块的索引条目、标记新增文件待扫描 |
| L1：AI 辅助修复 | 自动修复 + 验证 | 重新生成过时 reference、更新关联依赖文档 |
| L2：人工审批 | 只标记不修复 | 架构模式变更（REST → gRPC），标记到 briefing 提醒 |
| L3：忽略 | 跳过 | 注释/格式变更，不影响 reference 准确性 |

### 6.4 三种触发策略

**即时触发（post-commit hook）**

只做 L0 确定性修复，耗时 < 1 秒，不拖慢 commit 速度。

```json
{
  "hooks": {
    "PostCommit": [{
      "command": "entropy-scanner --level=L0 --quiet",
      "description": "自动清理已删除模块的索引条目"
    }]
  }
}
```

**批量修复（/ship 完成后）**

做 L0 + L1 修复。状态机追加两个状态：

```
... → DONE → ENTROPY_SCAN → CLEAN
```

耗时约 10-30 秒，不阻塞 commit 流程。

**汇报模式（/briefing）**

展示 L2 待审批项 + 修复统计 + 健康度评分。

```markdown
## 知识库健康度: 87/100

### 自动修复 (上次 /ship 后)
- ✅ 移除了 legacy-adapter 的索引条目
- ✅ 标记 src/notifications/ 待下次 scan-project

### 需要确认 (L2)
- ⚠️ tech-stack.md 声明 Express.js，但 package.json 已换成 Fastify

### 知识库覆盖率
- 12/14 模块有 reference (86%)
- 缺少: notifications, analytics
```

### 6.5 entropy-report.json 输出格式

```json
{
  "scan_id": "ES-20260322-001",
  "scan_point": { "from": "abc1234", "to": "def5678", "commits_scanned": 5 },
  "findings": {
    "stale_refs": [{ "module": "auth-service", "reason": "src/auth/middleware.ts modified", "level": "L1" }],
    "missing_refs": [{ "path": "src/notifications/", "level": "L1" }],
    "rule_drifts": [{ "rule_file": "tech-stack.md", "declared": "Express.js", "actual": "Fastify", "level": "L2" }],
    "orphan_plans": [],
    "index_drift": [{ "type": "in_index_not_on_disk", "module": "legacy-adapter", "level": "L0" }]
  },
  "auto_fixed": ["removed legacy-adapter from context-index.json"],
  "pending_human": ["tech-stack.md: Express → Fastify drift needs confirmation"],
  "health_score": 87
}
```

### 6.6 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `sub-agents/entropy-scanner.md` | 扫描逻辑 + 分级策略 + 输出格式 |
| 新增 | `entropy-config.yml` | 扫描频率 + L0-L3 分级规则 + 白名单 |
| 改造 | `hooks/hooks.json` | 增加 PostCommit 触发 |
| 改造 | `workflows/ship.md` | DONE 后增加 ENTROPY_SCAN → CLEAN |
| 改造 | `workflows/briefing.md` | 增加知识库健康度板块 |

---

## 七、渐进式退化

### 7.1 问题定义

Harness 组件存在的原因是"模型还不能..."。随着模型进步，某些组件会变得多余。如果框架只会膨胀不会瘦身，它就从"助力"变成"负重"。每个组件诞生时就应定义退场条件。

### 7.2 模块成熟度模型

每个组件有四级状态，沿确定方向退化：

| 状态 | 含义 | 上下文成本 |
|------|------|-----------|
| **Active** | 完全启用，不可跳过 | 占用上下文 |
| **Advisory** | 建议性启用，可被覆盖 | 轻量上下文 |
| **Passive** | 仅后台监控，不注入上下文 | 零注入，仅收集指标 |
| **Retired** | 完全移除，归档保留 | 零成本 |

状态转换规则：

- Active → Advisory：模型在此能力上的成功率连续 > 90%
- Advisory → Passive：成功率连续 > 98% 持续 30 天
- Passive → Retired：无介入运行 90 天，零质量问题
- **任何级别发现质量下降 → 自动回滚到上一级**

### 7.3 各组件退化条件

**上下文预算控制**

- 退化条件：模型上下文窗口 > 2M 且自管理上下文成功率 > 95%
- 退化路径：Active → 放宽阈值至 60%（Advisory）→ 仅监控 utilization（Passive）→ 移除（Retired）

**推理三明治**

- 退化条件：单模型全链路首次通过率 > 95%
- 退化路径：三模型 → 双模型（Advisory）→ 单模型保留 phase-gate（Passive）→ 单模型直通（Retired）

**子代理防火墙**

- 退化条件：模型原生支持多推理链隔离和选择性遗忘
- 退化路径：严格契约 → 半结构化输出（Advisory）→ 完整输出传递（Passive）→ 单 agent 多角色（Retired）

**熵治理 scanner**

- 退化条件：模型在任务结束时自动维护知识库准确率 > 98%
- 退化路径：独立 scanner → /ship 内置步骤（Advisory）→ 仅 L0 确定性修复（Passive）→ 信任模型自维护（Retired）

**确定性 hooks（linter/compiler）**

- 退化条件：AI 原生代码生成零 lint 错误率 > 99.5%
- 退化路径：极低概率退化，可能永远保留
- 理由：确定性工具本质上比概率性判断更可靠，这不是"模型不够强"的补偿

### 7.4 harness-manifest.yml

新增 `.agent/harness-manifest.yml` 作为退化机制的唯一真理来源：

```yaml
harness_manifest:
  version: 1
  last_evaluated: 2026-03-22

  components:
    context_budget:
      status: active
      introduced: 2026-03-20
      purpose: "防止上下文溢出导致性能下降"
      retirement_condition:
        description: "模型上下文窗口 > 2M 且自管理成功率 > 95%"
      degradation_path:
        advisory:
          action: "将 40% 硬上限改为 60% 软建议"
          trigger: "overflow_prevented > 90% 连续 30 天"
        passive:
          action: "停止预算注入，仅后台监控"
          trigger: "advisory 下 overflow_rate < 2% 连续 30 天"
        retired:
          action: "移除 skill，归档到 archive/retired/"
          trigger: "passive 90 天零问题"
      rollback:
        trigger: "7 天窗口内 overflow_rate > 10%"
        action: "自动恢复上一级状态"
```

（其余组件格式相同，完整配置见附录。）

### 7.5 maturity-tracker Skill

新增 `skills/maturity-tracker.md`，挂在 `/ship` 的 CLEAN 阶段，收集各组件表现数据，输出到 `.agent/metrics/component-health.json`。在 `/briefing` 中展示成熟度看板：

```
## Harness 成熟度看板

| 组件           | 状态    | 关键指标       | 距下次降级   |
|---------------|--------|---------------|------------|
| 上下文预算控制  | Active | 有效率 87.5%   | 需 > 90%   |
| 推理三明治     | Active | 首次通过率 75% | 需 > 95%   |
| 子代理防火墙   | Active | 污染率 0%      | 需持续 30 天 |
| 熵治理 scanner | Active | 健康分 89↑     | 接近 advisory |
| 确定性 hooks   | Active | 捕获率 100%    | 长期保留    |
```

### 7.6 非对称安全设计

- **降级（减少保护）**：必须由开发者手动修改 `harness-manifest.yml` 并 commit — 主动承担风险
- **回滚（恢复保护）**：自动执行，无需人工确认 — 降低风险不需要等人批准

### 7.7 预测退化顺序

1. **entropy-scanner L1 修复** — 模型上下文理解提升后可自维护
2. **上下文预算控制** — 窗口扩大到 2M+ 后绝对空间足够
3. **推理三明治** — 单模型全链路足够强时
4. **确定性 hooks** — 可能永远不退化

### 7.8 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `harness-manifest.yml` | 全组件退化条件 + 路径 + 回滚策略 |
| 新增 | `skills/maturity-tracker.md` | 组件表现指标收集 |
| 新增 | `metrics/component-health.json` | 指标数据存储 |
| 改造 | `workflows/briefing.md` | 增加成熟度看板 |

---

## 八、整体文件变更汇总

### 8.1 新增文件（10 个）

| 文件 | 所属支柱 | 说明 |
|------|---------|------|
| `context-index.json` | 上下文预算 | reference 元数据索引 |
| `skills/context-budget.md` | 上下文预算 | 预算计算和分配逻辑 |
| `reasoning-config.yml` | 推理三明治 | 模型分配和升级策略 |
| `skills/phase-gate.md` | 推理三明治 | 阶段转换前置条件 |
| `sub-agents/entropy-scanner.md` | 熵治理 | 扫描逻辑和分级策略 |
| `entropy-config.yml` | 熵治理 | 扫描频率和分级规则 |
| `harness-manifest.yml` | 可拆卸性 | 全组件退化条件配置 |
| `skills/maturity-tracker.md` | 可拆卸性 | 组件表现指标收集 |
| `metrics/component-health.json` | 可拆卸性 | 指标数据存储 |
| `skills/architecture-guard.md` | 工具精简 | 合并后的架构检查 skill |

### 8.2 改造文件（9 个）

| 文件 | 涉及支柱 | 改动要点 |
|------|---------|---------|
| `sub-agents/planner.md` | 预算 + 三明治 + 防火墙 | 上下文选择 + 模型升级 + 推理声明 + 输出摘要 |
| `sub-agents/implementer.md` | 三明治 + 防火墙 | 推理声明 + BLOCKED 机制 + 输出摘要 + 合并 documenter |
| `sub-agents/code-reviewer.md` | 三明治 + 防火墙 | 结构化评分 + 输入隔离 + 污染检测 |
| `workflows/start-task.md` | 上下文预算 | 插入 context-manifest 生成步骤 |
| `workflows/ship.md` | 三明治 + 防火墙 + 熵治理 | 状态机 + max_retry + cleanup + entropy_scan |
| `workflows/briefing.md` | 熵治理 + 可拆卸性 | 健康度板块 + 成熟度看板 |
| `workflows/scan-project.md` | 上下文预算 | reference 生成时加 frontmatter |
| `workflows/update-refs.md` | 上下文预算 | 刷新 frontmatter 和索引 |
| `hooks/hooks.json` | 工具精简 + 熵治理 | 双层 hooks + PostCommit 触发 |

### 8.3 移除/归档文件（5 个）

| 文件 | 原因 |
|------|------|
| `sub-agents/researcher.md` | 合并到 planner |
| `sub-agents/documenter.md` | 合并到 implementer |
| `skills/architecture-audit.md` | 合并为 architecture-guard |
| `skills/architecture-check.md` | 合并为 architecture-guard |
| `workflows/agent-update.md` | 降级为手动编辑 |

---

## 九、实施路线图

### Phase 1（1-2 周）：基础设施

- 实现上下文预算控制（context-index + context-budget skill + planner 改造）
- 实现双层 hooks（linter 先行 + AI 后行）
- Sub-agent 精简（5 → 3）和 Skill 精简（3 → 2）

交付标准：`/start-task` 输出 context-manifest.json，hooks 双层执行无误。

### Phase 2（2-3 周）：质量保障

- 实现推理三明治（reasoning-config + phase-gate + 状态机）
- 实现防火墙（输出摘要器 + 输入隔离 + 上下文清洗）
- Workflow 精简（13 → 7）

交付标准：`/ship` 完整走通 PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE 状态机。

### Phase 3（3-4 周）：自维护

- 实现熵治理闭环（entropy-scanner + 三种触发策略 + briefing 集成）
- 实现渐进式退化（harness-manifest + maturity-tracker + briefing 看板）

交付标准：`/briefing` 展示知识库健康度和成熟度看板，post-commit 自动清理。

### Phase 4（持续）：数据驱动优化

- 收集 component-health.json 指标
- 基于数据调整预算阈值、模型分配、退化条件
- 当指标满足条件时，逐步降级组件

---

## 十、设计原则总结

1. **确定性优先**：能用 linter 做的事绝不用 AI 做；能用文件检查做的 gate 绝不用 prompt 约束
2. **复利效应**：一条规则预防所有会话中的同类错误
3. **只解决已发生的问题**：不预设过度工程化的方案，先用简单方案跑起来，基于数据迭代
4. **非对称安全**：减少保护需要人确认，恢复保护自动执行
5. **可观测**：每个机制都有指标输出，决策基于数据而非直觉
6. **可拆卸**：每个组件诞生时就定义退场条件，框架随模型进步自然瘦身

---

## 十一、评估与优化建议

> **评估日期**: 2026-03-24
> **评估人**: Claude Sonnet 4.5
> **评估结论**: 高质量方案，需简化实施

### 11.1 整体评价

#### 优势（8/10）
- ✅ 理论基础扎实（基于 Vercel/Harness Engineering 实践）
- ✅ 设计思路先进（推理三明治、熵治理闭环等创新机制）
- ✅ 工程化程度高（所有机制都有可观测指标和确定性检查）
- ✅ 可操作性强（详细的文件变更清单和实施路线图）

#### 风险（6/10）
- ⚠️ **复杂度悖论**：目标是"精简"，但引入 10+ 新文件和大量新概念
- ⚠️ **成本暴涨**：推理三明治可能导致 API 成本增加 100%-400%
- ⚠️ **效果存疑**：AI 评分准确性、40% 阈值普适性需验证
- ⚠️ **维护负担**：谁来维护 Harness？可能违反"只解决已发生问题"原则

#### 总体建议
采用**渐进式实施 + 数据驱动迭代**策略，而非一次性全部实现。

### 11.2 关键风险详解

#### 风险 1：上下文预算控制的实际效果存疑

**问题**：
1. 让 planner 打 0-10 相关性分数本身消耗 token，且 AI 判断可能不准确
2. `estimated_tokens` 预估值可能因模型 tokenizer 不同而失效
3. 40% 阈值是否适用于所有任务类型？简单任务浪费，复杂任务可能不够

**优化方案**：改用启发式规则（确定性，零 token）

```python
# skills/context-budget-lite.md - 简化版预算控制
def select_context(task_description, references, budget):
    """基于启发式规则的上下文选择（无需 AI 判断）"""

    # 1. 关键词匹配（TF-IDF 或简单词频）
    keywords = extract_keywords(task_description)
    scored = [(ref, keyword_overlap_score(ref, keywords)) for ref in references]

    # 2. 路径相似度（文件路径包含关系）
    file_targets = extract_file_paths(task_description)
    for ref, score in scored:
        if any(path_overlap(ref.module, target) for target in file_targets):
            score += 5  # 直接相关模块加权

    # 3. 依赖图遍历（读取 context-index 的 dependencies 字段）
    selected = []
    selected += top_k_by_score(scored, k=3)  # 前 3 个高分模块
    selected += transitive_dependencies(selected)  # 传递依赖

    # 4. 贪心填充至预算上限
    return greedy_fill(selected, budget)
```

**收益**：
- 消除 AI 评分的不确定性
- 零额外 token 消耗
- 可解释性更强

#### 风险 2：推理三明治成本暴涨

**成本对比**：

| 阶段 | 原方案 | 新方案（默认） | 新方案（复杂任务） | 成本变化 |
|------|--------|---------------|------------------|----------|
| 规划 | haiku | sonnet | opus | +300%~800% |
| 执行 | sonnet | sonnet | sonnet | 持平 |
| 验证 | sonnet | sonnet | opus | 持平~+300% |
| **总计** | 1x | **1.5x-2x** | **3x-4x** | +50%~300% |

**优化方案**：增加成本模式配置

```yaml
# reasoning-config.yml - 增加成本控制
reasoning_sandwich:
  cost_mode: balanced  # conservative | balanced | quality

  modes:
    conservative:
      planning: haiku
      execution: haiku
      verification: sonnet
      max_cost_per_task: 0.1  # USD

    balanced:
      planning: sonnet
      execution: sonnet
      verification: sonnet
      max_cost_per_task: 0.5

    quality:
      planning: opus
      execution: sonnet
      verification: opus
      max_cost_per_task: 2.0

  escalation:
    requires_approval: true  # 升级到 opus 需用户确认
    auto_downgrade_on_budget: true  # 预算不足自动降级
```

#### 风险 3：Sub-agent 精简合理性存疑

**问题分析**：

| 合并项 | 问题 | 建议 |
|--------|------|------|
| researcher → planner | 调研（发散思维）≠ 规划（收敛思维），强行合并可能两头不到岸 | 保留分离，优化默认路由 |
| documenter → implementer | implementer 上下文可能已满，再写文档质量堪忧 | 轻量化 documenter（仅更新 API 文档） |

**优化方案**：保留 5 个 sub-agent，通过更好的路由策略减少用户决策负担

```yaml
# sub-agents/routing-defaults.yml - 新增默认路由配置
workflows:
  /start-task:
    default_pipeline:
      - researcher  # 自动调研（可配置跳过）
      - planner     # 基于调研结果规划

    user_choice: optional  # 用户可手动指定跳过 researcher

  /ship:
    default_pipeline:
      - implementer
      - code-reviewer
      - documenter  # 仅更新 API 文档和 CHANGELOG

    lightweight_mode:  # 快速模式
      - implementer
      - code-reviewer
      # 跳过 documenter
```

#### 风险 4：熵治理触发频率过高

**问题**：
- PostCommit 每次触发：高频提交场景累积延迟
- /ship 后 L0+L1：10-30 秒 × 每天 N 次 = 可观时间成本

**优化方案**：降低触发频率，批量处理

```yaml
# entropy-config.yml - 优化触发策略
triggers:
  post_commit:
    enabled: true
    level: L0
    max_duration: 500ms  # 硬性超时，超时则跳过
    skip_if:
      - only_comments_changed
      - only_test_files
      - outside_agent_dir

  post_ship:
    enabled: true
    level: L0  # 仅确定性修复

  daily_batch:  # 新增批量处理
    enabled: true
    level: L1
    schedule: "0 9 * * *"  # 每天早上 9 点
    report_to: briefing

  manual:
    command: "/entropy-scan --full"
    level: L2
```

#### 风险 5：可拆卸性机制过于复杂

**问题**：
- 4 级状态 + 成熟度追踪 + 自动降级判断
- 这本身就是需要维护的复杂系统（"谁来监控监控系统"？）

**优化方案**：简化为手动配置 + 定期评审

```yaml
# harness-manifest.yml - 简化版
harness_manifest:
  version: 2  # 简化版

  # 手动开关（而非自动降级）
  components:
    context_budget: enabled
    reasoning_sandwich: enabled
    firewall: enabled
    entropy_scanner: enabled
    hooks_dual_layer: enabled

  # 移除复杂的成熟度追踪，改为定期人工评审
  maintenance:
    review_schedule: quarterly  # 每季度评审一次
    review_checklist:
      - "各组件是否仍然必要？"
      - "是否有更简单的替代方案？"
      - "模型能力是否已覆盖该组件功能？"

    # 简单的使用统计（而非复杂的成熟度评分）
    metrics:
      - component_usage_count
      - component_error_rate
      - user_manual_override_rate
```

### 11.3 修正后的实施路线图

#### Phase 0：快速胜利（3-5 天，ROI 极高）

**目标**：最小改动，最大收益

| 项目 | 改动量 | 收益 | 风险 |
|------|--------|------|------|
| Hooks 双层改造 | 1 个文件 | 拦截 90% 低级错误 | 极低 |
| Planner 模型升级 | 1 行配置 | 规划质量显著提升 | 极低 |
| 合并重复 skill | 2 个文件 | 减少决策负担 | 低 |

**交付物**：
```yaml
hooks/hooks.json:
  PostToolUse(Write, Edit):
    layer_1: "npx eslint {file} && npx tsc --noEmit"
    layer_2: "code-evaluation"
    gate: "layer_1 必须通过才触发 layer_2"

sub-agents/planner.md:
  model: sonnet  # 原 haiku

skills/architecture-guard.md:  # 合并 audit + check
```

#### Phase 1：核心质量提升（1-2 周）

**目标**：防死循环、防跳步、防污染

| 项目 | 核心改动 | 简化点 |
|------|---------|--------|
| 推理三明治（简化版） | 状态机 + max_retry + 成本配置 | 去掉复杂 JSON 契约，用简单的结构化输出 |
| Reviewer 输入隔离 | 只看 plan + diff + report | 去掉污染检测（过度防御） |
| Workflow 精简 | 13 → 9 个 | 保留高频独立 workflow，其余降级为内部步骤 |

**交付物**：
```yaml
reasoning-config.yml:
  cost_mode: balanced
  max_retry: 2
  escalation_requires_approval: true

workflows/ship.md:
  states: PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE
  gates: 每个转换有硬性前置条件（文件存在、linter 通过等）
```

#### Phase 2：可选优化（2-3 周，数据驱动）

**前置条件**：Phase 1 运行 2 周，收集基线数据

| 指标 | 当前值 | 目标值 | 是否需要优化 |
|------|--------|--------|-------------|
| 上下文溢出率 | ? | < 5% | 若 > 10% 则实施预算控制 |
| 首次通过率 | ? | > 80% | 若 < 70% 则强化三明治 |
| 知识库健康度 | ? | > 90 | 若 < 80 则实施熵治理 |

**条件实施**：
```yaml
if 上下文溢出率 > 10%:
  实施: 上下文预算控制（启发式版）
else:
  跳过: 当前机制足够

if 知识库健康度 < 80:
  实施: 熵治理 L0+L1
else:
  实施: 仅 L0（轻量维护）
```

#### Phase 3：长期迭代（持续）

**策略**：基于数据决定是否需要

- ❓ 完整的 AI 评分上下文预算控制
- ❓ 可拆卸性自动降级机制
- ❓ Sub-agent 物理合并
- ✅ 定期评审（每季度）

### 11.4 缺失内容补充

#### 11.4.1 基线数据收集

在 Phase 0 完成后，立即开始收集：

```yaml
# metrics/baseline.yml - 新增基线数据收集
metrics:
  context:
    - window_utilization_avg
    - window_utilization_p95
    - overflow_count

  quality:
    - first_pass_rate  # reviewer 首次 PASS 比例
    - retry_count_avg
    - blocking_issues_per_task

  knowledge:
    - stale_refs_count
    - missing_refs_count
    - rule_drift_count

  cost:
    - tokens_per_task_avg
    - cost_per_task_usd
```

#### 11.4.2 降级方案

每个组件提供快速降级开关：

```yaml
# .agent/harness-override.yml - 紧急降级配置
emergency_rollback:
  context_budget:
    enabled: false  # 一键关闭
    fallback: "全量注入 references"

  reasoning_sandwich:
    enabled: false
    fallback: "所有 agent 用 sonnet"

  entropy_scanner:
    enabled: false
    fallback: "仅手动 /update-refs"
```

#### 11.4.3 A/B 测试框架

验证优化效果：

```yaml
# .agent/ab-test.yml - A/B 测试配置
experiments:
  context_budget_test:
    variant_a: "启发式预算控制"
    variant_b: "全量注入"
    metric: "首次通过率"
    sample_size: 20  # 20 个任务后评估

  planner_model_test:
    variant_a: "sonnet"
    variant_b: "haiku"
    metric: "规划质量得分"
    sample_size: 10
```

### 11.5 修订后的设计原则

保留原 6 条，新增 3 条：

7. **渐进式实施**：先快速胜利，再复杂优化，基于数据而非假设
8. **成本可控**：每个优化都要评估成本影响，提供降级选项
9. **简单优先**：能用启发式规则的不用 AI，能用配置的不用代码

### 11.6 修订后的文件变更汇总

#### Phase 0（3-5 天）

| 操作 | 文件 | 说明 |
|------|------|------|
| 改造 | `hooks/hooks.json` | 增加双层验证 |
| 改造 | `sub-agents/planner.md` | 模型 haiku → sonnet |
| 新增 | `skills/architecture-guard.md` | 合并 audit + check |
| 移除 | `skills/architecture-audit.md` | 已合并 |
| 移除 | `skills/architecture-check.md` | 已合并 |

#### Phase 1（1-2 周）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `reasoning-config.yml` | 三明治配置（含成本模式） |
| 新增 | `skills/phase-gate.md` | 状态转换检查 |
| 改造 | `sub-agents/code-reviewer.md` | 输入隔离 |
| 改造 | `workflows/ship.md` | 状态机 + max_retry |
| 改造 | 4 个 workflow | 降级为 /ship 内部步骤 |

#### Phase 2（2-3 周，条件实施）

| 操作 | 文件 | 说明 | 触发条件 |
|------|------|------|----------|
| 新增 | `skills/context-budget-lite.md` | 启发式预算控制 | 溢出率 > 10% |
| 新增 | `context-index.json` | reference 元数据 | 溢出率 > 10% |
| 新增 | `sub-agents/entropy-scanner.md` | 扫描逻辑 | 健康度 < 80 |
| 新增 | `entropy-config.yml` | 扫描配置 | 健康度 < 80 |
| 改造 | `workflows/briefing.md` | 健康度看板 | 实施熵治理后 |

**总计**：Phase 0-2 累计新增 ~8 个文件，改造 ~7 个文件（比原方案减少 40%）

### 11.7 成功标准

#### Phase 0 成功标准
- ✅ Hooks 拦截率 > 90%（linter 能发现的错误）
- ✅ Planner 输出质量提升（主观评估：计划更详细、依赖识别更准确）
- ✅ 用户感知工具面减少（skill 从 3 个降到 2 个）

#### Phase 1 成功标准
- ✅ 首次通过率提升 > 15%
- ✅ 死循环次数 = 0（max_retry 硬性阻断）
- ✅ 成本增幅 < 100%（balanced 模式下）

#### Phase 2 成功标准（若实施）
- ✅ 上下文溢出率 < 5%
- ✅ 知识库健康度 > 90
- ✅ 熵扫描耗时 < 1 秒（L0）或 < 30 秒（L1 批量）

### 11.8 最终建议

#### ✅ 立即采纳
1. Hooks 双层改造
2. Planner 模型升级
3. 合并重复 skill
4. 推理三明治（简化版）
5. Workflow 精简

#### ⚠️ 条件采纳（基于数据）
1. 上下文预算控制（启发式版）
2. 熵治理 L0+L1
3. Sub-agent 路由优化（保留 5 个）

#### ❌ 暂缓采纳
1. 完整的 AI 评分上下文预算控制
2. 可拆卸性自动降级机制
3. Sub-agent 物理合并
4. 熵治理 L2 人工审批

#### 核心哲学
**"先做减法，再做加法；先收集数据，再优化系统"**

---

*文档版本：v2.0 | 原方案日期：2026-03-22 | 评估日期：2026-03-24 | 适用于 cortex-agent main 分支*
