# 可选分支命名空间规则

## 状态

分支命名空间是可选框架能力，默认不启用。存在本规则、辅助脚本或 `.agent/branches/` 目录不代表已启用路径路由。

只有项目在本地 Agent 配置中明确记录启用决定，并将相关项目工作流改为通过辅助脚本解析分支级目标路径后，该能力才生效。在此之前，现有扁平路径保持原有语义。

## 隔离内容

启用后，只把分支本地的运行内容路由到：

| 内容 | 目标路径 |
| --- | --- |
| 计划 | `.agent/branches/<branch-slug>/plans/` |
| Mission | `.agent/branches/<branch-slug>/missions/` |
| Handoff | `.agent/branches/<branch-slug>/handoffs/` |
| Incident | `.agent/branches/<branch-slug>/incidents/` |

共享框架资产和长期知识继续保留在原位置，包括 `rules/`、`workflows/`、`skills/`、`references/`、`plugins/`、`config/` 和 `.agent/plans/proposals/`。

## 必须遵守

1. 使用 `.agent/scripts/agent-branch-helper.sh` 解析目标路径，不要在工作流中重复 slug 逻辑。
2. 以辅助脚本输出作为目标路径，不要用不可信的任务文本或分支文本自行拼接路径。
3. detached HEAD 时停止并要求切换到具名分支，不要把游离提交的内容写进其他分支命名空间。
4. 目录子命令只允许传入 `plans`、`missions`、`handoffs` 或 `incidents`。
5. Worktree 所有权、锁、handoff payload 与合并验证仍由现有规则治理。命名空间只改变存储路径。
6. 内容提升、归档或删除由项目正常合并流程决定。辅助脚本不会移动或删除内容。

## Slug 安全

辅助脚本对分支名做百分号编码：先把字面量 `%` 编码为 `%25`，再把 `/` 编码为 `%2F`。该可逆映射避免 `feature/a-b` 与 `feature-a/b` 一类有损碰撞。工作流不得自行把 `/` 替换为 `-`。

## 标准用法

```bash
bash .agent/scripts/agent-branch-helper.sh status
PLAN_DIR=$(bash .agent/scripts/agent-branch-helper.sh ensure-current plans)
```

使用 `namespace`、`relpath` 或 `status` 做只读探测。只有 `ensure` 和 `ensure-current` 会创建目录。
