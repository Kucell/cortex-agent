---
name: worktree
description: 使用 Git worktree 隔离多个 Agent 的并行开发，并通过 registry、locks、handoff 和 artifacts 做状态协调。
---

# Worktree 协同工作流 (/worktree)

## 目标

用 Git worktree 为多个 Agent 提供独立工作区，同时保持任务状态、锁、交接和合并顺序可恢复。

`/worktree` 不替代 `/parallel`、`/mission`、`/handoff` 或 `/ship`。它负责在这些工作流之间增加工作区隔离和状态同步。

## 使用方式

```text
/worktree plan T-001 T-002
/worktree create T-001 --branch agent/T-001-auth
/worktree status
/worktree handoff T-001 --to ../project-T-001
/worktree sync
/worktree commit T-001
/worktree merge T-001
/worktree validate T-001
```

## 核心规则

- 先读取 `.agent/rules/worktree-collaboration.md`。
- 每个 worktree 对应一个任务、一个分支、一个 Agent owner。
- 写入前必须获取 Progress Lock。
- handoff 必须记录 worktree path、branch、base commit、HEAD commit 和 git status。
- worktree 内完成一个可验证任务后必须及时 `/ship` 或 `/commit`。
- 合并前必须确认 registry、locks、artifacts、handoff 和 git 状态一致。
- 合并后必须在目标主线 worktree 重新验证功能。
- 若 Management API 存在，worktree 创建、锁获取、提交、合并、验证都必须写入 Run journal。

## PLAN

在创建 worktree 前：

1. 读取 `.agent/rules/task-decomposition.md` 和 `.agent/rules/worktree-collaboration.md`。
2. 读取 `.agent/plans/task-progress.md` 或 mission plan。
3. 判断哪些任务适合 worktree 并行。
4. 输出计划：

```text
Worktree 计划：
  T-001 → ../project-T-001 → branch agent/T-001-auth → implementer
  T-002 → ../project-T-002 → branch agent/T-002-ui → implementer

串行任务：
  T-000 contract baseline，必须先完成

共享风险：
  src/types/api.ts，禁止多个 worktree 同时修改
```

## CREATE

创建 worktree：

```bash
git worktree add ../<repo>-<task-id> -b agent/<task-id>-<slug>
```

然后在新 worktree 中：

1. 将子 worktree 的 `.agent` 链接到主 worktree 的同一份 `.agent`：

```bash
rm -rf ../<repo>-<task-id>/.agent
ln -s "$(pwd)/.agent" ../<repo>-<task-id>/.agent
```

2. 在子 worktree 中确认 `.agent` 指向共享目录：

```bash
test -L .agent && readlink .agent
```

3. 记录 `base_branch`、`base_commit`、`branch`、`worktree_path`、`agent_state_path`。
4. 在 registry 中 check-in：

```bash
node .agent/registry/scripts/agent-registry.js check-in \
  --agent-id <agent-id> \
  --role <role> \
  --model <model> \
  --task-id <task-id> \
  --owned-files <paths>
```

5. 获取任务锁：

```bash
node .agent/locks/scripts/progress-lock.js acquire \
  --scope task:<task-id> \
  --agent-id <agent-id> \
  --ttl-seconds 3600 \
  --metadata-json '{"worktree_path":"../repo-T-001","branch":"agent/T-001-auth","agent_state_path":"../repo/.agent"}'
```

6. 记录 worktree 创建和锁获取事件：

```bash
node .agent/skills/management-api/scripts/index.js runs checkpoint \
  --run-id R-<task-id> \
  --task-id <task-id> \
  --agent-id <agent-id> \
  --role <role> \
  --kind implement \
  --status running \
  --phase acquiring_lock \
  --type lock_acquired \
  --worktree-path ../<repo>-<task-id> \
  --branch agent/<task-id>-<slug> \
  --activity "Worktree created and task lock acquired" \
  --message "Task lock acquired for worktree"
```

## STATUS

汇总所有 worktree 状态：

1. `git worktree list --porcelain`
2. 每个 worktree 的 `git status --short --branch`
3. registry active agents
4. held locks
5. latest Artifact Bus state
6. open handoffs

必须输出状态机结果，而不是固定建议：

| `worktree_state` | 判定条件 | `next_action` |
| :--- | :--- | :--- |
| `idle` | 没有非主 worktree、没有 active lock、没有 active agent | `/worktree plan <tasks>` |
| `planned` | 已有任务拆分或计划，但尚未创建 worktree | `/worktree create <task-id>` |
| `worktree_created` | worktree 已创建但无写入和无 lock | 获取 task/file lock 后 `/start-task` |
| `in_progress` | worktree 有改动、active agent 或 held lock | 达到可验证点后 `/worktree commit <task-id>` |
| `handoff_required` | 存在待接收 handoff 或状态不一致 | `/handoff resume <handoff>` |
| `merge_ready` | 源 worktree 干净且已有提交，验证已记录 | `/worktree merge <task-id>` |
| `merged` | 分支已合并但主线未验证 | `/worktree validate <task-id>` |
| `validation_failed` | 主线验证失败 | 修复或创建 `/handoff` |
| `validated` | 主线验证通过 | `/sync-plans`、`/update-refs` |
| `closed` | 任务已关闭，locks 已释放 | 清理或保留 worktree |

