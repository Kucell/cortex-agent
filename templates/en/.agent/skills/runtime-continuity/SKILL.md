---
name: runtime-continuity
description: session-manager protocol plus Runtime Continuity v2 as a CLI: assess / log / checkpoint / archive / restore / status / warm / host-switch / pre-departure / resume-bundle / list-contexts. Writes transferable work state to .agent/runtime-continuity/ and readable archives to ~/.agent/contexts/<project>/.
---

# runtime-continuity (L1 — session-manager CLI shell + Runtime Continuity v2)

Hosts (Claude Code / Cursor / Codex) can't easily spawn a sub-agent
definition like `sub-agents/session-manager.md` and wait for output.
This skill wraps that sub-agent's time-management protocol in a CLI surface so
any host can invoke the same continuity discipline. Runtime Continuity v2 adds
standard work-log events, structured archives, and resume bundles under
`.agent/runtime-continuity/`.

> The authoritative protocol lives at `.agent/sub-agents/session-manager.md`.
> This file does NOT redefine it.  Only implementational details differ
> (CLI args vs Sub-Agent triggering), and only when CLI mechanics require.

## When to Use

- SessionStart automatically launches or renews a single continuity guard.
  It catches up archives older than 2 hours, archives every 2 hours, and
  expires after the rolling 5-hour window.
- Switching host agent mid-task (Claude Code → Codex, etc.) → run
  `host-switch` before leaving the old host.
- Leaving a host automatically (session close / window close / crash) →
  SessionEnd hook calls `pre-departure --gate agent`; it writes a checkpoint
  + `host_switch_initiated` event, degrades to archive on failure, and never
  blocks session close.
- Resume work next day / next session / new agent → run `resume-bundle`
  first, then `restore --auto` if the Markdown body is needed.
- Checking "how stale is this session" → run `status`.
- Recording transferable work state → run `log` or `checkpoint` during work.

## Commands

```bash
# 0. assess — evaluate time budget for a task description
node .agent/skills/runtime-continuity/scripts/index.js assess \
  --task-description "..." --gate user

# 1. log — append transferable work log to .agent/runtime-continuity/events/
node .agent/skills/runtime-continuity/scripts/index.js log \
  --project <project> --gate agent --host codex --message "..." \
  --done "..." --in-progress "..." --next "..." --files a,b

# 2. checkpoint — append a stronger phase boundary event
node .agent/skills/runtime-continuity/scripts/index.js checkpoint \
  --project <project> --gate agent --host codex --phase validating \
  --message "..." --command "node tests/foo.test.js" --exit-code 0

# 3. archive — write Markdown + structured JSON snapshot
node .agent/skills/runtime-continuity/scripts/index.js archive \
  --project <project> --gate user --full \
  --note-json '{"done":["X"],"in_progress":"Y","next":["Z"]}'

# 4. restore — load latest snapshot for a project
node .agent/skills/runtime-continuity/scripts/index.js restore \
  --project <project> [--list | --auto | --gate user]

# 5. resume-bundle — default new-agent entrypoint
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle \
  --project <project>

# 5a. resume-bundle --auto --inject — SessionStart 自动注入（P-002 / MS-002）
#     只读；stdout 输出 [CORTEX-RESUME] 块；超预算自动摘要化；失败 exit 0
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle \
  --project <project> --auto --inject [--budget-percent <0-100>] [--budget-tokens <N>]

# 6. status — show last archive timing
node .agent/skills/runtime-continuity/scripts/index.js status \
  --project <project>

# 7. warm — output the "5-hour timer starting" prompt for the host
node .agent/skills/runtime-continuity/scripts/index.js warm

# warm --auto is reserved for SessionStart hooks and requires the
# CORTEX_SESSION_START=1 capability environment variable.

# 8. pre-departure — SessionEnd 自动预离场（host-switch 的 --gate agent 自动版）
#    由各 host 的 SessionEnd hook 调用；失败降级 archive；不阻塞会话关闭
#    MS-003：--mission-id 显式指定或启发式检测的 mission_context 注入 checkpoint 事件
node .agent/skills/runtime-continuity/scripts/index.js pre-departure \
  --project <project> --gate agent \
  [--next-host codex] [--reason "switching to codex"] [--mission-id M-xxx]

# 9. host-switch — cross-host migration
#    MS-003：自动检测活跃 mission 并生成 handoff JSON（.agent/handoffs/H-*-host-switch-*.json）；
#    --mission-id 显式覆盖启发式；--auto 供自动链路（跳过 user gate，缺 --project 时用 cwd basename）
node .agent/skills/runtime-continuity/scripts/index.js host-switch \
  --project <project> \
  --from-host claude-code --to-host codex \
  --reason "user wants codex now" \
  --gate user \
  [--mission-id M-xxx] [--auto] [--next-host codex] \
  --note-json '{"done":["X"],"in_progress":"Y","next":["Z"]}'

# 10. list-contexts — cross-project aggregation
#    Lists every project under ~/.agent/contexts/ with archive counts and
#    most-recent timestamps.  No --gate required (read-only).
node .agent/skills/runtime-continuity/scripts/index.js list-contexts \
  [--since 2026-07-01] [--format json|table]
```

