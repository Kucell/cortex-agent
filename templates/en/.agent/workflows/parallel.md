---
name: parallel
description: "并行任务调度工作流。分析依赖与写入范围，自动选择 shared、locked、worktree 或 serial 隔离，再分批派发 sub-agent 并统一收口。"
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules: []
linked_workflows: []
owner: Kucell
last_verified: 2026-08-06
status: stable
---

<!-- EN translation pending: structural English skeleton; detailed Chinese body below is the source of truth. TODO: translate the dependency-analysis prompt, isolation-decision rules, dispatch/Run-journal details, the downstream independent verification section, and the queue runtime writes fully into English. -->

# Parallel Task Scheduling Workflow (/parallel)

> **Simplified usage**: `/start-task T-001 T-002 T-003` (space-separated task IDs) dispatches automatically in parallel based on `routing-defaults.yml`; you do not need this full workflow.
> Use this full workflow only when you need **fine-grained control over parallel batches and dependencies**.

Use this workflow to maximize throughput when multiple independent tasks can advance at the same time.

## Usage

```
/parallel T-001 T-002 T-003
/parallel --batch           （auto-select all parallelizable tasks from task-progress.md）
/parallel T-001 T-002 --dry-run  （show the dispatch plan only, do not execute）
/parallel T-001 T-002 --isolation auto|shared|worktree
```

## Core Principles

- **Mutual independence**: tasks in the same batch must not depend on each other
- **Context isolation**: each sub-agent only receives the context it needs
- **Idempotent wrap-up**: one task failing does not affect the others' results
- **Rules first**: read `.agent/rules/task-decomposition.md` before dispatching; decide batches by its parallel-judgment rules
- **Isolation preflight**: default to `--isolation auto`; before dispatch you must choose a `shared`, `locked`, or `worktree` carrier
- **Runtime observability**: if a Management API exists, dispatch, sub-agent invocation, and completion/failure must be written to the Run journal

---

## Execution Steps

### Step 1: Dependency Analysis

Invoke the `planner` sub-agent to analyze task dependencies:

```
[planner] 请分析以下任务的依赖关系，输出可并行执行的批次：
任务列表：T-001, T-002, T-003, T-004
参考文件：.agent/plans/task-progress.md
拆分规则：.agent/rules/task-decomposition.md
```

planner 返回分批结果，例如：

```

依赖分析完成后记录调度事件：

```bash
cortex-agent runs checkpoint --project . \
  --run-id R-parallel-<batch-id> \
  --kind plan \
  --status running \
  --phase decomposing \
  --type task_decomposed \
  --activity "Parallel dependency analysis completed"
```
批次 1（可立即并行）：T-001, T-003
  - T-001 与 T-003 无共享文件，无依赖关系

批次 2（等批次1完成）：T-002, T-004
  - T-002 依赖 T-001 的输出接口
  - T-004 依赖 T-003 的调研结果
```

### Step 2: Select Execution Isolation

Default to `--isolation auto`. After dependency analysis and before dispatch, emit:

```yaml
execution_isolation:
  requested: auto
  resolved: shared | locked | worktree | serial
  reason: "选择该隔离级别的原因"
  tasks:
    - task_id: T-001
      access: read | write
      owned_files: ["src/auth/**"]
      branch: "agent/T-001-auth" # 仅 worktree 模式
```

Resolve in this order:

1. Multiple tasks modify the same file, public contract, migration, or shared type → `serial`; do not use worktrees to mask a logical conflict; return to `/plan` and re-split.
2. All tasks are read-only → `shared`.
3. Write tasks exist, but write scopes are explicit and disjoint, with no need for an isolated dev server, environment, or runtime state → `locked`; acquire task/file locks before dispatch.
4. Two or more independent write tasks need true parallelism, isolated runtime state, or write scopes that cannot be reliably constrained in one workspace → `worktree`.

Explicit mode constraints:

- `--isolation shared` accepts read-only batches only; fail closed on writes and recommend `auto`.
- `--isolation worktree` must still check shared contracts; overlapping writes resolve to `serial`, never forced parallelism.
- `--dry-run` emits dependency batches and `execution_isolation` only; it creates no queue, lock, branch, or worktree.

When the result is `worktree`, automatically enter `/worktree plan <task-ids>` to produce branch, worktree path, owner, and file-scope assignments. `/parallel` must not run `git worktree add` directly; `/worktree create` owns creation after the plan is confirmed.

### Step 3: Select a sub-agent for each task

Automatically match by task type:

| 任务类型 | 分配给 |
|---------|--------|
| 功能实现、Bug 修复 | `implementer` |
| 技术调研、方案评估 | `researcher` |
| 代码审查、质量检查 | `code-reviewer` |
| 文档更新、注释补充 | `documenter` |
| 测试编写 | `implementer`（含测试职责）|

### Step 4: Prepare context packages

Prepare an isolated context package per sub-agent (avoid information pollution):

```
[T-001 上下文包]
任务 ID: T-001
描述: 实现 JWT token 生成与验证
验收标准:
  - POST /auth/token 返回有效 JWT
  - 单元测试全部通过
相关文件: src/auth/, src/middleware/
约束: 不修改 src/user/ 下的任何文件
```