输出 JSON：

```json
{
  "type": "worktree_coordination_report",
  "worktree_state": "idle | planned | worktree_created | in_progress | handoff_required | merge_ready | merged | validation_failed | validated | closed",
  "status": "ready | blocked | merge_ready | validated",
  "worktrees": [],
  "locks": [],
  "handoffs": [],
  "human_summary": "一句话说明当前进度",
  "blocked_reasons": [],
  "next_action": "唯一推荐下一步",
  "next_actions": ["可选后续动作"]
}
```

同时输出一段人类可读摘要，说明为什么给出该 next_action。

## HANDOFF

跨 worktree 交接时，先运行 `/handoff create`，并确保 Markdown 和 JSON payload 包含：

- `source_worktree`
- `target_worktree`
- `branch`
- `base_commit`
- `head_commit`
- `git_status`
- `locks_to_release`
- `locks_to_acquire`
- `artifact_refs`

交接完成后，来源 Agent 应释放不再持有的 lock，目标 Agent 在写入前重新获取 lock。

## SYNC

用于同步状态，不合并代码：

1. 扫描 worktree 列表。
2. 标记 stale registry entries。
3. 清理过期 locks。
4. 校验 handoff JSON。
5. 对比 task-progress / mission state / artifacts。
6. 输出需要人工处理的分歧。

## COMMIT

用于在 worktree 内及时收口一个可验证任务：

1. 确认当前 worktree 对应的 `task_id`、`branch`、`base_commit`。
2. 运行任务级验证命令，并把结果写入 Artifact Bus 或 mission milestone。
3. 执行 `/ship <task-id>`；若只是中间检查点，执行 `/commit`。
   - 验证命令开始/结束时追加 `command_started` / `command_finished`。
   - 验证通过追加 `validation_passed`；失败追加 `validation_failed` 并保持 run `status=running` 或 `failed`（按任务是否还能继续决定）。
4. 提交后记录：

```text
task_id: T-001
worktree_path: ../repo-T-001
branch: agent/T-001-auth
commit: <HEAD>
validation: <commands and exit codes>
```

5. 更新 handoff 或 coordination report，让 coordinator 知道该 worktree 已进入 `merge_ready` 或 `continue`。
6. 更新 Run journal：

```bash
node .agent/skills/management-api/scripts/index.js runs checkpoint \
  --run-id R-<task-id> \
  --type command_finished \
  --phase running_command \
  --message "Worktree commit completed"
```

## MERGE

合并前 gate：

- 源 worktree 工作区干净；如果不干净，先回到 `COMMIT` 或创建 handoff 说明原因。
- 源分支至少有一个清晰提交，且提交来自 `/ship` 或 `/commit`。
- 任务 lock 由当前 Agent 持有，或已经释放/转移。
- `/ship` 已完成或有明确豁免。
- worktree 内验证命令已记录。
- 没有未处理 handoff。
- 已通过只读 diff/status 和必要的项目验证评估冲突风险；如果需要 fetch/rebase，必须在冻结合并候选前完成。

### 资源绑定审批

`/worktree` 是单任务分支合并的 owning workflow。先读取仓库规则、分支保护与任务计划，确定已批准的 integration strategy：`fast-forward`、`squash`、`local-merge` 或 `pr-handoff`。不得自行默认为某一种策略。

策略尚未冻结时，先提出一个明确策略并创建独立 Decision/Waitpoint；其 `resource_ref` 必须包含 proposed strategy、source/target branch 与当前 short SHA，ID 使用 `D-worktree-<task-id>-strategy-<source-short-sha>-<target-short-sha>-<resource-digest8>` 和对应 `WP-` ID。该请求使用 `type=merge`、`action=merge`，Waitpoint owner 为 `/worktree`。用户批准并由 `/worktree` 消费后，才把该策略作为本次候选的冻结输入。

完成必要的同步和冲突处理并固定最终 source/target commit 后，计算完整资源摘要，生成精确资源引用：

```text
git:<repository>#integrate:<source-branch>@<source-head>-><target-branch>@<target-head>#strategy:<integration-strategy>#digest:<resource-digest>
```

用同一个 `resource_ref` 创建 Decision 和 blocking Waitpoint：