### 5.1 resume-bundle --auto --inject（SessionStart 自动注入，P-002 / MS-002）

**用途**：新 host 的 SessionStart hook 在 `warm --auto` 之后自动调用本命令
（只读，0 mutation），把"上一次归档 / 待处理 handoffs / 当前 run / 当前
mission milestone"注入 system prompt，让新 host 第一轮对话即接手。stdout 顶部
输出 `[CORTEX-RESUME]` 标记行 + JSON 块；host 把该块注入 system prompt，或
（不支持 stdout 注入的 host）把块写入 fallback 文件
`.agent/runtime-continuity/auto-resume.json` 由 host 加载机制读取。

**参数表**：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--project <P>` | — | 项目名；SessionStart hook 模板用 `$(basename "$PWD")` 传入 |
| `--auto` | 关 | 自动模式：任何失败 graceful degrade（exit 0 + stderr 记录），**绝不阻塞 SessionStart** |
| `--inject` | 关 | 输出 `[CORTEX-RESUME]` 标记行 + JSON 块（含 `generated_at`、`project`、`latest_archive` 摘要、`pending_handoffs`、`current_milestone` 指针、`current_decision`、`next_action`） |
| `--budget-percent <0-100>` | 40 | 上下文预算阈值（占 context window 的百分比）；估算 bundle 大小超过该阈值 → 调用 `summarizeForResume` 摘要化 |
| `--budget-tokens <N>` | env 或 128000 | 显式指定 context window 大小（tokens）；也可用 env `CORTEX_CONTEXT_WINDOW_TOKENS` |

**既有行为不变**：不带 flags 的 `resume-bundle --project <P>` 保持原样（只读，
输出完整 bundle JSON）。本小节 flags 纯加法，不影响既有调用。

**摘要化分层（P-002 §2.3）**：

| 层级 | 内容 | 处理 |
| --- | --- | --- |
| 必保留（高优） | `pending_handoffs[]`、`runs[active].phase`、`milestones[current].goal`、`current_decision`、`next_action` | 原样保留 |
| 全文保留 | `latest_archive.metadata`（时间 `created_at`、来源 `source_host`、`reason`/`archive_id`） | 原样保留 |
| 摘要化 | `latest_archive.body`（前 200 字 + 指针 `see .agent/runtime-continuity/archives/latest.md`）、`runs[*].events[]`（仅最近 5 条 + 类型分布计数）、`artifact_states`（数量 + 状态分布） | 截断/聚合 |
| 丢弃 | 原始长 stdout、commit log 全文（`git.status_short`）、巨大嵌套 JSON（`archive` 全文、`runtime_events`/`sessions` 路径列表） | 不进入注入块（仅保留计数） |

**预算估算**：优先调用 context-budget skill 的估算 CLI（若有
`.agent/skills/context-budget/scripts/estimate-tokens.js`，契约：stdin 收
JSON，stdout 输出 `{"ok":true,"tokens":<n>}`）；否则用内置 fallback
（`JSON 字符数 / 4` ≈ tokens，零 npm 依赖，不依赖 skill 存在）。

**安全**：`[CORTEX-RESUME]` 块只含路径、摘要、指针，**不含** host 私有状态
（transcripts / cookies / secrets）。

**与 MS-001 `pre-departure` 联动（新 host 接手链路）**：

```text
旧 host SessionEnd → pre-departure（checkpoint + host_switch_initiated 事件）
   ↓
