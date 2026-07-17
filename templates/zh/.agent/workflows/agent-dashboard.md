---
name: agent-dashboard
description: 生成本地 HTML 任务管理与多 Agent 协作状态看板，方便人阅读当前进度、worktree、locks、handoff 和 next action。
---

# Agent Dashboard 工作流 (/agent-dashboard)

## 目标

生成一个本地 HTML 看板，让人快速理解：

- 当前任务进度
- worktree 并行状态
- active agents
- locks
- handoffs
- Artifact Bus 状态
- 推荐下一步动作

## 使用方式

```text
/agent-dashboard
/agent-dashboard --out .agent/metrics/agent-dashboard.html
/agent-dashboard --serve
/agent-dashboard --serve --port 8787 --interval-ms 3000
```

## 执行步骤

1. 读取 `.agent/skills/agent-dashboard/SKILL.md`。
2. 运行：

```bash
node .agent/skills/agent-dashboard/scripts/generate.js
```

3. 输出生成路径，例如：

```text
.agent/metrics/agent-dashboard.html
```

4. 如果用户需要预览，直接打开该 HTML 文件。

## 实时服务模式

如果用户要求实时更新，交给 `dashboard-manager` sub-agent 处理：

```bash
node .agent/skills/agent-dashboard/scripts/serve.js --port 8787 --interval-ms 3000
```

服务行为：

- 每隔 `interval-ms` 重新生成 HTML
- 通过本地 HTTP server 提供页面
- 页面使用 SSE 自动刷新
- 默认地址：`http://127.0.0.1:8787`
- 如果端口被占用，server 会自动尝试下一个端口，并在 JSON 输出中返回实际 `url`

`dashboard-manager` 只维护看板，不写业务代码、不提交、不合并。

## 状态解释

看板中的 `Worktree State` 必须来自当前状态，而不是固定建议：

| 状态 | 含义 | 推荐动作 |
| :--- | :--- | :--- |
| `idle` | 还没有 worktree 并行现场 | `/worktree plan <tasks>` |
| `planned` | 已有计划或基础状态，尚未开始写入 | `/worktree create` 或 `/start-task` |
| `in_progress` | worktree 有改动或任务正在推进 | 达到可验证点后 `/worktree commit` |
| `handoff_required` | 有 handoff 需要恢复或接收 | `/handoff resume` |
| `merge_ready` | worktree 可进入合并检查 | `/worktree merge` |
| `validation_failed` | 合并后验证失败 | 修复或创建 `/handoff` |
| `validated` | 主线验证通过 | `/sync-plans`、`/update-refs` |

## 与其他工作流的协作

- `/briefing`：可引用最新 dashboard 作为人的进度入口。
- `/worktree status`：输出机器可读状态与 next_action。
- `/agent-dashboard`：输出人可读 HTML。
- `dashboard-manager`：负责生成页面与启动本地实时 server。
- `/publish-docs`：发布开发者文档，不替代本地协作看板。

## Dashboard Session

- `serve.js` 在实际端口监听成功后自动打开 `dashboard-manager` Session，并记录真实 URL/port。
- 每轮刷新由同一 owner heartbeat；`SIGINT`/`SIGTERM` 时通过 owner gate 关闭 Session。
- 静态 HTML 生成不创建 Session，Dashboard 页面和查询接口也不得写业务状态。
