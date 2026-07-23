---
name: management-api
description: Cortex Agent dashboard、runs、queues、sessions、inbox、decisions 和 waitpoints 的本地管理查询与受控运行态写入器。
---

# Management API Skill

## Purpose

Provide a stable local JSON query contract over `.agent/` runtime state. Dashboard, briefing, worktree, mission, and future CLI commands should read this layer instead of each parsing the same Markdown and JSON files differently.

Runtime writers are intentionally narrow: write run state and run events through this skill so dashboard status reflects what agents are actually doing.

## Commands

Agent 必须优先发现并使用公开 CLI 契约：

```bash
cortex-agent help --json
cortex-agent help query --json --project .
cortex-agent query dashboard-state --project .
cortex-agent query runs --project .
cortex-agent query activity --project . --since 2026-07-13 --until 2026-07-19
cortex-agent runs checkpoint --project . --run-id R-T005 --task-id T-005 --type validation_started --phase validating --activity "Running focused tests"
cortex-agent queues upsert --project . --queue-id Q-batch-1 --gate parallel --name "Batch 1" --concurrency-limit 2
cortex-agent sessions heartbeat --project . --session-id S-dashboard --agent-id dashboard-manager --activity "Refreshing dashboard"
cortex-agent decisions resolve --project . --decision-id D-merge --gate user --status approved --selected-option approve --resolved-by maintainer --rationale "Validation passed"
cortex-agent waitpoints release --project . --waitpoint-id WP-merge --gate owner --owner-workflow /checkpoint-merge --decision-id D-merge --released-by coordinator
```

`cortex-agent help --json` 是 CLI grammar 与 writer action 的机器可读事实来源；`cortex-agent help query --json --project <path>` 会附加目标项目真实支持的 projection。内部 `.agent/skills/management-api/scripts/index.js` 仅作为实现、调试或旧版 CLI 降级入口，发生降级时必须明确记录。

## Output Contract

公开 `cortex-agent query` 返回稳定 envelope：

```json
{
  "ok": true,
  "command": "query",
  "projection": "dashboard-state",
  "project": {
    "root": "/path/to/project",
    "agent_root": "/path/to/project/.agent"
  },
  "filters": {},
  "data": {},
  "summary": {},
  "warnings": []
}
```

所有公开 query 都是只读的。`activity` 会把缺少有效结构化时间的记录放入 `data.unknown_time`，不会根据文件 mtime 或计划文本推断完成状态。失败时 stdout 返回结构化 JSON，stderr 只写诊断，退出码分类由 CLI 契约定义。

## Runtime State Contract

Use these fields for precise state:

- `status`: lifecycle state, one of `queued`, `running`, `completed`, `failed`, `canceled`.
- `phase`: current execution phase, such as `decomposing`, `creating_worktree`, `acquiring_lock`, `invoking_agent`, `reading`, `editing`, `running_command`, `validating`, `handoff`, `merging`, or `blocked`.
- `activity`: short human-readable text for the current visible activity.
- `events[]`: append-only timeline of important transitions.
- `last_event`: cached latest event for dashboards and summaries.
- `runs checkpoint`: preferred workflow helper that updates run state and appends one event in a single command.

Agents should update state at these minimum checkpoints:

1. task decomposition starts
2. worktree creation starts or completes
3. task/file lock acquisition starts or completes
4. sub-agent invocation starts
5. file reading or editing begins
6. shell command or validation starts and finishes
7. handoff, merge, publish, block, fail, cancel, or complete happens

Prefer these stable `events[].type` values:

- `state_changed`
- `task_decomposed`
- `worktree_created`
- `lock_acquired`
- `agent_invoked`
- `file_read`
- `file_edited`
- `command_started`
- `command_finished`
- `validation_started`
- `validation_passed`
- `validation_failed`
- `handoff_created`
- `merge_started`
- `merge_completed`
- `publish_started`
- `publish_completed`
- `blocked`
- `failed`
- `canceled`
- `completed`

## Rules

- 不要依赖记忆猜测 CLI 参数；先执行 `cortex-agent help --json`，跨项目自动化前再查询目标项目 capability。
- 标准 Agent workflow 必须调用 `cortex-agent`，不得硬编码内部 Management API 脚本路径。
- Keep this skill zero dependency.
- Read from `.agent/` and Git only.
- Only mutate `.agent/runs/*.json` through the `runs upsert`, `runs event`, and `runs checkpoint` commands.
- Queue mutations require `--gate parallel|worktree|approve|mission`; session heartbeats require the recorded owner, while pause/close require `--gate owner|handoff|user|mission`.
- Decision 请求必须提供所属 workflow gate。批准、拒绝或要求修订必须使用 `decisions resolve --gate user`，并记录 resolver 与 rationale；终态 Decision 不得再次解析。替代 open Decision 必须使用 `decisions supersede --gate requester`，由相同 requester 指向兼容且仍为 open 的新 Decision，并记录 rationale。
- Waitpoint 释放必须由所属 workflow 执行，并引用 action 与 resource 完全匹配的 approved Decision；Decision 文件路径必须写入 `evidence_refs`，且 `expires_at` 已到或无效时必须 fail closed。
- Waitpoint 取消需要 owner、Mission 或显式 user gate。过期需要 owner/Mission 权限且 `expires_at` 已到；读取时派生过期状态不得产生写入。
- 调用方提供的日期时间必须是有效 RFC 3339 值，校验通过后才能写入记录。
- Inbox 状态转换必须校验 recipient 或 originating workflow 所有权。确认消息不会批准 Decision，也不会释放 Waitpoint。
- Dashboard 和所有 `query` 命令均为 read-only，不得解析 Decision 或释放 Waitpoint。
- Runtime JSON writes use a temporary sibling file followed by atomic rename; read-only queries never write derived stale state.
- Runtime 与协作对象位于 `.agent/runs/`、`.agent/queues/`、`.agent/sessions/`、`.agent/inbox/`、`.agent/decisions/` 和 `.agent/waitpoints/`。
- PRD objects live under `.agent/prd/` or `.agent/prds/`; dashboard-state exposes `prds` and `prd_summary`.
- Running or paused sessions whose `last_heartbeat_at` is older than five minutes are reported as `stale`.
- Preserve compatibility with older projects by tolerating missing files.
- If a caller needs HTML, it should render JSON itself; this skill only returns data.
