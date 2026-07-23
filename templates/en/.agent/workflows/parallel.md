---
name: parallel
description: Schedule parallel tasks by analyzing dependencies and write scopes, selecting shared, locked, worktree, or serial isolation, dispatching sub-agents in batches, and closing results consistently.
---

# 并行任务调度工作流 (/parallel)

> **简化用法**：`/start-task T-001 T-002 T-003`（多任务 ID 空格分隔）会根据 `routing-defaults.yml` 自动并行派发，无需单独调用此 workflow。
> 仅在需要**精细控制并行批次和依赖关系**时使用此完整 workflow。

当有多个互不依赖的任务需要同时推进时，使用此工作流最大化执行效率。

## 使用方式

```
/parallel T-001 T-002 T-003
/parallel --batch           （自动从 task-progress.md 选取所有可并行任务）
/parallel T-001 T-002 --dry-run  （只展示调度计划，不执行）
/parallel T-001 T-002 --isolation auto|shared|worktree
```

## 核心原则

- **互不依赖**：同一批次内的任务不能相互依赖
- **上下文隔离**：每个 sub-agent 只拿到自己需要的上下文
- **幂等收尾**：任意一个任务失败不影响其他任务结果
- **规则优先**：调度前读取 `.agent/rules/task-decomposition.md`，按其中的并行判断规则决定批次
- **Isolation preflight**: Default to `--isolation auto`; resolve every batch to a `shared`, `locked`, or `worktree` carrier before dispatch
- **运行可观测**：若 Management API 存在，调度、子代理调用、完成/失败都必须写入 Run journal

---

## 执行步骤

### 第一步：依赖分析

调用 `planner` sub-agent 分析指定任务的依赖关系：

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
  reason: "Why this isolation level was selected"
  tasks:
    - task_id: T-001
      access: read | write
      owned_files: ["src/auth/**"]
      branch: "agent/T-001-auth" # worktree mode only
```

Resolve in this order:

1. Tasks edit the same file, public contract, migration, or shared type → `serial`. Do not use worktrees to hide a logical conflict; return to `/plan` and split the work again.
2. Every task is read-only → `shared`.
3. Write scopes are explicit and disjoint, with no isolated dev server, environment, or runtime-state requirement → `locked`; acquire task/file locks before dispatch.
4. Two or more independent write tasks need true parallelism, isolated runtime state, or cannot be safely constrained in one working directory → `worktree`.

Explicit mode constraints:

- `--isolation shared` accepts read-only batches only; fail closed on writes and recommend `auto`.
- `--isolation worktree` must still check shared contracts; overlapping writes resolve to `serial`, never forced parallelism.
- `--dry-run` emits dependency batches and `execution_isolation` only; it creates no queue, lock, branch, or worktree.

When the result is `worktree`, automatically enter `/worktree plan <task-ids>` to produce branch, worktree path, owner, and file-scope assignments. `/parallel` must not run `git worktree add` directly; `/worktree create` owns creation after the plan is confirmed.

### 第三步：为每个任务选择 sub-agent

根据任务类型自动匹配：

| 任务类型 | 分配给 |
|---------|--------|
| 功能实现、Bug 修复 | `implementer` |
| 技术调研、方案评估 | `researcher` |
| 代码审查、质量检查 | `code-reviewer` |
| 文档更新、注释补充 | `documenter` |
| 测试编写 | `implementer`（含测试职责）|

### 第四步：准备上下文包

为每个 sub-agent 准备独立的上下文包（避免信息污染）：

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

上下文包必须包含该任务的验收标准、可写范围、不可写范围和冲突检查点。

### 第五步：并行派发

**同时**调用批次内所有 sub-agent（主代理不等待中间结果）：

```
→ [implementer] 执行 T-001：实现 JWT token
→ [researcher]  执行 T-003：调研限流方案
（等待两者都完成）
```

派发每个 sub-agent 前，为对应任务写入 Run journal：

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

**跨平台说明：**

| 平台 | 并行方式 |
|------|---------|
| Claude Code | 使用 `Task` 工具真正并行调度，天然支持 |
| Cursor | 在同一上下文中顺序调用，但每个 sub-agent 上下文独立隔离 |
| 其他平台 | 顺序执行，但保持上下文隔离，结果等效 |

### 第六步：收集结果与冲突检测

所有 sub-agent 完成后，主代理：

1. 收集每个 sub-agent 的输出报告
2. 检查是否有文件冲突（多个 agent 修改了同一文件）
3. 若有冲突：暂停并提示用户手动决策
4. 若无冲突：合并结果
5. 对每个任务追加 `completed`、`failed` 或 `blocked` Run event，并在批次完成后更新 `R-parallel-<batch-id>`。

### 第七步：启动下一批次

批次 1 完成后，自动进入批次 2，重复第四步至第六步。

### 第八步：批量更新进度

所有批次完成后，统一调用 `/done` 逻辑：

- 路线图批量 `[ ]→[x]`
- 一次性更新整体进度百分比
- 解锁新的可执行任务

输出最终报告：

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

## 💡 最佳实践

| 场景 | 建议 |
|------|------|
| 功能模块互相独立 | `implementer × N` 全部并行 |
| 实现前需要调研 | `researcher` 先行，结果出来后再并行 `implementer` |
| 代码写完要审查和写文档 | `code-reviewer` + `documenter` 并行 |
| 任务太大难以拆分 | 先 `/plan` 拆解，再 `/parallel` 执行 |
| 不确定能否并行 | 加 `--dry-run` 先看调度计划 |
| Read-only tasks | `--isolation shared` |
| Disjoint directory writes | Keep the default `auto`; it normally resolves to `locked` |
| Independent implementations needing true parallelism | `auto` resolves to `worktree` and enters `/worktree plan` |
| Shared contract or same-file edits | Run serially and return to `/plan` |

## Queue Runtime Writes

- After dependency decomposition, `/parallel` creates the batch with `queues upsert --queue-id Q-<batch-id> --gate parallel --concurrency-limit <n>`.
- Before dispatch, call `queues item --queue-id Q-<batch-id> --gate parallel --task-id <task-id> --state running --run-id R-<task-id> --agent-id <agent-id>`.
- Completion, blocking, or validation failure updates the item to `done` or `blocked` and writes the matching Run checkpoint.
- Dashboard may query the Queue but never update its items.