新 host SessionStart → warm --auto（既有，续期 guard）
   └─► resume-bundle --auto --inject（新增，只读）
        ├─► 预算评估（默认 40% 上限）→ 超限摘要化
        └─► stdout [CORTEX-RESUME] 块（或写 .agent/runtime-continuity/auto-resume.json）
   ↓
agent 第一轮对话即见：上一次归档 + 待处理 handoffs + 当前 run + 当前 milestone
```

各 host SessionStart hook 模板：`.agent/hooks/templates/session-start/`
（`claude-code.json` / `cursor.json` / `codex.json` / `pi.json`），每个模板在
`warm --auto` 之后追加 `resume-bundle --auto --inject --project $(basename "$PWD")`；
不支持 stdout 注入的 host 按模板注释改为写 fallback 文件
`.agent/runtime-continuity/auto-resume.json`。

### 8. pre-departure（SessionEnd 自动预离场）

**用途**：由各 host 的 SessionEnd hook（或等价事件）在会话关闭前自动调用，
替"忘记手动调 host-switch"兜底。写入 checkpoint + `host_switch_initiated`
事件，让新 host 的 resume-bundle 立刻看到 from→to 交接信号（无需等 guard
≤2h 兜底归档）。任何失败都 graceful degrade（exit 0），**绝不阻塞会话关闭**
（正常退出 / 窗口关闭 / 断网 / crash 均适用）。

**参数表**：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `--project <P>` | ✅ | 项目名；SessionEnd hook 模板用 `$(basename "$PWD")` 传入 |
| `--gate agent` | ✅ | agent 级 gate（`user` 也接受）；SessionEnd 自动路径不得要求 user gate |
| `--next-host <hint>` | 可选 | 目标 host 提示；探测顺序：CLI 参数 → `CORTEX_NEXT_HOST` env → `"unknown"` |
| `--reason "<text>"` | 可选 | 离开原因，默认 `session_end_auto` |

**事件写入**（写入 active run `.agent/runs/<id>.json#events[]` + RC 事件文件）：

1. `checkpoint`（`phase=session_ending`）——经 `createRuntimeEvent` 落盘
   （run 内对应事件 type 为 `runtime_checkpoint`，带 `phase: session_ending`）。
2. `host_switch_initiated`——含 `from_host` / `to_host` / `reason` /
   `archive_pending: true` / `via: pre_departure`。
3. 降级路径：若 1 或 2 抛异常 → `archiveProject(..., {source_host:
   'auto-pre-departure'})` + `pre_departure_fallback` 事件（guard ≤2h 兜底
   之外的最坏情况即时归档）。
4. 兜底也失败 / 任何残留异常 → `pre_departure_graceful_degrade` 事件记录
   `problems[]`，最终 **exit 0**。

**与 `host-switch --gate user` 的区别**：

