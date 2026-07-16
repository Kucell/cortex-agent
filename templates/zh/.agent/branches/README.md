# 分支命名空间

当多个 clone 或 worktree 共享同一份 `.agent` 时，本目录可选用于存放分支级运行状态。

## 默认状态

该能力默认不启用。这些文件不会自动重定向现有 plans、missions、handoffs 或 incidents。项目必须明确选择启用，并只调整需要使用分支级状态的工作流。

## 目录结构

```text
.agent/branches/
  <branch-slug>/
    plans/
    missions/
    handoffs/
    incidents/
```

辅助脚本把 `%` 编码为 `%25`，把 `/` 编码为 `%2F`，因此 slug 是无损且防碰撞的。例如 `feature/search` 变为 `feature%2Fsearch`；字面分支名 `feature%2Fsearch` 则变为 `feature%252Fsearch`。

## 命令

```bash
bash .agent/scripts/agent-branch-helper.sh branch-name
bash .agent/scripts/agent-branch-helper.sh branch-slug
bash .agent/scripts/agent-branch-helper.sh namespace
bash .agent/scripts/agent-branch-helper.sh ensure
bash .agent/scripts/agent-branch-helper.sh ensure-current plans
bash .agent/scripts/agent-branch-helper.sh relpath plans
bash .agent/scripts/agent-branch-helper.sh status
```

`branch-name`、`branch-slug`、`namespace`、`relpath` 和 `status` 不写入文件。`ensure` 创建全部四个受支持目录，`ensure-current` 创建其中一个。目录参数只允许 `plans`、`missions`、`handoffs` 和 `incidents`。

脚本默认从自身位置推导 Agent 根目录。只有共享 Agent 目录位于其他位置时才设置 `AGENT_ROOT`：

```bash
AGENT_ROOT=/path/to/shared/.agent \
  bash .agent/scripts/agent-branch-helper.sh namespace
```

脚本从调用者当前 worktree 探测 Git 仓库，因此即使脚本由符号链接共享，也会按每个 worktree 当前检出的分支路由。detached HEAD 会在创建任何命名空间目录前被拒绝。

## 边界

不要隔离 `rules/`、`workflows/`、`skills/`、`references/`、`plugins/`、`config/` 或 `.agent/plans/proposals/`。分支命名空间不替代 worktree 协调、锁、handoff 元数据、提交或合并验证。

参见 [`../rules/branch-namespace.md`](../rules/branch-namespace.md) 和 [`../skills/branch-namespace/SKILL.md`](../skills/branch-namespace/SKILL.md)。
