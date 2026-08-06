# subagent-fanout protocol

> **Sourced from** `.agent/plans/proposals/subagent-fanout-trace/`.  Hosts
> (Claude Code / Cursor / Codex) that want cortex-agent framework to
> track their fan-out sub-agent lifecycle should push events defined here.

## Trigger keywords (zh + en first)

Hosts should consider the user's request a fan-out when the text matches
one of these patterns.  Note the framework's helper
`matchFanoutTrigger(text)` will return `{ matched, language, matchedKeyword }`
— hosts can call that helper directly, or do their own matching.

| Language | Keywords |
|---|---|
| en | `fan out`, `fan-out`, `subagent`, `spawn agent`, `parallel agents`, `delegate` |
| zh | `分发子任务`, `分发`, `并行 agent`, `并行子 agent`, `并行 3 个`, `子 agent 调查`, `fan out 中文`, `fàn chū`, `并行 4 个`, `派 3 个 agent` |

## Event schema (API enum is English; UI labels are bilingual)

Hosts push these events via `subagent-trace emit` (see Phase 2 skill)
or directly via the management-api `runs event` interface.  The
`type` field MUST be one of:

| `type` | Required | Optional |
|---|---|---|
| `subagent_spawned` | `parent_run_id`, `subagent_role`, `subagent_id` | `task_description`, `expected_duration_minutes`, `tools_granted`, `model` |
| `subagent_progress` | `subagent_id` | `percent`, `current_step`, `tool_calls_count` |
| `subagent_completed` | `subagent_id`, `status` | `output_summary`, `output_artifact_refs[]`, `duration_actual_seconds`, `tool_failures_count`, `transcript_ref` |
| `subagent_cancelled` | `subagent_id`, `reason` | — |

`status` enum: `success` | `partial` | `failed`.

`subagent_role` is a free-form string; framework UI uses
`role_labels` table below for display.  Common values:
`explore`, `plan`, `general`, `code-reviewer`, `test-runner`,
`researcher`, plus host-specific names.

## Bilingual labels (dashboard display)

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

## Compliance

Hosts SHOULD push `subagent_spawned` immediately when a sub-agent
starts and `subagent_completed` (or `subagent_cancelled`) when it ends.
`subagent_progress` is optional but recommended for long-running
sub-agents so the dashboard can render percent / current step.

Failure handling: when `status=failed` or `status=partial`, hosts
SHOULD additionally write an `inbox` message to the parent_run so
parent agent gets notified (this is host-side; framework is a passive
receiver here).

## event-bus 桥接 (M-004 / FAE-002 — 增量段落, BC 兼容)

> 本节为 M-004 之后追加; 旧 `subagent-trace emit` 路径**完全保留**.

framework event bus (M-004 MS-001 + MS-002) 提供 8 类 core event,
subagent 5 类 (subagent_spawned / subagent_progress / subagent_completed /
subagent_failed / subagent_cancelled) 是 event-bus 跟 subagent-fanout
协议的双向桥接.

| subagent-fanout 事件 | event-bus 事件 (`eb:` 前缀) | 触发 |
| :--- | :--- | :--- |
| `subagent_spawned` | `eb:subagent_spawned` | `bridge.spawn()` |
| `subagent_progress` | `eb:subagent_progress` | `bridge.progress()` (节流 ≥ 10%) |
| `subagent_completed` (status=success\|partial) | `eb:subagent_completed` | `bridge.complete()` |
| `subagent_completed` (status=failed) | `eb:subagent_failed` | `bridge.complete()` + auto inbox 父 run |
| `subagent_cancelled` | `eb:subagent_cancelled` | `bridge.cancel()` |

**BC 兼容**: 旧 `node ... subagent-trace emit ...` 命令 unchanged,
event-bus 不收. 新 `bridge.*` 路径自动 emit + 双写
`runs/<id>.json#subagent_fanout[]` (旧路径 preserved).
