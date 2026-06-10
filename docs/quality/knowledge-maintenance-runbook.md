# Knowledge Maintenance Runbook

> 目标：为后续 heartbeat / cron 自动维护提供统一执行入口，而不在当前阶段直接创建真实 automation。

---

## 1. 适用场景

本 Runbook 用于以下两类维护场景：

- **Heartbeat 维护**：在同一线程里周期性检查知识健康度，适合活跃仓库
- **Cron 维护**：独立周期任务做知识巡检，适合稳定仓库或团队统一巡检

当前仓库尚未直接创建 automation，但后续无论接 heartbeat 还是 cron，都应遵循这里的输入、步骤与输出约定。

---

## 2. 输入资产

维护任务至少应读取以下文件：

- `.agent/metrics/knowledge-health.json`
- `.agent/metrics/doc-gardening-report.json`
- `.agent/entropy-report.json`（若存在）
- `.agent/plans/task-progress.md`
- `docs/tech-debt.md`

若 `knowledge-health.json` 不存在，先执行：

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

若 `doc-gardening-report.json` 不存在，随后执行：

```bash
node .agent/skills/doc-gardening/scripts/index.js
```

---

## 3. 推荐频率

### 3.1 Heartbeat

推荐用于：

- 最近一周持续活跃开发的仓库
- 正在频繁调整 workflow / docs / sub-agent / skill 的阶段

建议频率：

- 每周 1 次
- 或在连续多次 `/ship` 后补跑 1 次

### 3.2 Cron

推荐用于：

- 团队共享仓库
- 文档资产较多、但变更节奏相对稳定的仓库

建议频率：

- 每周 1 次固定时段
- 不建议低于每日级别

---

## 4. 标准执行步骤

### Step 1：刷新健康度

执行：

```bash
node .agent/skills/knowledge-lint/scripts/index.js
node .agent/skills/doc-gardening/scripts/index.js
```

目标：

- 保证维护基于最新知识状态，而不是过期报告

### Step 2：识别优先级

按以下顺序判断：

1. 是否存在 `P0` 项
2. `knowledge-health` 是否低于 `80`
3. `doc-gardening` 是否为 `attention`
4. 是否存在可立即处理的 quick wins

### Step 3：分类动作

将发现分为三类：

- **立即修复**：断链、失效锚点、缺 README
- **人工确认**：plan 生命周期迁移、架构文档同步
- **仅记录**：重复出现但本轮不应直接改动的结构性问题

### Step 4：产出维护结论

维护任务至少应输出：

- 当前 `knowledge-health` 分数
- 当前 `doc-gardening` 状态
- 本轮建议动作数量
- 是否存在 `P0`
- 推荐下一个维护动作

---

## 5. 执行边界

维护任务默认应遵循以下边界：

- 可以刷新指标文件
- 可以输出建议摘要
- 可以修复低风险 quick wins
- **不要**默认自动重写大段架构文档
- **不要**默认自动迁移 active/completed plan
- **不要**默认自动提交或自动推送

如果要跨过这些边界，应由明确的人类指令触发。

---

## 6. 建议输出格式

建议维护任务输出如下摘要：

```text
## Knowledge Maintenance

- Knowledge health: 96/100
- Doc-gardening status: advisory
- P0 items: 0
- Quick wins: 2
- Manual review items: 1

### Recommended Focus
- 先修复 quick wins，再安排架构文档同步
```

---

## 7. Automation Prompt 约定

如果后续要创建 heartbeat / cron，prompt 应只描述任务本身，不应写调度信息。

推荐 prompt 模板：

```text
刷新 knowledge lint 与 doc-gardening 报告，读取 knowledge-health、doc-gardening-report、entropy-report、task-progress 与 tech-debt，输出本轮知识维护摘要。若只有低风险 quick wins，可直接提出修复建议；若存在 P0、plan 生命周期问题或架构文档同步问题，优先输出风险与下一步建议。
```

推荐要求：

- 输出必须引用具体文件
- 没有问题时也要返回当前健康状态
- 不要默认创建 commit / PR

---

## 8. 当前结论

当前 Cortex Agent 已具备：

- `knowledge-lint`
- `doc-gardening`
- `/briefing` 中的可见面
- `/ship` 后的刷新链路

下一步缺的不是“再写一个脚本”，而是把这套 Runbook 接到真实 heartbeat / cron 上。
