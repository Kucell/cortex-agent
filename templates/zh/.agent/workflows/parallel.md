---
name: parallel
description: 并行任务调度工作流。分析依赖与写入范围，自动选择 shared、locked、worktree 或 serial 隔离，再分批派发 sub-agent 并统一收口。
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
- **隔离预检**：默认 `--isolation auto`，派发前必须选择 `shared`、`locked` 或 `worktree` 执行载体
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

### 第二步：选择执行隔离

默认使用 `--isolation auto`。依赖分析后、派发前，必须输出：

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

判定顺序：

1. 多个任务修改同一文件、公共契约、迁移或共享类型 → `serial`，禁止用 worktree 掩盖逻辑冲突，返回 `/plan` 重新拆分。
2. 批次全部只读 → `shared`。
3. 有写任务，但写入范围明确、互不重叠，且不需要独立 dev server、环境变量或运行状态 → `locked`，派发前获取 task/file lock。
4. 有两个以上独立写任务，且需要真正并行、独立运行状态，或写入范围无法可靠约束在同一工作区 → `worktree`。

显式模式约束：

- `--isolation shared` 只允许全只读批次；发现写任务时失败关闭并建议 `auto`。
- `--isolation worktree` 仍须检查共享契约；存在重叠写入时改为 `serial`，不得强制并行。
- `--dry-run` 只输出依赖批次和 `execution_isolation`，不创建 queue、lock、branch 或 worktree。

当解析为 `worktree` 时，自动进入 `/worktree plan <task-ids>`，生成 branch、worktree path、owner 和文件范围计划。`/parallel` 不直接执行 `git worktree add`；计划确认后由 `/worktree create` 创建。

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
| 只读任务 | `--isolation shared` |
| 独立目录写入 | 默认 `auto`，通常解析为 `locked` |
| 多个独立实现且需要真实并行 | 默认 `auto`，解析为 `worktree` 后自动进入 `/worktree plan` |
| 修改共享契约或同一文件 | 串行执行，先 `/plan` 重新拆分 |

## Queue 运行态写入

- 依赖拆分完成后，由 `/parallel` 创建批次：`queues upsert --queue-id Q-<batch-id> --gate parallel --concurrency-limit <n>`。
- 派发前写入：`queues item --queue-id Q-<batch-id> --gate parallel --task-id <task-id> --state running --run-id R-<task-id> --agent-id <agent-id>`。
- 完成、阻塞或验证失败时更新对应 item 为 `done` 或 `blocked`，并同时写 Run checkpoint。
- Dashboard 只能查询 Queue，不得代替 `/parallel` 更新 item。
