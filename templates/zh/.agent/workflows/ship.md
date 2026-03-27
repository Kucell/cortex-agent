---
name: ship
description: 任务完成后的一键收尾：代码审查 → 提交 → 标记完成 → 同步计划。将 /code-review + /commit + /done + /sync-plans 串联为单一流程。Phase 1: 增加状态机和 max_retry 限制。
---

# 任务交付工作流 (/ship)

当你完成了某个任务的编码，执行此流程完成交付闭环。

## Phase 1 增强：状态机 + 重试控制

**状态流转**：`PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE`

**关键特性**：
- ✅ **Phase Gate 检查**：每个转换有硬性前置条件
- ✅ **Max Retry 限制**：每个阶段最多重试 2 次（来自 `reasoning-config.yml`）
- ✅ **Auto Rollback**：失败时自动回滚到上一稳定状态
- ✅ **成本可控**：基于 `cost_mode` 选择模型（balanced 模式默认）

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