```bash
node .agent/skills/management-api/scripts/index.js decisions request \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate worktree \
  --type merge \
  --requested-by worktree-coordinator \
  --prompt "Approve this exact worktree merge?" \
  --action merge \
  --resource-ref "<resource-ref>"

node .agent/skills/management-api/scripts/index.js waitpoints create \
  --waitpoint-id WP-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate worktree \
  --owner-workflow /worktree \
  --reason "Exact commits and integration strategy require user approval" \
  --action merge \
  --resource-ref "<resource-ref>" \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8>
```

创建后停止，向用户显示包含本次资源摘要的 `/approve decision <decision-id>`。Dashboard 只能展示该请求，不能批准。用户解析后，由 `/worktree merge` 重新读取 Decision，确认状态为 `approved`、选项为 `approve`、用户解析证据完整，且 action/resource 与当前 source/target commit 和 integration strategy 完全一致，再消费 Waitpoint：

```bash
node .agent/skills/management-api/scripts/index.js waitpoints release \
  --waitpoint-id WP-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --gate owner \
  --owner-workflow /worktree \
  --decision-id D-worktree-<task-id>-<source-short-sha>-<target-short-sha>-<resource-digest8> \
  --released-by worktree-coordinator \
  --release-note "Approved Decision matches commits, strategy and resource digest"
```

若任一 commit 或 strategy 已变化，旧 Decision 不得复用；使用新的 short SHA/resource digest 创建新 Decision/Waitpoint。阶段级、多来源集成只报告“项目级 Checkpoint 集成路由尚未批准”，不得调用尚不存在的工作流。

准备合并候选时可以运行只读检查：

```bash
git diff --check
```

`git status`、`git diff`、`git diff --check` 和本地日志读取是普通只读检查，不需要 Decision。`git fetch` 会访问远端但不重写工作区，应在执行前明确展示远端和目的，并创建 `external_side_effect` Decision/Waitpoint；rebase 会重写 source commits，必须单独走 `destructive` Decision/Waitpoint。二者都必须在 merge Decision 创建前完成。Waitpoint 释放后不得再 rebase 或改变 source/target HEAD。

执行时只采用资源中已批准的仓库策略：

| Strategy | 执行边界 |
| :--- | :--- |
| `fast-forward` | 使用仓库批准的 fast-forward 命令，并验证 target 正好推进到 approved source。 |
| `squash` | 使用仓库批准的 squash 流程；生成提交时转入 `/commit`，不得隐式提交。 |
| `local-merge` | 使用仓库配置的本地 merge 参数，不硬编码 `--no-ff` 或其他策略。 |
| `pr-handoff` | 不在本地合并；创建 PR/handoff 所需证据，push 和创建 PR 分别遵循外部副作用审批。 |

不得自动 reset、revert、push 或强推。合并前后分别追加 `merge_started` / `merge_completed` Run event；如果冲突或失败，追加 `failed` 或 `blocked`。

## VALIDATE

合并后必须在目标主线 worktree 重新验证：

1. 运行项目关键测试、构建、lint 或用户指定验证命令。
2. 对 UI/设备/跨机器项目，按领域验证 skill 或 validation-contract 收集运行证据。
3. 运行 `git diff --check`。
4. 若验证失败：
   - 记录失败命令和证据
   - 优先在目标主线 worktree 修复
   - 若要回源 worktree 继续，创建 `/handoff`
5. 若验证通过：
   - 标记任务可关闭或已合并
   - 更新 Artifact Bus / mission milestone
   - 将 Run journal 更新为 `status=completed`、`phase=completed`，并追加 `completed` event。

合并并验证通过后：

1. 更新 `/sync-plans`。
2. 运行 `/update-refs`。
3. 必要时运行 `/publish-docs`。
4. check-out registry。
5. 释放 locks。
6. 清理或保留 worktree，按用户确认执行。

## 与其他工作流的协作

- `/plan`：决定任务拆分和 worktree 候选。
- `/parallel`：可选择 worktree 作为并行执行载体。
- `/mission`：每个 milestone 可映射到一个或多个 worktree。
- `/handoff`：跨 worktree 转移上下文的唯一正式入口。
- `/ship`：每个 worktree 的任务收口入口。
- 项目级 Checkpoint、多来源排序集成：相关提案仍待批准；当前只报告待路由状态，不引用或执行不存在的工作流。

## Queue / Session 运行态写入

- `/worktree plan` 使用 `queues upsert --gate worktree` 建立批次；创建 worktree 并取得锁后，使用 `queues item --gate worktree` 写入 `running`、worktree path、agent 和 run。
- `/worktree commit` 仅在验证证据已记录后把 item 更新为 `done`；失败时写 `blocked`，不得删除 item 隐藏失败。
- 长时间持有 worktree 的 owner 可以 `sessions open` 并定期 heartbeat；handoff 或结束时通过 owner/handoff gate pause 或 close。
- 每次 Queue/Session 写入必须与对应 Run checkpoint 和 lock 状态一致。
