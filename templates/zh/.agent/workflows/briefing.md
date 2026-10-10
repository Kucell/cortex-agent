---
description: 每日晨播，快速同步项目进度、活跃任务及今日优先动作
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules: []
linked_workflows: []
owner: Kucell
last_verified: 2026-10-02
status: stable
---

# 项目简报工作流 (/briefing)

当你开始新的一天工作，需要快速进入状态时，执行此流程：

## 0. Runtime Continuity 恢复包

先运行只读恢复入口，读取同一项目在不同 agent 工具之间同步的结构化工作状态：

```bash
PROJECT_NAME=$(basename "$(pwd)")
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project "$PROJECT_NAME"
```

输出中重点提取：

- `latest_archive` / `latest_markdown_archive`
- `runtime_events`
- `pending_handoffs`
- `runs` / `sessions`
- `artifact_states`
- `git.status_short`
- `next_action`

若 `latest_archive` 不存在，明确说明尚未建立 Runtime Continuity archive，并继续执行后续只读扫描。

## 0.5 One-Click Update 状态

## One-Click Update: {status}

- Update ID: {update_id}
- Finished: {finished_at}
- Changes: added={summary.added}, updated={summary.updated}, merged={summary.merged}, protected={summary.protected}
- Verification: failed={summary.verification_failed}, skipped={summary.verification_skipped}
- Report: .agent/updates/latest.json
```

如果 `status` 是 `failed`，把它列入风险；如果是 `partial`，列出 protected 项并提醒先 review 后再考虑 `--force-scripts`。若报告不存在，显示：“尚未生成 One-Click Update 报告，可运行 `cortex-agent update --verify --report json` 检查当前升级状态。”


## 0.6 cortex-agent 版本陈旧提示

只读探测最新版本，从不自动升级：

```bash
# 读到机器可读的 JSON 信封（含 available_update 字段）
cortex-agent doctor --json
```

`available_update` 字段契约（由 `cortex-agent doctor --json` 输出）：

- `status`: `"current"` / `"outdated"` / `"unknown"`（网络/registry 不可达）
- `current`: 当前 CLI 版本（与 package.json 一致）
- `latest`: registry 最新版本；不可达时为 `null`
- `outdated`: `true` / `false` / `null`（与 `status` 一一对应）
- `upgrade_hint`: 仅当 `outdated=true` 时给出推荐命令
- `checked_at`: ISO 时间戳

**输出建议**：

- `status === "outdated"`：列出 `upgrade_hint`（建议 `npm install -g cortex-agent@<latest>`，再 `cortex-agent upgrade`），并列入风险/今日动作。
- `status === "unknown"`：仅提示"无法连接 npm registry"，不要阻塞简报。
- `status === "current"`：可静默；不要打扰用户。

**明确边界**：本探测**不**触发 SessionStart hook，**不**写入 `.agent/.cortex-version`，**不**调用 `cortex-agent upgrade` / `update`。版本升级仍由 owner 显式触发。

## 1. 进度回顾 (Progress Scan)
- **核心数据**：详细阅读 `.agent/plans/task-progress.md`，提取当前的 Roadmap 阶段和总体百分比。
- **昨日成就**：扫描 `task-progress.md` 的 "Accomplishments" 部分，汇总最近完成的关键里程碑。
- **(可选) 代码动态**: 如果配置了 `git-plugin`，**调用它来获取最近 3-5 次的 Git 提交历史**，以了解代码层面的实际进展。

## 1.5 项目模块 / 子系统进度（Module / Subsystem Progress）

在总体 Roadmap / Mission 进度之后，必须单独给出项目模块或子系统视图，回答“项目各组成部分分别完成到哪里”。

### 数据来源优先级

按以下优先级读取，不得为了凑表格自行推断：

1. `.agent/references/context-index.json` 与对应模块 reference（若存在）
2. 当前 Mission / Milestone / Task 的结构化状态
3. `.agent/plans/task-progress.md` 与相关子计划
4. Git / PR / CI / validation evidence 仅作为实现证据，不单独等价于“完成”

如果模块索引尚未建立，明确写“模块基线未建立”，并建议运行 `/scan-project`；如果代码已发生重大变化但 reference 陈旧，建议运行 `/update-refs`。

### 输出要求

至少输出：

| 模块 / 子系统 | 当前范围 | 状态 | 完成度 | 证据 / 来源 | 下一缺口 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| {module} | {scope} | {PASS / IN PROGRESS / BLOCKED / PLANNED} | {显式百分比或“未量化”} | {Mission / Task / Reference / PR / CI} | {next gap} |

规则：

- **不得根据文件数量、commit 数量、PR 数量或主观印象计算完成度。**
- 只有结构化状态或项目计划明确提供百分比时才显示百分比；否则写“未量化”。
- Milestone 进度与模块进度必须分开：一个 Milestone 可以跨多个模块，一个模块也可以被多个 Milestone 持续演进。
- 代码已完成但治理证据、验证契约或合并尚未完成时，状态应写成“Implementation Complete / Governance Pending”之类的分层状态，不得直接写 PASS。
- 遵循 **EXP-003**：状态维度结构化分离，共享判定只使用一个事实来源；不要把文本中的“通过/完成”字样误解析成真实任务状态。
- 如果用户要求“项目整体进度”，该模块表是默认输出的一部分，而不是可选附录。

---

## 2. 活跃现场 (Active Scene)
- **识别核心任务**：定位 "Active Tasks" 中优先级最高的项。
- **上下文提取**：如果是复杂任务，查阅对应的子计划文件（`.agent/plans/*.md`），搞清楚“停在具体哪一步了”。

## 3. 风险与阻塞 (Risk & Blockers)
- **检查警示**：识别计划中标记为 "Blocked" 或 "Pending" 的项。
- **环境检查**：简要扫描最近的修改逻辑（如有必要），确认是否有未修复的重构中断。

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
- **🧩 模块进度**：[按模块 / 子系统列出状态、显式完成度、证据与下一缺口]
- **✅ 最近进展**：[过去 24h 完成了什么]
- **🔥 正在进行的重点**：[任务 ID 与当前具体进展点]
- **🎯 推荐今日接入点**：[建议开发者今天第一个打开哪个文件，从哪行代码或哪个功能点开始]
- **⚠️ 待排查风险**：[需要注意的潜在问题 + L2 待审的熵偏差 + knowledge lint 发现 + doc-gardening 建议]

---

## 10. 自动维护 (Auto-Maintenance)
// turbo
- 如果用户指出进度有出入，立即通过 `/sync-plans` 更新所有计划文档。
- 如果 `doc-gardening` 为 `attention` 或存在 `P0` 项，建议按 `docs/quality/knowledge-maintenance-runbook.md` 执行一次知识维护。

## Communication Runtime Integration

`/briefing` 是只读通信表面：

- 通过 `query decisions` 汇总 open / approved / rejected / superseded decisions；通过 `query waitpoints` 列出 pending / blocked / released / canceled / expired 状态；通过 `query inbox` 列出 unread / read / acknowledged 收件箱。
- 只读：briefing 不得解析 Decision、释放 Waitpoint，或调用 `decisions resolve`、`waitpoints release`。任何需要用户决定的项都列出上下文、风险与候选方案，等待 owning workflow 处理。
- Checkpoint 引用：Decision 与 Waitpoint 的 `relations.task_ids / mission_ids` 可用于附加上下文，但不触发任何动作。
- read-only 语义贯穿所有 briefing 视图：包括 approvals、pending inbox 与 stale waitpoints。
