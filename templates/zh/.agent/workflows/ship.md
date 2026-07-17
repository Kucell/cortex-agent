---
name: ship
description: 任务完成后的一键收尾：代码审查 → 提交 → 标记完成 → 同步计划。将 /code-review + /commit + /done + /sync-plans 串联为单一流程。Phase 1: 增加状态机和 max_retry 限制。
---

# 任务交付工作流 (/ship)

当你完成了某个任务的编码，执行此流程完成交付闭环。

## Phase 1 增强：状态机 + 重试控制

**状态流转**：`PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE → CONTEXT_CLEANUP → ENTROPY_SCAN → KNOWLEDGE_LINT → DOC_GARDENING → PUBLISH_DOCS → CLEAN`

**关键特性**：
- ✅ **Phase Gate 检查**：每个转换有硬性前置条件
- ✅ **Max Retry 限制**：每个阶段最多重试 2 次（来自 `reasoning-config.yml`）
- ✅ **Auto Rollback**：失败时自动回滚到上一稳定状态
- ✅ **成本可控**：基于 `cost_mode` 选择模型（balanced 模式默认）

## 任务流水线接入

`/ship` 执行前读取 `.agent/tasks/<task-id>.json` 与 `.agent/tasks/README.md`。存在任务记录时，task pipeline gate 是阶段推进的权威依据；`task-progress.md` 继续用于路线图展示。旧任务没有记录时保留传统流程，但必须在报告中注明“未启用 task pipeline”，不得伪造已通过的 gate。

状态机与 task stage 的映射如下：

| `/ship` 状态 | Task stage / artifact 动作 |
| :--- | :--- |
| `PLAN -> EXECUTE` | 检查 `plan -> implement`：依赖均为 `done`，final `plan` 与条件性的 final `architecture` 工件存在；通过后进入 `implement`。 |
| `EXECUTE -> LINT` | 追加 final `implementation` 工件，引用 diff、commit 或执行报告；通过 `implement -> validate`。 |
| `LINT -> REVIEW` | lint、测试和安全检查通过后追加 final `validation` 工件；通过 `validate -> review`。失败时 gate 为 `blocked`，stage 保持 `validate`。 |
| `REVIEW -> COMMIT` | 追加 final `review` 工件。存在 Must Fix 时保持 `review` 并阻断；`--no-review` 仅在用户显式选择时记录 `waived` gate 和原因。 |
| `COMMIT -> DONE` | 检查 review 结论、提交证据，以及条件性的 `release-note` / `published-doc` 要求；通过 `review -> done` 后设置 `status: completed`。 |
| `PUBLISH_DOCS` | 若执行文档发布，消费 final 工件并把 `/publish-docs` 返回的 final `published-doc` 引用回填任务；不单独改变 stage。 |

每次变更同步任务文件、`.agent/tasks/index.json`、`updated_at` 和 gate `evidence_refs`。工件正文保持在 `.agent/artifacts/<task-id>/` 或其原始真理源中；任务文件只保存规范 kind 与引用。失败后追加修复工件并重检当前 gate，不倒退 stage、不覆盖旧工件，也不通过 Management API 直接修改任务。

## 使用方式

```
/ship T-001
/ship T-001 T-002        （同时交付多个任务）
/ship T-001 --no-review  （跳过代码审查，直接提交）
```

## 执行步骤（状态机模式）

### Phase 0: PLAN（可选，如果任务已有明确计划则跳过）

**Gate Check**: `phase-gate --from START --to PLAN`
- ✅ 任务描述存在
- ✅ 架构约束已加载（`.agent/rules/architecture-design.md`）

**输出**: 实施计划（如已存在则跳过）

---

### Phase 1: EXECUTE

**Gate Check**: `phase-gate --from PLAN --to EXECUTE`
- ✅ 实施计划已完成（或明确验收标准已提供）
- ✅ 架构预审通过（`architecture-guard`）

**执行**: 代理完成编码实现

**Max Retry**: 2 次（若连续 2 次实现失败，阻断并请求人工介入）

---

### Phase 2: LINT

**Gate Check**: `phase-gate --from EXECUTE --to LINT`
- ✅ 代码文件已写入/编辑
- ✅ git status 显示改动

