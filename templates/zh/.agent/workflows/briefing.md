---
description: 每日晨播，快速同步项目进度、活跃任务及今日优先动作
---

# 项目简报工作流 (/briefing)

当你开始新的一天工作，需要快速进入状态时，执行此流程：

## 1. 进度回顾 (Progress Scan)
- **核心数据**：详细阅读 `.agent/plans/task-progress.md`，提取当前的 Roadmap 阶段和总体百分比。
- **昨日成就**：扫描 `task-progress.md` 的 "Accomplishments" 部分，汇总最近完成的关键里程碑。
- **(可选) 代码动态**: 如果配置了 `git-plugin`，**调用它来获取最近 3-5 次的 Git 提交历史**，以了解代码层面的实际进展。

## 2. 活跃现场 (Active Scene)
- **识别核心任务**：定位 "Active Tasks" 中优先级最高的项。
- **上下文提取**：如果是复杂任务，查阅对应的子计划文件（`.agent/plans/*.md`），搞清楚“停在具体哪一步了”。

## 3. 风险与阻塞 (Risk & Blockers)
- **检查警示**：识别计划中标记为 "Blocked" 或 "Pending" 的项。
- **环境检查**：简要扫描最近的修改逻辑（如有必要），确认是否有未修复的重构中断。

### 通信与审批现场

运行以下只读查询：

```bash
node .agent/skills/management-api/scripts/index.js query decisions
node .agent/skills/management-api/scripts/index.js query waitpoints
node .agent/skills/management-api/scripts/index.js query inbox
```

展示：

- `status=open` 的 Decisions：ID、prompt、action、resource_ref、requested_by，以及下一步 `/approve decision <decision-id>`；用户也可在当前唯一 Decision 上明确回复“批准/拒绝/需要修改”，由主 Agent 路由到 `/approve` 持久化。
- `status=pending|blocked` 的 Waitpoints：ID、owner_workflow、reason、Decision ID 和受保护资源。只有 owner workflow 可以释放。
- `status=unread` 的 Inbox：ID、sender、subject 和关联 artifact；读取简报不得自动标记 read/acknowledged。

优先级固定为：blocking Waitpoint 对应的 open Decision → 其他 open Decision → unread Inbox → 普通任务。Dashboard 和 `/briefing` 都是只读面，不得解析 Decision、释放 Waitpoint 或确认 Inbox。

## 4. 知识库健康度（Entropy Status）

读取 `.agent/entropy-report.json`（若存在），输出知识库状态：

```
## 知识库健康度: {health_score}/100 {状态 emoji}

### 上次 /ship 后自动修复
- ✅ {auto_fixed 列表}（若无修复，显示”无需修复”）

### 待确认 (L2 人工审批)
- ⚠️ {pending_human 列表}（若无，显示”无待审项”）

### 知识库覆盖率
- {已有 reference 数} / {context-index.json 模块总数} 个模块有 reference ({百分比}%)
- 待补充：{missing_refs 列表，若有}
```

健康度评级：
- 90-100：✅ 健康
- 70-89：⚠️ 轻微偏差，建议下次 /ship 后关注
- < 70：🔴 需关注，建议运行 `/update-refs` 或确认 L2 待审项

若 `entropy-report.json` 不存在，显示：”知识库首次使用，建议运行 `/scan-project` 建立基线”。

---

## 5. Harness 成熟度看板（Maturity Dashboard）

读取 `.agent/metrics/component-health.json`（若存在），展示各组件成熟度状态：

```
## Harness 成熟度看板

| 组件              | 状态    | 关键指标（30天均值）     | 距下次降级       |
|------------------|--------|------------------------|----------------|
| 上下文预算控制     | Active | 溢出率: 0%，均值利用率: 28% | 需持续 30 天   |
| 推理三明治         | Active | 首次通过率: 87.5%        | 需 > 90%        |
| Sub-agent 防火墙   | Active | 污染率: 0%              | 接近 advisory   |
| 熵治理 scanner    | Active | 健康均分: 89↑            | 需 > 95         |
| Phase Gate       | Active | 阻断率: 3.2%（正常）     | 长期保留        |
| 确定性 Hooks      | Active | Lint 捕获率: 100%        | 长期保留        |
```

若有退化建议（来自 `degradation_suggestions` 字段），在此展示：
```
⚡ 退化建议：[组件名] 满足 [advisory/passive] 条件。
   具体操作：手动修改 harness-manifest.yml 并提交。
```

若 `component-health.json` 不存在，显示：”成熟度追踪首次使用，完成首个 /ship 后自动初始化”。

---

## 6. 知识结构健康度（Knowledge Health）

