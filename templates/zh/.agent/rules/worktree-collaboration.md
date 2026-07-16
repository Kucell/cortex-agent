# Worktree 协同规则

当多个 Agent 需要并行推进同一个大项目时，可以使用 Git worktree 隔离工作区。worktree 只负责文件系统隔离；任务状态、handoff、锁和合并顺序仍由 `.agent/` 协调。

## 1. 适用场景

适合使用 worktree：

- 多个任务修改不同模块或不同目录。
- 一个 mission 需要多个实现分支并行探索。
- 需要让不同 Agent 在独立工作区运行测试、启动服务或保留本地状态。
- 需要降低并行开发时同一工作区的文件冲突。

不适合使用 worktree：

- 任务共享同一核心文件、公共类型、数据库迁移或接口契约。
- 架构方案尚未确认。
- 需要独占设备、远程机器、许可证或数据库迁移窗口。
- 只是单文件小修，不值得创建新工作区。

## 2. Worktree Identity

每个 worktree 必须有可恢复身份：

- `worktree_path`：绝对路径或项目相对路径
- `branch`：对应 Git 分支
- `base_branch`：从哪个分支创建
- `base_commit`：创建时的基线提交
- `task_id` / `mission_id`
- `agent_id` 与角色
- `owned_files`：该 worktree 允许写入的文件或目录范围

这些信息必须记录到 Agent Registry 或 handoff JSON 中。

## 3. 共享 .agent

多个 worktree 必须共享同一份 `.agent` 状态目录，避免 task-progress、locks、handoffs、artifacts、dashboard 分裂。

推荐方式是在子 worktree 中使用符号链接：

```bash
rm -rf <child-worktree>/.agent
ln -s <primary-worktree>/.agent <child-worktree>/.agent
```

说明：

- 不推荐硬链接目录；多数文件系统不支持目录硬链接，且容易破坏目录一致性。
- 不要在每个 worktree 复制一份 `.agent` 后各自写入。
- 所有 worktree 应共享同一套 `.agent/locks/`、`.agent/handoffs/`、`.agent/artifacts/` 和 `.agent/metrics/agent-dashboard.html`。
- 如果确实需要隔离实验状态，必须在 handoff 或 coordination report 中明确说明该 worktree 不参与共享状态。

## 4. 锁与写入边界

- 开始写代码前必须获取 `task:<id>` 或 `file:<path>` Progress Lock。
- 不同 worktree 仍然可能修改同一文件；worktree 不能替代锁。
- `owned_files` 之外的改动必须先在 handoff 或 coordination report 中说明原因。
- 如果锁冲突，停止写入并交给 coordinator 输出恢复方案。

## 5. Handoff 要求

跨 worktree handoff 必须记录：

- 来源 worktree 和目标 worktree
- 当前分支、`HEAD` commit、base commit
- 未提交改动摘要：`git status --short`
- 已提交但未合并的 commit 列表
- 已持有或应释放的 lock scope
- Artifact Bus state 和相关验证结果
- 下一步应该在原 worktree 继续，还是切到目标 worktree 继续

handoff 不复制大段 diff；使用路径、commit 和 artifact 引用。

## 6. 状态同步

多 worktree 协同必须遵循：

1. 每个 worktree 的任务状态写入 `.agent/artifacts/<task-id>/` 或 mission milestone。
2. `/handoff` 用于跨 Agent 或跨 worktree 转移上下文。
3. `/sync-plans` 只同步任务计划状态，不代表代码已经合并。
4. 合并前必须检查 registry、locks、handoff 和 git 状态是否一致。
5. 合并后运行 `/update-refs`；若影响开发者文档，运行 `/publish-docs`。

## 7. 及时提交与主线验证

- 每个 worktree 完成一个可验证任务后，应立即运行 `/ship <task-id>` 或 `/commit`，不要长期保留大批未提交改动。
- worktree 内的验证只能证明该分支局部可用；合并后必须在目标主线 worktree 再跑一次关键验证。
- 合并前，源 worktree 应满足：工作区干净、提交信息清晰、验证命令已记录、handoff/Artifact Bus 已更新。
- 合并后，目标 worktree 应满足：功能验证通过、`git diff --check` 通过、任务计划已同步、锁已释放或转移。
- 如果合并后验证失败，优先在合并目标 worktree 修复；若需要回到源 worktree，必须创建 handoff 说明失败证据和恢复路径。

## 8. 合并顺序

推荐合并顺序：

1. 契约、类型、公共接口
2. 后端或核心逻辑
3. UI / 集成层
4. 测试、验证和文档

如果多个 worktree 都修改同一契约，必须先暂停实现任务，回到 `/arch-design` 或 `/plan` 重新拆分。