**执行**: 运行 `.agent/hooks/pre-commit-check.sh`
- Linter 检查（ESLint, Ruff 等）
- 密钥扫描

**Blocking Condition**: Linter 失败 → 阻断，提示修复

**Max Retry**: 2 次（连续 2 次 lint 失败 → 请求人工检查规则或手动修复）

---

### Phase 3: REVIEW

**Gate Check**: `phase-gate --from LINT --to REVIEW`
- ✅ Linter 检查通过（exit code 0）
- ✅ 无安全漏洞检测

**执行**: 调用 `code-reviewer` sub-agent
- 输入隔离：只看 plan + diff + previous reports
- 架构合规性检查（`architecture-guard`）
- 代码质量评分（`code-evaluation`）
- 安全扫描（`security-scan`）

**输出格式**:
```
## Review Report
### ✅ Passed
### ⚠️ Suggestions
### ❌ Must Fix
### Summary
```

**Blocking Condition**: "❌ Must Fix" 非空 → 阻断，回滚到 EXECUTE 阶段

**Max Retry**: 2 次

---

### Phase 4: COMMIT

**Gate Check**: `phase-gate --from REVIEW --to COMMIT`
- ✅ 代码审查完成
- ✅ 无阻断性问题（"❌ Must Fix" 为空）

**执行**: 调用 `/commit` 逻辑
- 分析 git diff 生成 Conventional Commits 消息
- 用户确认后执行 `git commit`

**Max Retry**: 1 次（提交失败通常是环境问题，不应反复重试）

---

### Phase 5: DONE

**Gate Check**: `phase-gate --from COMMIT --to DONE`
- ✅ 改动已提交（`git log -1` 显示新提交）

**执行**:
- 更新 `task-progress.md`（标记完成）
- 同步关联任务状态（`/sync-plans` 逻辑）
- 生成交付报告

---

### Phase 6: CONTEXT_CLEANUP（自动执行，无需用户介入）

DONE 状态达成后，执行上下文清洗，防止任务间上下文污染：

**归档任务产物**（移动，不删除，保留复盘能力）：

```
.agent/plans/T-xxx/plan_summary.json      → .agent/archive/T-xxx/plan_summary.json
.agent/plans/T-xxx/execution_report.json  → .agent/archive/T-xxx/execution_report.json
.agent/plans/T-xxx/review_verdict.json    → .agent/archive/T-xxx/review_verdict.json
```

**保留**（不归档，后续任务仍需访问）：
- `task-progress.md`（任务状态全局记录）
- `context-manifest.json`（本次上下文分配记录，供 entropy-scanner 参考）

**清洗完成标志**：创建 `.agent/archive/T-xxx/cleanup.marker`，内容为完成时间戳。

> 若 `.agent/archive/` 目录不存在，先创建再归档。
> 若任务产物文件不存在（如跳过了某阶段），跳过对应归档步骤，不报错。

**状态流转**：`CONTEXT_CLEANUP` → `ENTROPY_SCAN`

---

### Phase 7: ENTROPY_SCAN（自动执行）

CONTEXT_CLEANUP 完成后，调用 `entropy-scanner` sub-agent 做 L0 + L1 扫描：

- **L0**：自动修复 context-index.json 偏差（已删模块条目、orphan_plans）
- **L1**：标记 stale_refs 和 missing_refs（不修复内容，只标记状态）

输出 `.agent/entropy-report.json`，包含本次健康度评分。

**状态流转**：`ENTROPY_SCAN` → `KNOWLEDGE_LINT`

---

### Phase 8: KNOWLEDGE_LINT（自动执行）

ENTROPY_SCAN 完成后，执行轻量 knowledge lint，刷新知识结构健康度：

**执行命令**：

```bash
node .agent/skills/knowledge-lint/scripts/index.js
```

**输出**：

- `.agent/metrics/knowledge-health.json`

**检查范围**：

- Markdown 断链
- 失效锚点
- 关键知识目录缺 README
- plan 生命周期异常
- `docs/architecture.md` 与仓库真实结构的引用失配

**执行策略**：

- 仅做确定性检查
- 不自动重写大段文档
- 若发现问题，记录到 `knowledge-health.json`
- 默认不阻断 `CLEAN`，但应在交付报告中提示高优先级问题

