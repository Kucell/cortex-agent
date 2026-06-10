# Knowledge Lint 与 Doc-Gardening 设计

> 对应任务：T-H12、T-H13、T-H16
> 状态：第一版 knowledge lint 与 doc-gardening 已实现，并接入 `/briefing` / `/ship` 说明层

---

## 1. 目标

为 Cortex Agent 建立一套轻量、确定性优先的知识库维护机制，用于抑制文档漂移和知识结构失真。

这套机制分成两层：

- **knowledge lint**：确定性检查，回答“文档结构是否还成立”
- **doc-gardening**：小步维护，回答“哪些地方应该被继续整理”

---

## 2. 设计原则

1. 先做确定性检查，再考虑 AI 辅助修复
2. 先检查结构正确性，再检查语义新鲜度
3. 优先发现“阻断型问题”，再记录“建议型问题”
4. 所有输出都应落到仓库资产或指标文件，而不是只停留在对话中

---

## 3. Knowledge Lint 范围

第一版 knowledge lint 建议只覆盖确定性问题。

### 3.1 断链检查

检查对象：

- `docs/` 内部 Markdown 链接
- `.agent/` 中引用的本地文件路径
- `AGENTS.md` 和入口文件中指向的关键文档

失败条件：

- 文件不存在
- 锚点明显错误
- 路径已迁移但文档未更新

### 3.2 知识域入口检查

检查对象：

- `docs/quality/README.md`
- `docs/reliability/README.md`
- `docs/security/README.md`
- `docs/exec-plans/README.md`
- `docs/exec-plans/active/README.md`
- `docs/exec-plans/completed/README.md`

失败条件：

- 目录存在但缺 README
- README 存在但没有职责说明

### 3.3 计划生命周期检查

检查对象：

- `docs/exec-plans/active/`
- `docs/exec-plans/completed/`
- `.agent/plans/task-progress.md`

失败条件：

- active plan 标为完成但未迁移或未注明状态
- `task-progress.md` 里有活跃任务，但 `docs/exec-plans/active/` 无承接计划
- completed plan 缺归档说明

### 3.4 架构文档一致性检查

检查对象：

- `docs/architecture.md`
- `docs/architecture/*.md`
- `.agent/sub-agents/`
- `.agent/workflows/`
- `.agent/skills/`

失败条件：

- 文档提到已不存在的 skill / workflow / sub-agent
- 新增核心目录或角色，但架构文档未提及

### 3.5 技术债务承接检查

检查对象：

- `docs/tech-debt.md`
- 活跃计划与设计文档中的风险项

失败条件：

- 设计文档明确指出的结构性债务没有承接入口
- 已知高优先级债务缺少建议动作

---

## 4. Doc-Gardening 范围

doc-gardening 不直接修改所有问题，而是聚焦“高回报、低风险”的整理动作。

第一版建议关注：

- 补 README 入口
- 修复断链
- 修正明显过时的文件名、目录名和引用路径
- 提醒需要迁移 active/completed plan 的计划文件
- 将高频重复风险沉淀进 `docs/tech-debt.md`

不建议第一版就做：

- 自动重写大段架构文档
- 自动生成复杂设计结论
- 自动删除历史文档

---

## 5. 触发策略

### 5.1 `/ship` 后轻量检查

目标：

- 快速发现结构破坏
- 不阻塞主开发太久

建议行为：

- 运行 knowledge lint 的核心子集
- 只输出阻断项和高优先级建议

### 5.2 `/briefing` 展示待处理项

目标：

- 让文档与知识漂移进入每日可见范围

建议行为：

- 展示断链数、缺入口数、待归档计划数
- 展示最近一次 doc-gardening 的结果摘要

### 5.3 定时批处理

目标：

- 在不打扰主流程的情况下做稍重的整理

建议行为：

- 作为后续增强项引入
- 优先做建议型问题汇总，不直接自动合并修复

### 5.4 当前已实现落点

当前仓库已落地：

- `knowledge-lint` 负责生成 `.agent/metrics/knowledge-health.json`
- `doc-gardening` 负责基于 knowledge health 生成 `.agent/metrics/doc-gardening-report.json`
- `/briefing` 读取 knowledge health 与 doc-gardening 报告
- `/ship` 在 `KNOWLEDGE_LINT` 之后追加 `DOC_GARDENING` 建议生成阶段

仍未落地：

- 定时 heartbeat / cron 维护
- 文档 stale 检测
- 自动提交型文档整理

为后续接入真实 automation，当前已补充运行手册：

- [Knowledge Maintenance Runbook](./knowledge-maintenance-runbook.md)

---

## 6. 落地位置建议

### 6.1 文档资产

- 本设计文档保存在 `docs/quality/`
- 相关计划保存在 `docs/exec-plans/`
- 债务沉淀保存在 `docs/tech-debt.md`

### 6.2 后续脚本

已新增：

- `.agent/skills/knowledge-lint/`
- `.agent/skills/knowledge-lint/scripts/index.js`
- `.agent/skills/doc-gardening/`
- `.agent/skills/doc-gardening/scripts/index.js`

理由：

- 保持零依赖
- 与现有 `architecture-guard`、`context-budget` 等 skill 结构一致

### 6.3 Hook 与 Workflow 接入点

建议后续接入：

- `.agent/workflows/ship.md`
- `.agent/workflows/briefing.md`
- 必要时增加一个轻量 `/agent-update` 子步骤或文档维护步骤

### 6.4 指标输出

当前输出到：

- `.agent/metrics/knowledge-health.json`
- `.agent/metrics/doc-gardening-report.json`

当前核心指标：

- broken_links
- missing_readmes
- stale_active_plans
- undocumented_core_paths
- debt_items

---

## 7. 下一轮实现建议

后续增强建议分三步：

### Step 1：先做 knowledge lint

- 实现断链检查
- 实现 README 缺失检查
- 实现 plan 生命周期检查
- 输出 `knowledge-health.json`

### Step 2：再接 briefing / ship

- `/briefing` 消费 `knowledge-health.json`
- `/ship` 做轻量检查
- doc-gardening 先只生成建议，不自动改大段文档

### Step 3：再接定时维护

- 通过 heartbeat 或 cron 周期性生成 doc-gardening 报告
- 只汇总建议，不默认自动提交
- 具体输入、边界和 prompt 约定见 `knowledge-maintenance-runbook.md`

---

## 8. 结论

T-H12/T-H16 的结论不是“立刻上自动改文档”，而是：

> 先把知识库维护机制限制在确定性、低风险、高信噪比的范围内，再逐步增加 AI 辅助整理能力。

这是当前 Cortex Agent 更稳妥的推进方式。
