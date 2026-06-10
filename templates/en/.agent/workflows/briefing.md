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

## 6. Knowledge Health (Knowledge Lint)

Read `.agent/metrics/knowledge-health.json` (if present) and show repository knowledge health:

```
## Knowledge Health: {health_score}/100

### Summary
- Markdown files scanned: {markdown_files_scanned}
- Broken links: {broken_links}
- Broken anchors: {broken_anchors}
- Missing READMEs: {missing_readmes}
- Plan issues: {plan_issues}
- Architecture doc mismatches: {architecture_doc_mismatches}

### Actionables
- Blocking items: {high-priority findings}
- Advisory items: {lower-priority findings}
```

Health guidance:
- 100: ✅ structurally healthy
- 80-99: ⚠️ mild drift, schedule cleanup soon
- < 80: 🔴 prioritize knowledge-structure cleanup

If `knowledge-health.json` does not exist, show: "Knowledge Lint has not run yet. Run `node .agent/skills/knowledge-lint/scripts/index.js` first."

---

## 7. Doc-Gardening Summary

Read `.agent/metrics/doc-gardening-report.json` (if present) and show the latest documentation maintenance suggestions:

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
- {top three suggested actions}
```

Status guidance:
- `healthy`: no extra gardening is needed now
- `advisory`: handle quick wins this week
- `attention`: prioritize knowledge maintenance soon
- `blocked`: run knowledge lint before generating gardening suggestions

If `doc-gardening-report.json` does not exist, show: "Doc-gardening has not run yet. Consider running `node .agent/skills/doc-gardening/scripts/index.js`."

---

## 8. 产出”咖啡简报” (The Briefing)
输出一个极简但包含核心信息的报告：
- **🚩 总体态势**：[项目处于什么阶段，距离下一里程碑还有多远]
- **✅ 最近进展**：[过去 24h 完成了什么]
- **🔥 正在进行的重点**：[任务 ID 与当前具体进展点]
- **🎯 推荐今日接入点**：[建议开发者今天第一个打开哪个文件，从哪行代码或哪个功能点开始]
- **⚠️ 待排查风险**：[需要注意的潜在问题 + L2 待审的熵偏差 + knowledge lint 发现 + doc-gardening 建议]

---

## 9. 自动维护 (Auto-Maintenance)
// turbo
- 如果用户指出进度有出入，立即通过 `/sync-plans` 更新所有计划文档。
- If `doc-gardening` is `attention` or contains `P0` items, recommend following `docs/quality/knowledge-maintenance-runbook.md` for one maintenance pass.
