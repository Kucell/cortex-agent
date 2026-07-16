---
name: branch-namespace
description: 当多个 clone 或 worktree 共享同一份 .agent 时，可选地将分支本地 plans、missions、handoffs 和 incidents 路由到防碰撞命名空间。
---

# 分支命名空间

## 目标

只有项目明确启用分支命名空间后才使用本 skill。它解析分支本地存储路径，不改变 Git worktree、锁、handoff 或合并语义。

## 前置条件

1. 读取 `.agent/rules/branch-namespace.md` 和 `.agent/branches/README.md`。
2. 确认项目已经选择启用。文件存在本身不代表启用。
3. 即使 `.agent` 通过符号链接共享，也要从目标 Git worktree 运行命令。
4. 写入前运行 `status`。如果 HEAD detached，停止并要求检出具名分支。

## 解析目标路径

```bash
bash .agent/scripts/agent-branch-helper.sh status
TARGET_DIR=$(bash .agent/scripts/agent-branch-helper.sh ensure-current plans)
```

只能把 `plans` 替换为 `missions`、`handoffs` 或 `incidents`。将新的分支本地产物写入 `TARGET_DIR`，并保留项目已有的命名约定。

不应创建目录时，使用只读探测：

```bash
bash .agent/scripts/agent-branch-helper.sh namespace
bash .agent/scripts/agent-branch-helper.sh relpath handoffs
```

## 共享 Agent 根目录

辅助脚本通常从自身路径推导 `.agent`。如果脚本不在共享 Agent 根目录内，请显式提供根目录：

```bash
AGENT_ROOT=/path/to/shared/.agent \
  bash path/to/agent-branch-helper.sh ensure-current missions
```

不得把该机器路径写死到提交的规则、skill 或工作流中。

## 防错约束

- 不要把 proposals 或共享 rules、workflows、skills、references、plugins、config 路由到分支命名空间。
- 不要手工构造 slug 或把 `/` 替换为 `-`；使用辅助脚本输出。
- 不要接受任意目录名。
- 未经项目合并策略和明确任务范围授权，不要复制、提升、归档或删除其他分支的内容。
- 采用此存储约定时，不要修改现有 worktree 或 handoff 协调规则。

## 完成报告

报告分支名、编码后的 slug、目标路径、写入文件和已执行验证。除非用户另行要求，否则不要提交。
