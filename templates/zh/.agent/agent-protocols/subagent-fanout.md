# subagent-fanout 协议

> **协议源**:`.agent/plans/proposals/subagent-fanout-trace/`。
> host(Claude Code / Cursor / Codex)想被 cortex-agent 框架追踪 fan-out
> sub-agent 全生命周期时,应 push 此处定义的事件。

## 触发词(中英 first)

host 在收到用户指令匹配下列模式时应视作 fan-out。framework 提供
`matchFanoutTrigger(text)` 辅助函数,返回 `{ matched, language, matchedKeyword }`
—— host 可直接调该函数,或自行匹配。

| 语言 | 关键词 |
|---|---|
| en | `fan out`, `fan-out`, `subagent`, `spawn agent`, `parallel agents`, `delegate` |
| zh | `分发子任务`, `分发`, `并行 agent`, `并行子 agent`, `并行 3 个`, `子 agent 调查`, `fan out 中文`, `fàn chū`, `并行 4 个`, `派 3 个 agent` |

## 事件 schema(API enum 英文;UI 文案中英)

host 通过 `subagent-trace emit`(Phase 2 skill)或直接走
`management-api runs event` 通道 push 这些事件。`type` 字段必须为
下列之一:

| `type` | 必填 | 可选 |
|---|---|---|
| `subagent_spawned` | `parent_run_id`, `subagent_role`, `subagent_id` | `task_description`, `expected_duration_minutes`, `tools_granted`, `model` |
| `subagent_progress` | `subagent_id` | `percent`, `current_step`, `tool_calls_count` |
| `subagent_completed` | `subagent_id`, `status` | `output_summary`, `output_artifact_refs[]`, `duration_actual_seconds`, `tool_failures_count`, `transcript_ref` |
| `subagent_cancelled` | `subagent_id`, `reason` | — |

`status` 枚举:`success` | `partial` | `failed`。

`subagent_role` 是自由字符串,framework UI 用下面的 `role_labels`
展示。常见值:`explore` / `plan` / `general` / `code-reviewer` /
`test-runner` / `researcher` 加 host 自有命名。

## 双语 labels(dashboard 渲染用)

`status_labels`:

| Key | en | zh |
|---|---|---|
| `running` | running | 运行中 |
| `spawning` | spawning | 启动中 |
| `success` | success | 成功 |
| `partial` | partial | 部分完成 |
| `failed` | failed | 失败 |
| `cancelled` | cancelled | 已取消 |

`role_labels`:

| Key | en | zh |
|---|---|---|
| `explore` | explore | 探索 |
| `plan` | plan | 规划 |
| `general` | general | 通用 |
| `code-reviewer` | code-reviewer | 代码审查 |
| `test-runner` | test-runner | 测试执行 |
| `researcher` | researcher | 调研 |

## 协议要求

host **应当**在 sub-agent 启动时立即 push `subagent_spawned`,在
sub-agent 结束时 push `subagent_completed`(或 `subagent_cancelled`)。
`subagent_progress` 可选,但长跑任务建议 push 让 dashboard 渲染进度。

失败处理:当 `status=failed` 或 `status=partial`,host **应当**额外
向 parent_run 写一条 `inbox` 消息让 parent agent 知道(此步是 host
侧责任,framework 仍是被动接收者)。