| | `host-switch`（既有） | `pre-departure`（新增） |
| --- | --- | --- |
| 触发 | 用户显式意图，手动调用 | SessionEnd hook 自动触发 |
| gate | 必须 `--gate user`（GATES_DESTRUCTIVE） | `--gate agent` 即可（SessionEnd 自动路径） |
| 归档 | 必做（archive + 事件） | 事件为主；仅失败时降级归档 |
| 失败行为 | 失败即 exit≠0 报错 | graceful degrade，exit 0，不阻塞 |

两者写入同一事件总线（`runs/<id>.json#events[]`），新 host 读 resume-bundle
时通过 `via: pre_departure`（自动）vs 手动事件区分来源。

**各 host SessionEnd hook 模板**：`.agent/hooks/templates/session-end/`
（`claude-code.json` / `cursor.json` / `codex.json` / `pi.json`），每个模板
调用 `pre-departure --project $(basename "$PWD") --gate agent`；不支持原生
SessionEnd 的 host 按模板注释挂到等价事件（Cursor `session-stop`、Pi
`agent.exit` 等，标 `--event-stop-equivalent` / `event_stop_equivalent`）。

### 11. mission 上下文检测（方案 C）（M-030 / MS-003）

**用途**：`host-switch` / `pre-departure` 在跨 host 切换时自动识别当前
project 的活跃 mission，并在 `host-switch` 时自动生成 handoff JSON
（`.agent/handoffs/H-<ts>-host-switch-<from>-<to>.json`，符合
`.agent/handoffs/handoff.schema.json` 必填字段），让新 host 的
resume-bundle / handoff-protocol resume-prompt 立即消费。**零 schema 变更**：
不写 sessions/tasks/runs，只读 `.agent/missions/`。

**检测优先级**：`--mission-id` 显式指定 > `findActiveMissionHeuristic()`
启发式检测 > null。

**启发式（`findActiveMissionHeuristic()`，heuristic_version "v1"）**：

- 扫描 `.agent/missions/<M-xxx>/mission-plan.md`（只读前 8 KiB / 前 20 行，
  ≤10 个 mission 单次扫描 < 50ms）。
- 状态行正则（不区分大小写、中英文、空格容忍；兼容本仓库实际使用的
  `> **Status**:` 变体与列表项前缀）：

  ```text
  > **状态**:   > **State**:   **State**:   > State:
  （另容忍 `> **Status**:`、`- **State: ...**`、冒号两侧空格）
  ```

- 状态值非 `done` / `blocked` / `completed` / `complete` → 活跃；**无状态行
  默认活跃**（mission-plan 目录存在性启发式）。
- 返回 `{ active_missions: [{mission_id, mission_dir, state, plan_pointer}],
  heuristic_version: "v1", scanned_at }`；扫描 IO 异常 →
  `{ active_missions: [], heuristic_version: "v1", error }`。

**`host-switch` 三条路径**（无 `--mission-id` 时自动检测）：

| 活跃 mission 数 | handoff JSON `kind` | `mission_id` | 备注 |
| --- | --- | --- | --- |
| 0 | `host-switch-without-mission` | `null` | fallback：仍生成 handoff JSON（不带 mission 关联） |
| 1 | `host-switch` | 自动关联该 mission | 自动检测并写入 |
| ≥2 | `host-switch-multi-mission-ambiguous` | `null` | **不自动选**；`candidates: [...]` 列出候选，由用户/agent 后续用 `--mission-id` disambiguate |

`--mission-id <M-xxx>` 显式指定 → 跳过启发式，直接关联。`--auto` 仅供
runtime-continuity 自动链路（跳过 user gate；缺 `--project` 时以 cwd
basename 兜底），手动调用仍需 `--gate user`。既有 archive / session /
`host_switch_initiated` 事件行为不变。

**handoff JSON 字段映射**（`writeHandoffFromSwitch()`）：

- schema 必填字段齐全（`mode: "AGENT_RESUME"`、`from`、`to`、`task_progress`、
  `artifacts`、`verification`、`next_action`、`constraints`、`produced_at`），
  写盘后自动调 `handoff-protocol.js validate` 校验。