The context package must include the task's acceptance criteria, writable scope, non-writable scope, and conflict checkpoints.

### Step 5: Parallel dispatch

**Invoke all sub-agents in the batch simultaneously** (the main agent does not wait for intermediate results):

```
→ [implementer] 执行 T-001：实现 JWT token
→ [researcher]  执行 T-003：调研限流方案
（等待两者都完成）
```

Before dispatching each sub-agent, write a Run journal entry for the task:

```bash
cortex-agent runs checkpoint --project . \
  --run-id R-<task-id> \
  --task-id <task-id> \
  --agent-id <agent-id> \
  --role <role> \
  --kind implement \
  --status running \
  --phase invoking_agent \
  --type agent_invoked \
  --activity "Invoking sub-agent for parallel task" \
  --message "Sub-agent dispatched"
```

**Cross-platform notes:**

| 平台 | 并行方式 |
|------|---------|
| Claude Code | 使用 `Task` 工具真正并行调度，天然支持 |
| Cursor | 在同一上下文中顺序调用，但每个 sub-agent 上下文独立隔离 |
| 其他平台 | 顺序执行，但保持上下文隔离，结果等效 |

### Step 6: Collect results and detect conflicts

After all sub-agents complete, the main agent:

1. Collect each sub-agent's output report
2. Check for file conflicts (multiple agents modified the same file)
3. If a conflict exists: pause and prompt the user for a manual decision
4. If no conflict: merge the results
5. Append `completed`, `failed`, or `blocked` Run events per task, and update `R-parallel-<batch-id>` after the batch completes.

### Downstream Independent Verification

当批次内存在跨 agent 依赖（下游任务采信上游任务的产出）时，下游 agent 采信上游产出前必须独立验证，禁止链式信任：

1. **核对上游 command-log 的 exit code**：上游报告成功的命令必须在 command-log 中有对应的 exit code 0 记录，不能只看上游的总结文字。
2. **核对 diff 或产物文件**：采信前检查上游实际写入的 diff 或产物文件（`git diff`、`git show`、产物内容抽样），确认产出真实存在且与声称一致。
3. **验证后再依赖**：下游任务基于上游产出做假设时，先跑一次最小可验证动作（读取产物、运行针对性命令），通过后才把上游结论当作事实输入。
4. **收口交叉复核**：批次收口（合并结果、更新 Run journal）时，对跨 agent 传递的结论做交叉复核；发现问题即回退到出错节点修复，而不是在错误基础上继续放大。
5. **记录验证证据**：独立验证的动作与结果写入任务报告或 command-log，供后续 `/ship` REVIEW 与 mission VALIDATE 追溯。

> 参见 `.agent/rules/judgment-risks.md`（Cascade Failure 风险与针对性检查）。

### Step 7: Start the next batch

After batch 1 completes, automatically enter batch 2, repeating Steps 4–6.

### Step 8: Batch progress updates

After all batches complete, uniformly call the `/done` logic:

- Route-map batch `[ ]→[x]`
- Update the overall progress percentage in one shot
- Unlock new executable tasks

Final report:

```
🚀 并行执行完成

批次 1（并行）：
  ✅ T-001  JWT token 实现        [implementer] 12分钟
  ✅ T-003  限流方案调研          [researcher]  8分钟
  节省时间：约 8 分钟（对比串行）

批次 2（并行）：
  ✅ T-002  登录接口实现          [implementer] 15分钟
  ✅ T-004  文档同步              [documenter]  5分钟

📊 整体进度：72% → 88%
🔓 新解锁任务：T-005（集成测试）

📌 推荐下一步：/start-task T-005
```

---

## 💡 Best Practices

| 场景 | 建议 |
|------|------|
| 功能模块互相独立 | `implementer × N` 全部并行 |
| 实现前需要调研 | `researcher` 先行，结果出来后再并行 `implementer` |
| 代码写完要审查和写文档 | `code-reviewer` + `documenter` 并行 |
| 任务太大难以拆分 | 先 `/plan` 拆解，再 `/parallel` 执行 |
| 不确定能否并行 | 加 `--dry-run` 先看调度计划 |
| 只读任务 | `--isolation shared` |
| 独立目录写入 | 默认 `auto`，通常解析为 `locked` |
| 多个独立实现且需要真实并行 | 默认 `auto`，解析为 `worktree` 后自动进入 `/worktree plan` |
| 修改共享契约或同一文件 | 串行执行，先 `/plan` 重新拆分 |

## Queue Runtime Writes

- 依赖拆分完成后，由 `/parallel` 创建批次：`queues upsert --queue-id Q-<batch-id> --gate parallel --concurrency-limit <n>`。
- 派发前写入：`queues item --queue-id Q-<batch-id> --gate parallel --task-id <task-id> --state running --run-id R-<task-id> --agent-id <agent-id>`。
- 完成、阻塞或验证失败时更新对应 item 为 `done` 或 `blocked`，并同时写 Run checkpoint。
- Dashboard 只能查询 Queue，不得代替 `/parallel` 更新 item。