读取 `.agent/metrics/knowledge-health.json`（若存在），展示知识结构健康度：

```
<!-- cspell:disable -->
## Knowledge Health: {health_score}/100

### Summary
- Markdown files scanned: {markdown_files_scanned}
- Broken links: {broken_links}
- Broken anchors: {broken_anchors}
- Missing READMEs: {missing_readmes}
- Plan issues: {plan_issues}
- Architecture doc mismatches: {architecture_doc_mismatches}

### Actionables
- 阻断项：{高优先级问题列表}
- 建议项：{低优先级问题列表}
<!-- cspell:enable -->
```

健康度建议：
- 100：✅ 结构健康
- 80-99：⚠️ 有轻微漂移，建议近期整理
- < 80：🔴 需要优先处理知识结构问题

若 `knowledge-health.json` 不存在，显示：”Knowledge Lint 尚未运行，建议先执行 `node .agent/skills/knowledge-lint/scripts/index.js`”。

---

## 7. Doc-Gardening 整理建议

读取 `.agent/metrics/doc-gardening-report.json`（若存在），展示最近一次知识整理建议：

```
## Doc-Gardening: {status}

### Summary
- Actionable items: {actionable_items}
- P0 items: {p0_items}
- Quick wins: {quick_wins}
- Manual review items: {manual_review_items}

### Recommended Focus
- {recommended_focus}

### Top Actions
- {前三条建议动作}
```

建议解释：
- `healthy`：✅ 当前无需额外整理
- `advisory`：⚠️ 建议在本周内处理 quick wins
- `attention`：🔴 建议优先安排知识整理动作
- `blocked`：⚠️ 先运行 knowledge lint，再生成整理建议

若 `doc-gardening-report.json` 不存在，显示：”Doc-Gardening 尚未运行，建议执行 `node .agent/skills/doc-gardening/scripts/index.js`”。

---

## 8. Coordinator 健康度看板（Coordinator Health）

运行脚本生成报告：

```bash
node .agent/registry/scripts/coordinator-health.js
```

读取 `.agent/metrics/coordinator-health.json`（若存在），展示多 agent 协调层健康状态：

```
## Coordinator Health: {health_score}/100 {状态 emoji}

| 指标 | 值 |
|------|-----|
| 活跃 Agent | {active} |
| 已交接 Agent | {handed_off} |
| 心跳超时 | {stale} |
| 已过期 Agent | {expired} |
| 持有锁 | {held_locks} |
| 待接收 Handoff | {pending_handoffs} |
| Artifact 总数 | {total_artifacts} |

{warnings 列表，若无则显示 “✅ 无告警”}
```

健康度评级：
- 90-100：✅ 协调层健康
- 70-89：⚠️ 有降级风险，检查 stale agent 和 held lock
- < 70：🔴 协调层异常，手动运行 `node .agent/registry/scripts/agent-registry.js sweep-stale` 清理

若 `coordinator-health.json` 不存在，显示：”Coordinator 健康度首次使用，运行 `node .agent/registry/scripts/coordinator-health.js` 生成基线”。

---

## 9. 产出”咖啡简报” (The Briefing)
输出一个极简但包含核心信息的报告：
- **🚩 总体态势**：[项目处于什么阶段，距离下一里程碑还有多远]
- **✅ 最近进展**：[过去 24h 完成了什么]
- **🔥 正在进行的重点**：[任务 ID 与当前具体进展点]
- **🎯 推荐今日接入点**：[建议开发者今天第一个打开哪个文件，从哪行代码或哪个功能点开始]
- **⚠️ 待排查风险**：[需要注意的潜在问题 + L2 待审的熵偏差 + knowledge lint 发现 + doc-gardening 建议]
- **🛑 待用户决策**：[open Decisions 与精确 resource_ref；下一步 `/approve decision D-...`]
- **⏸ 阻塞点**：[blocking Waitpoints、owner workflow 与释放条件]
- **📥 未读消息**：[unread Inbox 摘要；不在简报中自动确认]

---

## 10. 自动维护 (Auto-Maintenance)
// turbo
- 如果用户指出进度有出入，立即通过 `/sync-plans` 更新所有计划文档。
- 如果 `doc-gardening` 为 `attention` 或存在 `P0` 项，建议按 `docs/quality/knowledge-maintenance-runbook.md` 执行一次知识维护。

## 11. 安全边界

- destructive、credential、external_side_effect 必须由 owning workflow 创建 Decision/Waitpoint，并在用户明确选择后由该 workflow 消费。
- 简报不得把 `--gate approve`、Dashboard 请求或历史选择解释为批准。
- 不自动执行 reset、revert、push、deploy、publish 或任何外部副作用。