- `from.agent_id = "runtime-continuity:auto-<host>"`（source 语义映射，不新增
  source 字段）；`produced_at` = source.timestamp；`to.role = "session-start"`、
  `to.model_pref = [<next-host>]` = target 语义；`artifacts.context_snapshot_ref /
  markdown_ref` = latest archive 指针（payload 语义）。
- MS-003 附加元数据（不在 schema property set 内，已在本文档声明）：
  `kind`、`mission_context`（`heuristic_version` / `scanned_at` /
  `active_missions[]`）、`candidates[]`（仅 ambiguous 时）。去除这三个键后
  严格满足 `handoff.schema.json`。

**`pre-departure` mission_context 注入**：checkpoint（`runtime_checkpoint`
事件，phase=session_ending）payload 追加 `mission_context`：
- 无 `--mission-id` → `{ heuristic_version, scanned_at, active_missions: [...] }`
- 有 `--mission-id <M-xxx>` → `{ mission_id, heuristic_version, source:
  "explicit", scanned_at }`（跳过启发式）

**边界与联动**：

- ≥2 活跃 mission 时不自动选（写 ambiguous handoff + candidates），避免误关联；
  单 mission 项目（最常见）自动关联，零手动成本。
- 与 MS-001 `pre-departure` 联动：SessionEnd 自动预离场时 checkpoint 事件携带
  mission 上下文，新 host resume-bundle 即可见。
- 与 MS-002 `resume-bundle` 联动：自动生成的 handoff JSON 落入
  `.agent/handoffs/`（`H-` 前缀），`resume-bundle` 的 `pending_handoffs[]` 自动
  拾取；新 host 可 `handoff-protocol.js resume-prompt --payload-file <path>`。
- 安全：handoff JSON 只含路径 / 摘要 / 指针 / mission 元数据，不含 host 私有状态。
- 零依赖：mission-plan 扫描只用 Node 内置模块（fs / path / child_process）。

## Guarantees

- **Reuses session-manager path & protocol**: archive writes to the same
  `~/.agent/contexts/<project>/` directory that session-manager
  sub-agent uses.  No parallel paths, no divergence.
- **Project-local resume state**: archive also writes
  `.agent/runtime-continuity/archives/RC-*.json` and
  `.agent/runtime-continuity/archives/latest.json`.
- **Single automatic guard**: `.agent/runtime-continuity/guard/` stores the
  PID, lock, heartbeat, renewal deadline, latest archive, and last error.
  Repeated SessionStart hooks renew the existing process instead of spawning
  another one.
- **Manual gate remains strict**: direct `archive` calls still require
  `--gate user`; only the internal SessionStart guard can create automatic
  interval archives.
- **New-agent entrypoint**: `resume-bundle` summarizes latest archive,
  handoffs, runs, sessions, artifacts, runtime events, and git state.
- **Audit-friendly**: every archive / restore / status call writes
  one `session_archived` / `session_restored` / `session_status_queried`
  event into `runs/<active-run>.json#events[]` so the audit-trail
  can correlate.
- **Zero dependency**: pure stdlib + existing management-api events
  writer.  No npm install.

## Non-Goals

- Does NOT expose a general-purpose daemon start command.
- The automatic guard does NOT commit, stop Dashboard, execute product code,
  or modify product source.
- Does NOT crawl host private state (Claude Code transcripts, Codex
  conversation history, browser cookies, etc.).
- Does NOT store secrets or full diffs; store paths, commands, summaries, and
  artifact references instead.

## Source of Truth

- `.agent/sub-agents/session-manager.md` — the canonical 5-mode protocol.
  When in doubt about *what to say*, read that file.
- This `SKILL.md` — when in doubt about *how to invoke it as a CLI*,
  read this file.

For more on the spec (helpers, return-shape, edge cases), read
`scripts/index.js` directly — it is single-file and well-commented.