**状态流转**：`KNOWLEDGE_LINT` → `DOC_GARDENING`

---

### Phase 9: DOC_GARDENING（自动执行，建议生成）

KNOWLEDGE_LINT 完成后，生成低风险知识整理建议，供 `/briefing` 与后续维护消费：

**执行命令**：

```bash
node .agent/skills/doc-gardening/scripts/index.js
```

**输出**：

- `.agent/metrics/doc-gardening-report.json`

**执行策略**：

- 只生成建议，不自动重写大段文档
- 优先输出 quick wins 与需要人工判断的结构同步项
- 默认不阻断 `CLEAN`
- 若存在 `P0` 项，应在交付报告中明确提示

**状态流转**：`DOC_GARDENING` → `PUBLISH_DOCS`

---

### Phase 10: PUBLISH_DOCS（可选执行）

DOC_GARDENING 完成后，判断本次交付是否影响开发者可读文档：

- 新增或修改对外能力、模块边界、架构决策、开发命令、部署方式
- `.agent/references/` 已由 `/scan-project` 或 `/update-refs` 刷新，且需要同步到 `docs/`
- 用户明确要求发布 PRD、架构说明、模块说明或开发手册

若命中，执行 `/publish-docs` 或 `/publish-docs --architecture`。若未命中，记录“无需发布开发者文档”并继续。

**执行策略**：

- 只发布当前任务相关范围，避免全量重写
- 发布前列出来源文件、目标文件和不发布范围
- 发布后执行 `/publish-docs` 中的链接、脱敏和 `git diff --check` 校验
- 默认不阻断 `CLEAN`，但若发现 secrets、`.agent/` 路径泄漏或文档事实与代码不一致，必须修复后继续

**状态流转**：`PUBLISH_DOCS` → `CLEAN`（最终状态）

---

## 传统执行步骤（兼容旧版，逐步迁移到状态机模式）

### 第一步：加载任务上下文

读取 `.agent/plans/task-progress.md`，定位指定任务 ID：
- 确认任务描述和验收标准
- 检查是否有未完成的依赖任务（若有，提示用户确认是否继续）

### 第二步：代码审查（可跳过）

除非指定 `--no-review`，否则自动触发代码审查流程：

```bash
git diff HEAD    # 审查所有未提交改动
git diff --staged  # 若已有暂存区，优先审查暂存内容
```

重点检查：
- 是否满足任务验收标准
- 是否符合 `.agent/rules/code-standards.md`
- 是否有遗漏的边界处理或测试

若发现问题，列出后询问用户：**修复后继续，还是先交付再开新任务跟进？**

### 第三步：提交代码

调用 `/commit` 工作流：
- AI 分析改动，生成 Conventional Commits 格式提交信息
- 展示给用户确认后执行 `git commit`
- 遵守 `.agent/rules/commit-standards.md`（禁止 AI 署名）

### 第四步：标记任务完成

调用 `/done <task-id>` 逻辑：
- 路线图 `[ ]` → `[x]`
- 从活跃任务表移除
- 追加到"最近完成"
- 重新计算整体进度百分比

### 第五步：同步关联任务

检查 `.agent/plans/task-progress.md` 中是否有其他任务依赖已完成的任务：
- 若有，将其状态从"阻塞"更新为"可开始"
- 若有并行任务受影响，提示用户

### 第六步：交付报告

输出简报：

```
🚢 交付完成：T-001（实现 JWT token 生成与验证）

  ✅ 代码已审查
  ✅ 提交：abc1234 feat(auth): 实现 JWT token 生成与验证
  ✅ 任务已标记完成
  📊 整体进度：72% → 78%

  🔓 已解锁任务：T-007（实现登录接口 /auth/login）
  📌 推荐下一步：/start-task T-007
```

---

## 💡 使用场景

| 场景 | 命令 |
|------|------|
| 正常完成一个任务 | `/ship T-001` |
| 快速提交，跳过审查 | `/ship T-001 --no-review` |
| 一次性交付多个小任务 | `/ship T-001 T-002 T-003` |
| 只想提交，不更新计划 | `/commit`（直接用提交工作流）|
