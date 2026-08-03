# Framework Event Bus — Detail Design Spec

> **Sub-proposal ID**: `FAE-002` (detail design, supersedes proposal-stage draft)
> **Parent**: `docs/architecture/general-mode-design.md` v0.3 §17 (v2.0 愿景)
> **Status**: `spec-draft` (待 Eric review + 拍板 → `spec-approved` → 启动 M-004 实施)
> **Owner**: `Worker-F-FAE002Spec` (架构协调人 sub-agent)
> **Created**: 2026-08-02
> **Phase**: 4 (v2.0 启动条件 #5 实质工作)
> **Target Mission**: M-004 (5-6 周实施)
> **Related RFC**: `docs/architecture/general-mode-design.md` v0.3 §17.1 - §17.6
> **Related Proposal**: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-002-framework-event-bus.md` (11 KB draft, 16 决策项已拍板)
> **Related Skill**: `.agent/skills/subagent-trace/SKILL.md` (升级目标)
> **Related Mission**: M-008 coordination (复用 journal / ownership / notification)

---

## 1. Executive Summary

**FAE-002 解决什么**:cortex-agent framework 当前在「**显式 emit + 半自动 inbox + journal 轮询**」模式下,sub-agent 成功完成时仍需显式调用 `emit --event subagent_completed`,父 agent 必须主动 poll journal/inbox 才能知道 sub-agent 已结束 — 这导致 v2.0 全自动 mission 编排的核心叙事「主 agent 派发 sub-agent → 事件触发回主 agent → 主 agent 完整完成 mission」在 **framework 层面** 跑不通(mavis 平台层能跑,但脱离 mavis 就断)。

**本 spec 落地的事**:把 framework 从「被动接收 + 显式 emit」升级为「**真事件总线** + **sub-agent 自动 emit** + **父端自动 subscribe & resume**」,通过 `lib/event-bus/` 新建(`event-bus.js` / `subscribe.js` / `publish.js` / `event-types.js`),4 个 client(`parent-resume` / `coordination-sync` / `dashboard-push` / `notification-pump`),8 类强 schema 事件,纯 `node:fs.watch` + JSONL 持久化,**0 npm install**,backward compat 保持 `runs/<id>.json#subagent_fanout[]` 读侧接口不变。

**边界(关键)**:
- **mavis 平台层**:不动。`task` tool 已具备真事件驱动,主 session 自动 resume — 这是「赠品加速器」,不替代 framework 自身的事件总线。
- **M-008 coordination**:复用。event-bus 的 events.jsonl 与 M-008 journal 双源同步,ownership lease 复用,notification pump 走 event-bus 统一协议。
- **FAE-001 dispatch**:升级。从 stub(显式调 `cortex-agent dispatch`)到 emit 时自动写 `subagent_spawned` event(零用户额外操作)。
- **subagent-trace SKILL**:升级。从「显式 emit + 只 failure 自动 inbox」到「sub-agent 完成/失败/取消自动 emit 8 类事件中的对应类」。

**v2.0 启动条件 #5 实质工作**:RFC v0.3 §17.5 写明 v2.0 GA 需 5 个条件全部满足,本 spec 落第 5 项「FAE-002 framework 真事件总线 spec 已批准」。批准后,phase 4 实质工作(5-6 周 mission)按本 spec 实施。

**Eric 视角 1 段总结**:FAE-002 spec 把「真事件总线」从提案(11 KB 概念)扩成 detail design(8 章节 + 5 决策 + 1 e2e),作为 M-004 实施 mission 的实施依据。批准后,framework 能在脱离 mavis 平台时也跑「派发→执行→自动回主」闭环,v2.0 启动条件 #5 满足。

---

## 2. Goals & Non-Goals

### 2.1 In Scope(M-004 mission 5-6 周范围内)

| # | 类别 | 具体内容 |
| :--- | :--- | :--- |
| 1 | 5 类 owner(模块) | `lib/event-bus/event-bus.js` / `lib/event-bus/publish.js` / `lib/event-bus/subscribe.js` / `lib/event-bus/event-types.js` / `lib/event-bus/clients/*.js` |
| 2 | 5-6 周 mission | MS-001(1 周:核心 + 8 schema + tests)/ MS-002(3-4 天:subagent-trace 升级 + CLI 子命令)/ MS-003(1 周:parent-resume + e2e)/ MS-004(1 周:coordination-sync + dashboard-push + notification-pump)/ MS-005(1 周:RFC v0.5 + release notes + AI-Brain 实战 2 月观察) |
| 3 | 8 类 core event | `subagent_spawned` / `subagent_progress` / `subagent_completed` / `subagent_failed` / `subagent_cancelled` / `handoff_ready` / `decision_resolved` / `waitpoint_released` + 1 extension namespace `custom:*` |
| 4 | 4 个 client | `parent-resume`(必)/ `coordination-sync`(必)/ `dashboard-push`(可选)/ `notification-pump`(可选) |
| 5 | 0 npm install | 纯 `node:fs.watch` + JSONL + node:fs/promises + node:crypto(已有 stdlib),不引入新依赖 |
| 6 | 强 schema | JSON Schema draft-07 强制 8 类 event shape(`lib/event-bus/event-types.js` 注册) |
| 7 | Backward compat | `runs/<id>.json#subagent_fanout[]` 读侧接口不变;event-bus 作为新增写源(双源) |
| 8 | Mavis 桥接 | 双向桥:`framework emit → mavis 知道` + `mavis task tool 完成 → emit eb:task_completed` |

### 2.2 Out of Scope(本 spec 不做)

| # | 类别 | 原因 / 归属 |
| :--- | :--- | :--- |
| 1 | mavis 平台层改造 | 平台层已具备真事件驱动;v2.0 赠品加速器,无需动 |
| 2 | 持久守护进程 daemon | MS-007 deferred to ADR;FAE-002 不重启 daemon 讨论(默认纯 push + node:fs.watch) |
| 3 | 5 adapters(Claude Code / Codex / PI / Kimi / DeepSeek) | Phase 3 / M-003,独立 mission |
| 4 | `cortex-agent migrate` 命令 | v2.0 触发条件之一,独立 mission(不在 M-004 范围) |
| 5 | SQLite / 数据库 | 决策 D-FAE-002-2 已拍 A:纯 JSONL 零依赖 |
| 6 | cloud / SaaS 化 | 本地优先 + 文件系统优先(M-008 既有原则) |
| 7 | 跨 host 联邦 event bus | Phase 5 future work;FAE-002 范围限定单 host 内的 `.agent/event-bus/<bus-id>/` |
| 8 | 事件加密 / 签名 | 当前信任 host 内本地 fs;未来如需跨 host 加密,Phase 5 单独 spec |
| 9 | Event 流式处理(>1000 events / sec 高吞吐) | 性能 baseline 1000 events / sec 已满足 v1.x 实战;Phase 5 优化 |
| 10 | 5 类 v2.0 启动条件 #1-#4 | 归属 v1.10.0 release / M-002 / M-003,FAE-002 只负责 #5 |

---

## 3. Architecture Overview

### 3.1 4 个核心 Component

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Framework Event Bus (FAE-002)                       │
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │  Component 1    │   Publisher(producer)                                  │
│  │  ───────────    │   ────────────────                                     │
│  │  · sub-agent    │   谁:sub-agent 自身 / 父 agent 派发时 / 外部 CLI        │
│  │  · 父 agent     │   接口:`event-bus.publish(event)` / `bin/cli.js         │
│  │  · CLI 入口     │     event-bus publish --event <type> ...`              │
│  │  · adapter      │   行为:1) 校验 schema → 2) 生成 event_id(uuid v4) →    │
│  │                 │        3) 写 .agent/event-bus/<bus-id>/events.jsonl   │
│  │                 │        (append + fsync)→ 4) 触发 fs.watch              │
│  └────────┬────────┘                                                        │
│           │ append + fsync(events.jsonl)                                    │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Component 2 — Storage(持久化)                              │           │
│  │  ──────────────────────────                                  │           │
│  │  目录:.agent/event-bus/<bus-id>/                             │           │
│  │    · events.jsonl(append-only,fsync per write)               │           │
│  │    · subs.json(订阅者清单 + last_read_offset)                │           │
│  │    · archive/events-<ts>.jsonl.gz(10MB cap 滚动)             │           │
│  │  行为:cap 10MB / bus,rotate 走 archive/,subs 持久化 offset   │           │
│  └────────┬─────────────────────────────────────────────────────┘           │
│           │ node:fs.watch 触发(events.jsonl 增量)                          │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Component 3 — Fan-out / Dispatcher                         │           │
│  │  ──────────────────────────────                              │           │
│  │  形态:可选(默认纯 push — publisher fsync 后本地推 sub 客户端)│           │
│  │  fan-out 进程(用户主动起):                                    │           │
│  │    1) 监听 events.jsonl 增量(node:fs.watch + fallback poll)  │           │
│  │    2) 读 subs.json,匹配 event_name / namespace filter       │           │
│  │    3) 投递(本地 push 到 client / 远端 webhook 跨 host)        │           │
│  │    4) 等 client ack(默认 30s,可配)                            │           │
│  │    5) 超时未 ack → 重投 3 次 → 写 decision 让人工介入          │           │
│  │    6) dedupe:同 event_id 多次 emit 只生效首次                 │           │
│  └────────┬─────────────────────────────────────────────────────┘           │
│           │ push(本地) / webhook(远端)                                       │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Component 4 — Clients(订阅者)                              │           │
│  │  ──────────────────────────                                  │           │
│  │  4 个内置 client:                                             │           │
│  │   · parent-resume.js     → 父 agent 自动 resume mission      │           │
│  │   · coordination-sync.js → M-008 journal 双源同步            │           │
│  │   · dashboard-push.js    → dashboard 实时面板(可选)         │           │
│  │   · notification-pump.js → 跨 host 通知(对接 M-008)         │           │
│  │  接口:`client.handle(event, ctx) → ack|reject`              │           │
│  └──────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 8 类 Core Event Schema(JSON Schema draft-07)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cortex-agent/schemas/event-bus/event-envelope.json",
  "title": "Framework Event Bus Envelope",
  "description": "所有 event-bus event 共享 envelope,具体 event 在 'payload' 字段中扩展",
  "type": "object",
  "required": ["event_id", "event_name", "event_version", "bus_id", "occurred_at", "producer", "correlation", "payload"],
  "additionalProperties": false,
  "properties": {
    "event_id":     { "type": "string", "pattern": "^eb-evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "description": "uuid v4,event-bus 内部唯一" },
    "event_name":   { "type": "string", "enum": ["subagent_spawned", "subagent_progress", "subagent_completed", "subagent_failed", "subagent_cancelled", "handoff_ready", "decision_resolved", "waitpoint_released"], "description": "8 类 core event;扩展事件用 'custom:<name>'" },
    "event_version":{ "type": "string", "pattern": "^[0-9]+\\.[0-9]+$", "description": "事件 schema 版本,默认 1.0" },
    "bus_id":       { "type": "string", "pattern": "^[a-z0-9-]+:[a-z0-9-]+$", "description": "event bus id 格式 '<host-id>:<mission-id>'(见 §3.4)" },
    "occurred_at":  { "type": "string", "format": "date-time", "description": "事件发生时间(ISO 8601 UTC)" },
    "producer":     { "$ref": "#/definitions/producer" },
    "correlation":  { "$ref": "#/definitions/correlation" },
    "payload":      { "type": "object", "description": "具体 event 强类型 payload(每类 event 一套 schema)" }
  },
  "definitions": {
    "producer": {
      "type": "object",
      "required": ["producer_id", "producer_kind"],
      "properties": {
        "producer_id":   { "type": "string", "description": "sub-agent id / parent agent id / CLI 入口" },
        "producer_kind": { "enum": ["sub_agent", "parent_agent", "cli", "adapter", "scheduler"] },
        "session_id":    { "type": ["string", "null"] }
      }
    },
    "correlation": {
      "type": "object",
      "required": ["mission_id", "subagent_id", "parent_run_id"],
      "properties": {
        "mission_id":     { "type": "string", "description": "归属 mission id(无则 'global')" },
        "subagent_id":    { "type": "string", "description": "归属 sub-agent id('host' 表示父端事件)" },
        "parent_run_id":  { "type": "string", "description": "M-008 run journal run_id" },
        "causation_id":   { "type": ["string", "null"], "description": "上游 event_id(因果链)" }
      }
    }
  }
}
```

**8 类 event 各自的 `payload` schema**(`payload.<field>` 详定义,见 `lib/event-bus/event-types.js`):

| Event | 必填 payload 字段 | 选填 payload 字段 | 触发条件 | ack? |
| :--- | :--- | :--- | :--- | :---: |
| `subagent_spawned` | `subagent_role`, `task_description` | `tools_granted[]`, `model`, `expected_duration_minutes` | 派发 sub-agent 时(自动) | 否 |
| `subagent_progress` | `percent` (0-100) | `current_step`, `tool_calls_count` | 心跳(可选,5-30s 间隔) | 否 |
| `subagent_completed` | `status` (success/partial), `output_summary` | `output_artifact_refs[]`, `duration_actual_seconds`, `transcript_ref` | sub-agent 成功完成(自动) | **是** |
| `subagent_failed` | `status` (failed), `error_code`, `error_message` | `retry_count`, `last_tool_failure`, `output_partial_summary` | sub-agent 失败(自动) | **是** |
| `subagent_cancelled` | `reason` | `cancelled_by` (user/parent/system) | 取消(自动 / 父显式 cancel) | 否 |
| `handoff_ready` | `handoff_id`, `handoff_path`, `from_subagent_id`, `to_subagent_id` | `handoff_kind` (cross_host / cross_session) | 跨 host / 跨 session handoff 写入(自动) | 否 |
| `decision_resolved` | `decision_id`, `resolution` (approved/rejected/deferred) | `resolved_by`, `resolution_note` | decision 被 resolve(自动监听 decision registry) | 否 |
| `waitpoint_released` | `waitpoint_id`, `release_reason` | `downstream_actions[]` | waitpoint 释放(自动监听 waitpoint registry) | 否 |

**Extension namespace**:`custom:<name>` 允许 host / mission 扩展自定义 event(如 `custom:build_completed` / `custom:lint_passed`)。subscribe 时按命名空间过滤(如 `custom:build_*`)。

### 3.3 parent-resume Client 行为(Finite State Machine)

```text
[INIT]
   │ client handle(event, ctx)
   ▼
[RECEIVED] ── ctx 校验(mission_id / subagent_id 匹配) ──→ [VALIDATING]
   │                                                      │
   │                                                      ├── fail ─→ [REJECTED] → ack(rejected)
   │                                                      │
   │                                                      success
   │                                                      ▼
   │                                              [CHECK_LEASE] (校验父 agent mission lease)
   │                                                      │
   │                                                      ├── lease invalid ─→ [LEASE_FAILED]
   │                                                      │                       │
   │                                                      │                       ├─ retry 1 (5s 后) ─┐
   │                                                      │                       │                  │
   │                                                      │                       │  3 次失败       │
   │                                                      │                       │                  ▼
   │                                                      │                       │           [ESCALATED] → 写 decision + ack(escalated)
   │                                                      │                       │
   │                                                      │                       └─ retry 2 / 3 ────┘
   │                                                      │
   │                                                      success
   │                                                      ▼
   │                                              [READ_CONTEXT] (读 mission context + sub-agent output)
   │                                                      │
   │                                                      ▼
   │                                              [INJECT_RESULT] (把 sub-agent result 注入父 agent prompt)
   │                                                      │
   │                                                      ▼
   │                                              [RESUME_PARENT] (在 mission 上下文 resume 父 agent — 关键 invariant)
   │                                                      │
   │                                                      ▼
   │                                              [ACK] → ack(success) → [DONE]
   │
   └─── 任意阶段抛异常 ──→ [FAILED] → 重试 3 次 + 写 decision
```

**关键 invariant**:`RESUME_PARENT` 必须在 mission 上下文里 resume 父 agent(不是 spawn 新 agent)。具体落实:
- `ctx.mission_id` + `ctx.lease.held_by` 双重校验父 agent identity
- 调 `cortex-agent session resume --mission-id <id> --inject <sub-agent-output>`(M-008 session 子命令)
- 父 agent 看到 prompt:`[EVENT-BUS] subagent <sub-id> completed. output_summary: ...; 继续 mission <mission-id> 当前 milestone <ms-id> 推进。`
- 父 agent 走 mission 状态机到下一 milestone,继续推进

### 3.4 event bus id 命名规则

格式:`<host-id>:<mission-id>`

| 字段 | 规则 | 例 |
| :--- | :--- | :--- |
| `<host-id>` | `process.env.HOSTNAME` 取前 12 字符 + 小写;无则 `unknown-host` | `macbook-pro-1` |
| `<mission-id>` | `M-XXX` 格式,或 `global`(无 mission 上下文) | `M-004` |
| 完整例 | `macbook-pro-1:M-004` / `dev-laptop:M-001` / `macbook-pro-1:global` | — |

**为什么这样命名**:
- 同 host 跨 mission 隔离:每个 mission 独立 bus,events.jsonl 不混
- 跨 host 同步:远端 fan-out 按 `host-id` 段判断投递目标
- `global` 给无 mission 上下文的 framework 内部事件用(如 dispatch daemon 启动通知)

**多 bus 实例**:同一 host 同一 mission 不允许多 bus(单例,events.jsonl 单写者避免锁);同一 host 跨 mission 允许多 bus(每个 mission 独立目录)。

---

## 4. API Surface

> 本节为 spec,不是代码。实施时按此 spec 落地到 `lib/event-bus/`。

### 4.1 `lib/event-bus/event-bus.js` 公开 API

```js
// 构造函数 / 工厂
const bus = createEventBus({ busId, dataDir, opts });
// busId: string, e.g. "macbook-pro-1:M-004"
// dataDir: string, default ".agent/event-bus/<busId>/"
// opts: { fsync?: boolean = true, archiveCapBytes?: number = 10*1024*1024, pollFallbackMs?: number = 1000 }

// 5 个核心方法
await bus.publish(eventInput, ctx);
// eventInput: { event_name, payload, correlation? }
// ctx: { producer, sessionId? }
// 返回: { ok: true, event_id, persisted_at }
// 行为:校验 schema → 生成 event_id → append events.jsonl + fsync → 触发 fs.watch

await bus.subscribe(filter, handler, opts);
// filter: { event_names?: string[], namespace?: string, correlation?: { mission_id?, subagent_id? } }
// handler: async (event, ctx) => { ack: boolean, error?: Error }
// opts: { ackTimeoutMs?: number = 30000, retryCount?: number = 3 }
// 返回: subscription_id (string)
// 行为:注册订阅 → 监听 fs.watch → 匹配 filter → 调 handler → 等 ack

await bus.ack(subscriptionId, eventId, status);
// status: 'success' | 'rejected' | 'escalated'
// 行为:写 ack 标记到 subs.json (sub_id + event_id + status + acked_at)

await bus.list(filter?);
// filter?: { event_name?, since?, until?, correlation? }
// 返回: { events: [...], total, next_offset }
// 行为:读 events.jsonl(可读 archive 滚动后段) → 过滤 → 返回

await bus.history(subscriptionId, opts?);
// opts: { since?, until?, limit? }
// 返回: { acks: [...], events: [...], stats: { total, acked, retried, escalated } }
// 行为:读 events.jsonl + subs.json → 重建投递历史

// 工具方法
bus.close();
// 停 fs.watch,清资源

bus.busId;
// string, e.g. "macbook-pro-1:M-004"
```

### 4.2 `bin/cli.js` event-bus 子命令

```bash
# 1. publish(emit)
cortex-agent event-bus publish \
  --event-name subagent_spawned \
  --payload-json '{"subagent_role":"explore","task_description":"..."}' \
  --correlation-mission-id M-004 \
  --correlation-subagent-id sub-exp-001 \
  --correlation-parent-run-id R-M-004-001 \
  --producer-kind sub_agent \
  --producer-id sub-exp-001

# 2. subscribe(消费侧,通常 daemon 形式)
cortex-agent event-bus subscribe \
  --filter-event-names "subagent_completed,subagent_failed" \
  --filter-namespace "subagent_*" \
  --client parent-resume \
  --ack-timeout-ms 30000 \
  --retry-count 3

# 3. list-events(debug / dashboard)
cortex-agent event-bus list-events \
  --bus-id "macbook-pro-1:M-004" \
  --since "2026-08-02T00:00:00Z" \
  --event-name "subagent_completed" \
  --limit 100

# 4. history(某 subscription 的投递历史)
cortex-agent event-bus history \
  --subscription-id "sub-abc-123" \
  --since "2026-08-02T00:00:00Z"

# 5. bus-list(看当前 host 全部 bus 实例)
cortex-agent event-bus list-buses

# 6. archive-info(events.jsonl + archive 状态)
cortex-agent event-bus archive-info --bus-id "macbook-pro-1:M-004"
```

### 4.3 8 类 event 强类型 JSON schema(各 event payload 一套)

实施时每类 event 在 `lib/event-bus/event-types.js` 单独定义(同 §3.2 表)。每个 event 的 `payload` 必填字段已在 §3.2 列出,JSON Schema 在 `lib/event-bus/schemas/` 下分文件:

```
lib/event-bus/schemas/
  subagent_spawned.schema.json
  subagent_progress.schema.json
  subagent_completed.schema.json
  subagent_failed.schema.json
  subagent_cancelled.schema.json
  handoff_ready.schema.json
  decision_resolved.schema.json
  waitpoint_released.schema.json
  envelope.schema.json            # 共享 envelope (§3.2)
  extension.schema.json           # custom:* 扩展模板
```

### 4.4 parent-resume client API interface

```js
// 内部 contract,client 之间不暴露,event-bus 内部调
// 文件:lib/event-bus/clients/parent-resume.js

const client = createParentResumeClient({ bus, missionLease, sessionManager });
// missionLease: M-008 lease 接口
// sessionManager: M-008 session 接口

client.start();
// 注册到 bus.subscribe(filter, handler)
// filter: { event_names: ['subagent_completed', 'subagent_failed', 'subagent_cancelled'] }
// handler: 见 §3.3 FSM
// 行为:监听 sub-agent 生命周期事件 → 校验 mission lease → 读 sub-agent output →
//      调 sessionManager.resume(missionId, inject) → 在 mission 上下文 resume 父 agent

client.stop();
// 取消订阅,清资源
```

---

## 5. Persistence & Data Flow

### 5.1 目录结构

```
.agent/event-bus/<bus-id>/
  events.jsonl              # append-only event stream(必填)
  subs.json                 # 订阅者清单 + last_read_offset(必填)
  acks/                     # ack 标记(每 sub 一个文件)
    <subscription-id>.acks.jsonl
  archive/                  # 10MB cap 滚动后归档
    events-<timestamp>.jsonl.gz
    events-<timestamp>.jsonl.gz
  meta.json                 # bus 元信息(bus_id, created_at, last_event_id, schema_version)
  locks/                    # 内部单写者锁(避免多进程并发写 events.jsonl)
    write.lock
```

**例**:`.agent/event-bus/macbook-pro-1:M-004/events.jsonl`

### 5.2 events.jsonl 格式

每行一个 event(共享 envelope,见 §3.2):

```json
{"event_id":"eb-evt-a1b2c3d4-e5f6-7890-abcd-ef1234567890","event_name":"subagent_spawned","event_version":"1.0","bus_id":"macbook-pro-1:M-004","occurred_at":"2026-08-02T10:00:00.000Z","producer":{"producer_id":"sub-exp-001","producer_kind":"sub_agent","session_id":"S-M-004-sub-1"},"correlation":{"mission_id":"M-004","subagent_id":"sub-exp-001","parent_run_id":"R-M-004-001"},"payload":{"subagent_role":"explore","task_description":"find usages of normalize-token-usage","expected_duration_minutes":15,"tools_granted":["read","grep"],"model":"MiniMax-M3"}}
```

**append 行为**:
- 每次 publish 调 `fs.appendFile(events.jsonl, line + '\n')` + `fsync`(默认开)
- 单写者锁:`flock(fd, LOCK_EX)` 避免多进程并发写(M-004 fan-out 进程 + 主进程)
- 写入失败 → 抛 `event_bus_write_failed` + 写 retry(本地 fs 通常成功,3 次失败 escalate)
- 写完后 `fs.watch` 触发 → fan-out 投递

### 5.3 subs.json 格式

```json
{
  "version": 1,
  "subscriptions": [
    {
      "subscription_id": "sub-abc-123",
      "filter": {
        "event_names": ["subagent_completed", "subagent_failed"],
        "correlation": { "mission_id": "M-004" }
      },
      "handler": "parent-resume",
      "ack_timeout_ms": 30000,
      "retry_count": 3,
      "last_read_offset": 4096,
      "created_at": "2026-08-02T09:30:00.000Z",
      "last_ack_at": "2026-08-02T10:01:30.000Z"
    }
  ]
}
```

**`last_read_offset`**:byte offset,表示 subscription 已读 events.jsonl 到哪。fan-out 投递时只投 `offset > last_read_offset` 的新 event,避免重复投递。

### 5.4 持久化规则

| 规则 | 值 | 行为 |
| :--- | :--- | :--- |
| events.jsonl cap | 10MB | 超 cap → rotate 到 `archive/events-<ts>.jsonl.gz` |
| 单 bus 目录 cap | 100MB(可配) | 超 cap → 删最旧 archive(保留至少 1 个 archive) |
| fsync 策略 | 每次 publish 必 fsync | 强一致,牺牲吞吐换可靠(1000 events/sec baseline 仍满足) |
| 重启恢复 | bus 启动时读 meta.json + events.jsonl 末段 | 重建 in-memory state(events 索引 / subscription offset) |
| 文件锁 | 单写者 flock | 多进程并发安全(fan-out + publisher) |
| 备份 | 无(本地 fs 用户自管) | 跨 host 同步走 fan-out webhook,不依赖 fs 备份 |

### 5.5 ack 机制

```
[bus.publish] → events.jsonl (fsync)
[bus subscribe handler 调] → fan-out 投递到 client
[client handler 处理] → 返回 { ack: true|false, error? }
[bus 收到 ack] → 写 subs.json (subscription_id + event_id + acked_at + status)
[bus 未收到 ack within ack_timeout_ms] → 重投(最多 retry_count 次,默认 3)
[bus 重投 3 次仍失败] → 写 .agent/decisions/D-EB-ESCALATED-<event_id>.json
                     (status: open, severity: high, awaiting user intervention)
```

**关键 invariant**:ack 失败 = event 没成功投递 = 必须决策介入(不能 silently 丢弃)。重投机制防 transient failure(网络抖动 / client 暂时无响应)。

### 5.6 dedupe(去重)

event_id 唯一(uuid v4)。fan-out 投递时:
- 维护 `seen_event_ids` 集合(按 subscription 维度,容量 10000,LRU 淘汰)
- 同 event_id 多次 emit → 只首次有效(后续 skip + log `event_deduped`)
- bus 启动时从 events.jsonl 末段读最近 10000 event_id 重建 LRU

**重要**:sub-agent 重复执行(如重投导致 sub-agent 又跑一次)由 sub-agent 自身状态机防(已 DONE 不重跑),event-bus dedupe 是第二道保险。

### 5.7 数据流总览

```text
sub-agent 完成
  → emit subagent_completed event
  → bus.publish(校验 + event_id + append + fsync)
  → events.jsonl 写完
  → fs.watch 触发
  → fan-out 读 subs.json,匹配 subagent_completed + mission_id
  → parent-resume client.handle(event, ctx)
  → 校验 mission lease
  → 读 sub-agent output artifacts
  → sessionManager.resume(missionId, inject)
  → 父 agent 在 mission 上下文 resume
  → mission 继续推进
  → parent-resume ack
  → bus 写 ack 标记
  → 下次 publish 时 dedupe 跳过(seen)
```

---

## 6. Migration from subagent-trace

### 6.1 现有 subagent-trace 模式 → 新 event-bus 模式 映射

| 现有(subagent-trace v1) | 新(event-bus v2 / FAE-002) | 差异 |
| :--- | :--- | :--- |
| 显式 `emit --event subagent_completed --status success` | **自动** emit on sub-agent exit code 0 | 用户 0 操作 |
| 显式 `emit --event subagent_failed --status failed --notify-on-fail` | **自动** emit + 自动 inbox 父 | 不再需要 `--notify-on-fail` |
| 显式 `emit --event subagent_cancelled` | **自动** emit on SIGTERM / user cancel | 父 agent 取消后自动 emit |
| 显式 `emit --event subagent_progress` | **不变**(显式 emit,5-30s 间隔) | 心跳仍显式 |
| 显式 `emit --event subagent_spawned` | **自动** emit on FAE-001 dispatch 完成 | 派发时自动 |
| 写 `runs/<id>.json#subagent_fanout[]` | **双写**:events.jsonl + `runs/<id>.json#subagent_fanout[]` | 双源 |
| 读 `list` / `tree` | **不变**(从 subagent_fanout[] 读) | backward compat |
| 仅失败时 inbox 父 | **所有完成类事件都 inbox 父**(自动) | 新增能力 |
| 父 agent 主动 poll journal | **父端自动 subscribe + resume** | 范式转变 |

### 6.2 8 类 event 跟 subagent-trace 现有 4 类 event 对应

| 现有(subagent-trace 4 类) | 新(event-bus 8 类) | 备注 |
| :--- | :--- | :--- |
| `subagent_spawned` | `subagent_spawned` | 名字一致,触发从显式到自动 |
| `subagent_progress` | `subagent_progress` | 名字一致,仍显式 |
| `subagent_completed` (status: success / partial) | `subagent_completed` (status: success / partial) | 触发从显式到自动,加 ack 必填 |
| `subagent_completed` (status: failed) | `subagent_failed` (独立 event) | 语义独立,加 ack 必填 |
| `subagent_cancelled` | `subagent_cancelled` | 名字一致,触发从显式到自动 |
| — | `handoff_ready` | 新增(跨 host / session) |
| — | `decision_resolved` | 新增(decision 自动化) |
| — | `waitpoint_released` | 新增(waitpoint 自动化) |

### 6.3 关键:成功自动 emit(范式转变)

**现状**:sub-agent 跑完 exit 0 → 父 agent 不知道(除非父 poll)→ 父 agent 写「sub-agent 完成」进 mission 进度本(没自动信号)

**新模式**:
1. sub-agent exit 0 → framework 拦截 → 自动 `bus.publish(subagent_completed)` (status: success)
2. fan-out → parent-resume client 监听到
3. 父 agent 在 mission 上下文自动 resume
4. mission 继续推进

**自动 emit 触发点**(MS-002 subagent-trace 升级时实施):
- sub-agent sandbox / adapter 返回 exit code 0 → `subagent_completed`
- exit code != 0 → `subagent_failed`(带 error_code / error_message)
- 收到 SIGTERM / SIGINT / 父端 `cortex-agent dispatch cancel` → `subagent_cancelled`

### 6.4 Backward Compatibility(BC)

**BC 原则**:event-bus 是**新增写源** + **不破坏读侧**。

| BC 维度 | 现状 | FAE-002 改动 | BC 保证 |
| :--- | :--- | :--- | :--- |
| 读 `runs/<id>.json#subagent_fanout[]` | subagent-trace 写 | event-bus 双写到 subagent_fanout[] | **读侧接口 0 改动** |
| `subagent-trace list` / `tree` | 读 subagent_fanout[] | 同源 | **0 改动** |
| `subagent-trace emit --event subagent_completed` | 显式 | 仍接受(双写到 events.jsonl + subagent_fanout[]) | **不破坏**,但推荐改用 event-bus publish |
| 4 类 event 名字 | subagent_spawned / progress / completed / cancelled | event-bus 同名 + 加 4 类 | **同名 event 0 冲突** |
| `runs/<id>.json#events[]` 200 cap | subagent-trace 写 | event-bus 也写(双源) | 200 cap 仍生效 |
| M-008 journal 双源真相 | M-008 已有 | event-bus 增双源(events.jsonl + journal) | **双源同步协议**在 coordination-sync client |

**关键点**:已经 ship 的 subagent-trace skill **继续能用**,只是**推荐**升级到 event-bus(更可靠 + 自动 emit + 父端自动 resume)。host 显式 `subagent-trace emit` 调用不破坏。

### 6.5 升级路径

| 阶段 | 动作 | 时间 | 风险 |
| :--- | :--- | :--- | :--- |
| MS-001 实施 | lib/event-bus/ 新建 + 8 schema + tests | 1 周 | 0(纯加法) |
| MS-002 实施 | subagent-trace 升级为 event-bus client(自动 emit)+ bin/cli.js event-bus 子命令 | 3-4 天 | 低(默认行为不变,显式 emit 仍可用) |
| MS-003 实施 | parent-resume client + e2e 验证 | 1 周 | 中(新增能力,旧父 agent poll 路径不破) |
| MS-004 实施 | coordination-sync + dashboard-push + notification-pump | 1 周 | 低(双源) |
| MS-005 收口 | RFC v0.5 + release notes + AI-Brain 实战 2 月 | 1 周 + 2 月观察 | 中(实战长尾) |

---

## 7. Failure Modes & Recovery

### 7.1 5 类失败场景

| # | 场景 | Detection | Recovery | 严重度 |
| :--- | :--- | :--- | :--- | :---: |
| 1 | **events.jsonl 损坏**(磁盘满 / 进程 kill -9 / fsync 失败) | publish 抛 `event_bus_write_failed` + meta.json last_event_id 不更新 | 1) 备份当前 events.jsonl(.bak)→ 2) 从 meta.json last_event_id 重建 → 3) 重发丢失 event(从 publisher 端重发或写 decision 让人工补) → 4) 后续事件正常 | High |
| 2 | **ack 超时**(client handler 卡死 / 网络断) | `ack_timeout_ms` 默认 30s 触发 | 1) 重投(retry_count 默认 3)→ 2) 3 次失败后写 decision `D-EB-ESCALATED-<event_id>.json` (status: open, awaiting user) → 3) 同时 inbox 父 agent 提示「event <id> 投递失败需人工」 | High |
| 3 | **sub-agent 重复执行**(重投触发 sub-agent 重跑) | sub-agent 状态机检测(已 DONE 不重跑) | sub-agent 状态机返回 cached result,event-bus dedupe 第二道保险(seen_event_id skip) | Medium |
| 4 | **父 agent 误 resume**(resume 错 mission 上下文) | parent-resume FSM `CHECK_LEASE` 校验 mission_id + lease.held_by | 1) FSM 立即转 [LEASE_FAILED] → 2) 重试 3 次 → 3) 写 decision(`parent_resume_lease_mismatch`)→ 4) inbox 父 agent(正确 mission)提示 | High |
| 5 | **mavis 桥接断**(framework → mavis 推送失败) | bridge 客户端心跳超时 / 推送返回 5xx | 1) mavis bridge 重连 + 重传队列(本地 events.jsonl 仍 source of truth)→ 2) 5 次失败后降级到「framework 独立跑」模式(本 spec 主路径)→ 3) inbox 提示「mavis 桥接暂不可用,已自动降级」 | Medium |

### 7.2 性能边界

| 边界 | 值 | 触发动作 |
| :--- | :--- | :--- |
| events.jsonl cap | 10MB | rotate 到 archive,subs.json last_read_offset 保留 |
| 单 bus 目录 cap | 100MB(可配) | 删最旧 archive(保留 ≥ 1 个),warning inbox |
| events 吞吐 baseline | 1000 events / sec | 性能测试覆盖,baseline 满足 v1.x 实战 |
| 内存 LRU(seen_event_ids) | 10000 | 淘汰最旧,dedupe 仍按 fs offset 兜底 |
| fs.watch fallback poll | 1s | macOS / Linux / Windows 跨平台行为差异时降级到 polling |
| ack timeout | 30s(可配) | 超时重投 3 次 |
| 重投次数 | 3(可配) | 失败后写 decision |
| archive 压缩 | gzip(可配) | 默认开,降低磁盘 |

### 7.3 跨平台 fs.watch 行为差异

| 平台 | fs.watch 行为 | 降级 |
| :--- | :--- | :--- |
| macOS | FSEvents,支持 recursive,事件粒度粗 | 1s 兜底 polling |
| Linux | inotify,粒度细,recursive 需手动 | inotify 单层 + 1s polling |
| Windows | ReadDirectoryChangesW,行为差异 | polling(0.5s) |

**实施策略**:`lib/event-bus/fs-watcher.js` 抽象 `fs.watch` + `setInterval(poll)`,根据 platform + 错误率自动选最优。性能测试覆盖三平台。

### 7.4 灾难恢复

| 灾难 | 数据丢失 | Recovery |
| :--- | :--- | :--- |
| 磁盘损坏 | 全部 event 丢失 | 跨 host fan-out 副本(用户自配);无副本则重建 mission context 从 artifacts/ 读 |
| events.jsonl 损坏 | 部分 event 丢失 | meta.json last_event_id + publisher 端重发 |
| subs.json 损坏 | subscription 列表丢失 | 从 client 注册表重建(每个 client 启动时注册) |
| archive 损坏 | 历史 event 丢失 | 当前活跃 event 在 events.jsonl 不影响,只丢历史 |

**核心原则**:**events.jsonl 是 source of truth**,任何损坏场景优先恢复 events.jsonl + meta.json。subs / acks / archive 是 derived,丢可重建。

---

## 8. Test Strategy

### 8.1 5 类核心测试

| # | 测试类别 | 覆盖 | 工具 | 目标 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **publish** | 1) schema 校验(8 类 + 扩展)/ 2) event_id 唯一 / 3) append + fsync / 4) 文件锁并发 / 5) 失败回滚 | `node --test tests/event-bus-publish.test.js` | 30 cases |
| 2 | **subscribe** | 1) filter 匹配(event_names / namespace / correlation)/ 2) handler 调 / 3) ack 写 / 4) fs.watch 触发 / 5) 跨平台 fs.watch 行为 | `tests/event-bus-subscribe.test.js` | 25 cases |
| 3 | **ack** | 1) ack success / 2) ack timeout 重投 / 3) 3 次失败 escalate decision / 4) ack rejected / 5) ack 写持久化 | `tests/event-bus-ack.test.js` | 20 cases |
| 4 | **dedupe** | 1) 同 event_id 多次 publish 只首次 / 2) LRU 容量 / 3) 重启后 LRU 重建 | `tests/event-bus-dedupe.test.js` | 10 cases |
| 5 | **持久化** | 1) cap 10MB 滚动 archive / 2) 100MB 总 cap 删最旧 / 3) 重启恢复(events.jsonl 末段)/ 4) meta.json 一致性 / 5) flock 并发 | `tests/event-bus-persistence.test.js` | 20 cases |

**总**:5 类 / 105 cases。100% pass 阈值。

### 8.2 端到端测试(E2E)

**场景 1:派发 sub-agent → 完成 → 父 agent 自动 resume mission**

```text
given: M-004 mission running, 父 agent lease 持有, 准备派 3 个 sub-agent
when:
  1. 父 agent 调 cortex-agent dispatch sub-exp-001 ...
  2. 父 agent 调 cortex-agent dispatch sub-exp-002 ...
  3. 父 agent 调 cortex-agent dispatch sub-exp-003 ...
  4. 3 个 sub-agent 并行执行,各自 emit subagent_progress 心跳
  5. sub-exp-001 完成(emit subagent_completed status: success)
  6. sub-exp-002 完成(emit subagent_completed status: success)
  7. sub-exp-003 失败(emit subagent_failed status: failed)
then:
  - 3 个 event 写入 events.jsonl
  - parent-resume client 监听 → 校验 mission lease → 读 sub-agent output → resume 父 agent
  - 父 agent 在 mission 上下文收到「sub-exp-001/002 completed, sub-exp-003 failed」
  - mission 状态机推进:3 个 sub-agent 全部 done(2 成功 + 1 失败)→ 父 agent 决策 1 失败可接受 / 不可接受
  - 写 mission_progress.json 更新
verify:
  - 父 agent session_id 一致(同一 session resume,不是新 session)
  - 3 个 ack 全成功(无 escalate)
  - mission_progress.json updated_at 新
```

**场景 2:sub-agent 失败 → 自动 inbox 父 + 决策介入**

```text
given: M-004 mission running
when:
  1. 父 agent dispatch sub-writer-001 写 RFC 草稿
  2. sub-writer-001 失败(emit subagent_failed error_code: 'rfc_validation_failed')
then:
  - subagent_failed event 写 events.jsonl
  - parent-resume 收到 → 校验 mission → resume 父
  - 父 agent 看到 failure,决策 retry / 跳过 / escalate
  - 写 decision (open / approved / rejected)
verify:
  - 失败 event 必 ack(不能 silently 丢)
  - decision 写盘
  - 父 agent mission 状态机正确推进
```

**场景 3:ack 超时 → 重投 3 次 → escalate decision**

```text
given: parent-resume client 故意 sleep 60s(超过 ack_timeout_ms=30s)
when:
  1. publish subagent_completed
  2. fan-out 投递到 parent-resume
  3. 30s 未 ack
  4. 重投 1 次(再 30s 未 ack)
  5. 重投 2 次
  6. 重投 3 次
  7. 仍失败 → 写 decision
then:
  - decision 文件存在(.agent/decisions/D-EB-ESCALATED-<event_id>.json)
  - decision status: open
  - inbox 提示父 agent
verify:
  - 重投次数 = 3(可配,默认)
  - decision severity: high
```

### 8.3 性能 Benchmark

| 指标 | 目标 | 工具 |
| :--- | :--- | :--- |
| publish 吞吐 | ≥ 1000 events / sec(单 bus 单 publisher) | `tests/event-bus-perf-publish.test.js`(用 `node --test` 测耗时) |
| subscribe 端到端延迟 | ≤ 100ms(publish 到 handler 调,本地) | `tests/event-bus-perf-latency.test.js` |
| archive rotate 耗时 | ≤ 200ms(events.jsonl 达 10MB 触发) | `tests/event-bus-perf-archive.test.js` |
| 内存占用 | ≤ 50MB(bus in-memory state + 10000 event LRU) | process.memoryUsage() 在测试中检查 |

**性能 baseline 验证**:`tests/event-bus-perf-bench.test.js` 跑 10000 events 测总耗时,目标 ≤ 10s(1000 events/sec)。

### 8.4 Backward Compatibility 测试

| 维度 | 测试 | 工具 |
| :--- | :--- | :--- |
| subagent-trace emit 仍能用 | `tests/event-bus-bc-subagent-trace.test.js` 显式 emit 4 类 event | node --test |
| `runs/<id>.json#subagent_fanout[]` 读侧 | 显式 emit → 读 list / tree(走 subagent-trace 旧读侧) | 端到端 |
| `runs/<id>.json#events[]` 200 cap | emit 250 个 event → 验 events[] 长度 = 200 | node --test |
| M-008 journal 双源 | event-bus publish → M-008 journal 也写(coordination-sync client) | 端到端 |
| FAE-001 dispatch 升级 | dispatch 命令 → 自动 emit subagent_spawned | 端到端 |

**核心断言**:**所有现有测试(272+ regression 套件)+ 新 event-bus 5 类测试,0 新增 fail**。

### 8.5 集成测试环境

- **dev**:本地 fs + 1 个 bus 实例 + 1 个 sub-agent(沙箱)
- **staging**:跨 host 2 个 bus(本机 + 远端 dev)+ 3 个 sub-agent(并发)
- **prod-lite**:模拟 mission(主 agent 派 5 sub-agent)+ 真实 ack + escalation

测试数据放在 `tests/fixtures/event-bus/`,每个 test 独立 bus(避免污染)。

---

## 9. 关键决策(5 项,Eric 2026-08-01 拍板,选 A 全部默认)

| # | 决策点 | 拍板结果(A) | 备选(B / C) | 风险 / 缓解 |
| :--- | :--- | :--- | :--- | :--- |
| **D-FAE-002-1** | **启动条件** | M-002 + M-003 完成后启动,4-5 周 mission | (B) M-001 后立即启动 6-7 周 mission | A 风险:延迟启动;缓解:并行 M-002/M-003 不阻塞 M-004 spec 阶段 |
| **D-FAE-002-2** | **事件总线存储** | 纯 JSONL(零依赖,简单,local-fs 优先) | (B) SQLite(查询强,需破零依赖) | A 风险:大 event 量查询慢;缓解:subs.json offset + archive 滚动,查询 100MB 内仍快 |
| **D-FAE-002-3** | **fan-out 进程形态** | 可选(默认纯 push — publisher fsync 后本地推 sub 客户端,无独立 fan-out 进程) | (B) 强制 fan-out 进程 | A 风险:跨 host 同步需用户起 fan-out;缓解:默认本地纯 push 满足 v1.x 实战,跨 host 是 Phase 5 future |
| **D-FAE-002-4** | **parent-resume 失败回滚** | 3 次重试 + 写 decision 让人工介入 | (B) 无限重试(可能 hang) | A 风险:false positive escalate;缓解:retry backoff 5s/15s/30s,3 次失败后 inbox 父 + 写 decision |
| **D-FAE-002-5** | **与 mavis 平台事件桥接** | 双向桥(mavis task tool 完成 → emit eb:task_completed;反之亦然) | (B) 单向 framework → mavis | A 风险:桥接复杂度;缓解:bridge client 独立模块,失败降级到「framework 独立跑」模式 |

**5 决策落地总结**:
1. **M-004 启动**:等 M-002 + M-003 完,4-5 周 mission 实施
2. **存储**:JSONL(events.jsonl + subs.json + archive/),0 npm install
3. **fan-out**:可选(默认纯 push),用户起 fan-out 才有投递保证
4. **失败**:3 次重试 + decision 介入
5. **mavis 桥接**:双向,失败降级

---

## 10. 端到端示例:主 agent 派 3 sub-agent 并行 → 父 agent 自动 resume

### 10.1 场景描述

**Mission**:M-004(FAE-002 spec 阶段后续)— 假设 M-004 实施中,父 agent(架构协调人)派 3 个 sub-agent 并行:
- `sub-exp-001`(explore):扫描现有 FAE-002 spec 引用文档,产出引用清单
- `sub-writer-001`(writer):写 M-004 mission-plan.md 草稿
- `sub-reviewer-001`(reviewer):review RFC v0.3 §17.4 段,产出 review comment

**目标**:3 个 sub-agent 并行完成 → 父 agent 自动 resume → 整合结果 → 推进到下个 milestone(MS-001 实施准备)。

### 10.2 完整 JSON Trace

```json
// === T+0ms: 父 agent 启动 mission M-004 ===

// 1. 父 agent publish mission_started(扩展 event,演示 extension namespace)
{
  "event_id": "eb-evt-00100000-aaaa-bbbb-cccc-000000000001",
  "event_name": "custom:mission_started",
  "event_version": "1.0",
  "bus_id": "macbook-pro-1:M-004",
  "occurred_at": "2026-08-02T10:00:00.000Z",
  "producer": { "producer_id": "parent-agent-M-004", "producer_kind": "parent_agent", "session_id": "S-M-004" },
  "correlation": { "mission_id": "M-004", "subagent_id": "host", "parent_run_id": "R-M-004-001" },
  "payload": { "mission_plan_ref": ".agent/missions/M-004/mission-plan.md", "total_milestones": 5 }
}

// 2-4. 父 agent 派 3 个 sub-agent,各自动 emit subagent_spawned
{
  "event_id": "eb-evt-00200000-aaaa-bbbb-cccc-000000000001",
  "event_name": "subagent_spawned",
  "event_version": "1.0",
  "bus_id": "macbook-pro-1:M-004",
  "occurred_at": "2026-08-02T10:00:01.000Z",
  "producer": { "producer_id": "parent-agent-M-004", "producer_kind": "parent_agent" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-exp-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "subagent_role": "explore",
    "task_description": "扫描 FAE-002 spec 引用文档,产出 5 个必读文件清单",
    "tools_granted": ["read", "grep"],
    "model": "MiniMax-M3",
    "expected_duration_minutes": 10
  }
}
{
  "event_id": "eb-evt-00200000-aaaa-bbbb-cccc-000000000002",
  "event_name": "subagent_spawned",
  "event_version": "1.0",
  "bus_id": "macbook-pro-1:M-004",
  "occurred_at": "2026-08-02T10:00:01.050Z",
  "producer": { "producer_id": "parent-agent-M-004", "producer_kind": "parent_agent" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-writer-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "subagent_role": "writer",
    "task_description": "写 M-004 mission-plan.md 草稿(基于 FAE-002 spec + M-001 模板)",
    "tools_granted": ["read", "write", "bash"],
    "model": "MiniMax-M3",
    "expected_duration_minutes": 20
  }
}
{
  "event_id": "eb-evt-00200000-aaaa-bbbb-cccc-000000000003",
  "event_name": "subagent_spawned",
  "event_version": "1.0",
  "bus_id": "macbook-pro-1:M-004",
  "occurred_at": "2026-08-02T10:00:01.100Z",
  "producer": { "producer_id": "parent-agent-M-004", "producer_kind": "parent_agent" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-reviewer-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "subagent_role": "reviewer",
    "task_description": "review RFC v0.3 §17.4 段,产出 review comment 列表",
    "tools_granted": ["read", "grep"],
    "model": "MiniMax-M3",
    "expected_duration_minutes": 15
  }
}

// === T+5s ~ T+8min: 3 个 sub-agent 并行执行,emit 心跳 ===

// 5. sub-exp-001 心跳 30%
{
  "event_id": "eb-evt-00300000-aaaa-bbbb-cccc-000000000001",
  "event_name": "subagent_progress",
  "occurred_at": "2026-08-02T10:00:30.000Z",
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-exp-001", "parent_run_id": "R-M-004-001" },
  "payload": { "percent": 30, "current_step": "scanning proposals/FAE-002", "tool_calls_count": 5 }
}

// 6. sub-writer-001 心跳 25%
{
  "event_id": "eb-evt-00300000-aaaa-bbbb-cccc-000000000002",
  "event_name": "subagent_progress",
  "occurred_at": "2026-08-02T10:01:00.000Z",
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-writer-001", "parent_run_id": "R-M-004-001" },
  "payload": { "percent": 25, "current_step": "drafting mission-plan.md header", "tool_calls_count": 3 }
}

// ... (略去中间心跳,5-30s 间隔)

// === T+8min: sub-exp-001 完成(最早) ===

// 7. sub-exp-001 自动 emit subagent_completed(success)
{
  "event_id": "eb-evt-00400000-aaaa-bbbb-cccc-000000000001",
  "event_name": "subagent_completed",
  "occurred_at": "2026-08-02T10:08:00.000Z",
  "producer": { "producer_id": "sub-exp-001", "producer_kind": "sub_agent", "session_id": "S-sub-exp-001" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-exp-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "status": "success",
    "output_summary": "5 个必读文件扫描完成:FAE-002 提案(11KB) / RFC v0.3 §17 / M-008 mission plan / subagent-trace SKILL / FAE-001 词汇",
    "output_artifact_refs": [".agent/missions/M-004/evidence/fae-002-references.md"],
    "duration_actual_seconds": 480,
    "transcript_ref": ".agent/runs/R-M-004-sub-exp-001.json"
  }
}

// === T+12min: sub-reviewer-001 完成 ===

// 8. sub-reviewer-001 自动 emit subagent_completed(success)
{
  "event_id": "eb-evt-00400000-aaaa-bbbb-cccc-000000000002",
  "event_name": "subagent_completed",
  "occurred_at": "2026-08-02T10:12:00.000Z",
  "producer": { "producer_id": "sub-reviewer-001", "producer_kind": "sub_agent", "session_id": "S-sub-reviewer-001" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-reviewer-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "status": "success",
    "output_summary": "RFC v0.3 §17.4 review 完成,3 个 comment(2 minor + 1 follow-up)",
    "output_artifact_refs": [".agent/missions/M-004/evidence/rfc-v0.3-sec17-review.md"],
    "duration_actual_seconds": 720
  }
}

// === T+18min: sub-writer-001 失败(rfc_validation 错) ===

// 9. sub-writer-001 自动 emit subagent_failed
{
  "event_id": "eb-evt-00400000-aaaa-bbbb-cccc-000000000003",
  "event_name": "subagent_failed",
  "occurred_at": "2026-08-02T10:18:00.000Z",
  "producer": { "producer_id": "sub-writer-001", "producer_kind": "sub_agent", "session_id": "S-sub-writer-001" },
  "correlation": { "mission_id": "M-004", "subagent_id": "sub-writer-001", "parent_run_id": "R-M-004-001" },
  "payload": {
    "status": "failed",
    "error_code": "rfc_validation_failed",
    "error_message": "mission-plan.md 缺 '决策项' 段(M-001 模板强制)",
    "retry_count": 1,
    "last_tool_failure": "write: file content missing required section '决策项'",
    "output_partial_summary": "已写 4 段(header / goal / non-goals / scope),缺 '决策项' 段"
  }
}

// === fan-out 投递 + parent-resume 触发 ===

// 10. fan-out 读到 3 个 subagent_* event,匹配 parent-resume 订阅,投递
// 11. parent-resume FSM:
//     - 3 个 event 校验通过
//     - mission_id = "M-004" + lease.held_by = "parent-agent-M-004" 校验通过
//     - 读 sub-agent output artifacts
//     - 注入父 agent prompt: "[EVENT-BUS] M-004 sub-agent 状态更新:
//       - sub-exp-001: success, 5 必读文件清单
//       - sub-reviewer-001: success, RFC v0.3 §17.4 review 3 comment
//       - sub-writer-001: failed, error: rfc_validation_failed, partial output: 4 段缺 '决策项'
//       继续 M-004 当前 milestone(MS-001 实施准备)推进。"
//     - sessionManager.resume(missionId, inject) → 父 agent 在 mission 上下文 resume

// 12. 父 agent 决策:sub-writer-001 失败可重试(补 '决策项' 段),调 cortex-agent dispatch sub-writer-002 重跑
// 13. sub-writer-002 完成 → emit subagent_completed(success)
// 14. 父 agent 收到第 4 个 sub-agent 完成 → 整合 3 + 1 = 4 sub-agent 结果
// 15. 父 agent 写 mission_progress.json
// 16. 父 agent emit mission_completed(扩展 event)
{
  "event_id": "eb-evt-00900000-aaaa-bbbb-cccc-000000000001",
  "event_name": "custom:mission_completed",
  "occurred_at": "2026-08-02T10:35:00.000Z",
  "producer": { "producer_id": "parent-agent-M-004", "producer_kind": "parent_agent" },
  "correlation": { "mission_id": "M-004", "subagent_id": "host", "parent_run_id": "R-M-004-001" },
  "payload": {
    "milestones_completed": ["MS-001-prep"],
    "sub_agents_total": 4,
    "sub_agents_succeeded": 4,
    "sub_agents_failed": 0,
    "duration_actual_minutes": 35
  }
}
```

### 10.3 端到端验证(MS-003 实施时跑)

**关键断言**:
1. ✅ events.jsonl 含完整 7 + N 个 event(7 个 core + 1+ 个 extension)
2. ✅ 3 个 sub-agent 完成后,父 agent session_id **未变**(同一 session resume)
3. ✅ parent-resume FSM 全程无 escalate(3 ack 全 success,含 sub-writer-001 重投后 ack)
4. ✅ mission_progress.json updated_at = mission_completed 时间
5. ✅ dedupe 工作:sub-writer-001 重试时,同 subagent_id 的 subagent_spawned 第二次 emit 被 dedupe skip(seen event_id 集合)
6. ✅ 跨平台 fs.watch 行为:macOS / Linux 都能监听到 events.jsonl 增量
7. ✅ 性能:总耗时 ≤ 35 min,publish 吞吐 ≥ 100 events / sec 满足

**关键 invariant 验证**:
- **parent-resume 在 mission 上下文**:父 agent 看到的 prompt 含 `继续 M-004 当前 milestone(MS-001 实施准备)推进`,不是新 mission
- **8 类 event 强 schema**:每个 event publish 校验通过,任何 schema 错直接拒绝 + 写 error
- **ack 必填**:subagent_completed / subagent_failed 不 ack → 3 次重投 → escalate decision(本 e2e 全 success,无 escalate)

---

## 11. Spec 阶段交付与下阶段交接

### 11.1 本 spec 文档范围

| 文件 | 行数 | 内容 |
| :--- | :--- | :--- |
| `docs/architecture/framework-event-bus-design.md` | ~700 行(本文件) | 8 章节 + 5 决策 + 1 e2e(完整) |
| `docs/architecture/framework-event-bus-quickstart.md` | ~200 行(姊妹文件) | examples + quick start(MS-002 实施时同时写) |

### 11.2 后续 M-004 实施阶段准备

| MS | 内容 | 估时 | 依赖本 spec 章节 |
| :--- | :--- | :--- | :--- |
| MS-001 | lib/event-bus/ 核心 + 8 schema + tests | 1 周 | §3 / §4 / §5 / §8.1(测试 1-5) |
| MS-002 | subagent-trace 升级 + bin/cli.js event-bus 子命令 | 3-4 天 | §4.2 / §6(迁移路径) |
| MS-003 | parent-resume client + e2e 验证 | 1 周 | §3.3(FSM)/ §8.2(e2e 场景)/ §10(端到端示例) |
| MS-004 | coordination-sync + dashboard-push + notification-pump | 1 周 | §4.1 / §4.4(client 接口) |
| MS-005 | RFC v0.5 + release notes + AI-Brain 实战 2 月 | 1 周 + 2 月观察 | §11(交付清单)+ AI-Brain 端验证 |

### 11.3 Eric Review 关注点

| # | 关注点 | 本 spec 段落 |
| :--- | :--- | :--- |
| 1 | 8 类 event 定义是否完备 | §3.2 / §4.3 |
| 2 | parent-resume 行为细节(必须 resume 父 agent 在 mission 上下文) | §3.3 |
| 3 | event bus id 命名规则 | §3.4 |
| 4 | ack 失败处理(3 次重试 + decision) | §5.5 / §7.1 场景 2 / §9 D-FAE-002-4 |
| 5 | mavis 双向桥接 | §4.4 / §7.1 场景 5 / §9 D-FAE-002-5 |
| 6 | 5-6 周 mission 估时 | §11.2 |
| 7 | 0 npm install 承诺 | §2.1 / §3.1(全 stdlib)/ §5.2 |
| 8 | Backward compat 完整 | §6.4 |
| 9 | 端到端示例可跑 | §10(JSON trace + 7 关键断言) |
| 10 | 5 决策与提案一致 | §9(5 项 + 拍板时间 + 备选 + 风险) |

---

## 12. 关联文档

- **RFC v0.3**: `docs/architecture/general-mode-design.md` §17.1 - §17.6(v2.0 愿景 + 启动条件)
- **FAE-002 提案**: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-002-framework-event-bus.md` (11 KB, 16 决策已拍)
- **FAE-001 词汇**: `.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-001-dispatch-vocabulary.md` (复用 Dispatch / Daemon / Trigger)
- **M-008 mission artifacts**: `.agent/missions/M-008/{mission-plan.md, validation-contract.json, milestones/*.md}` (coordination runtime 复用)
- **subagent-trace SKILL**: `.agent/skills/subagent-trace/SKILL.md` (升级目标)
- **handoff-protocol**: `.agent/handoffs/scripts/handoff-protocol.js` (M-004 spec 阶段交付用)
- **progress-lock**: `.agent/locks/scripts/progress-lock.js`
- **agent-registry**: `.agent/registry/scripts/agent-registry.js`

---

## 13. Status 跟踪

- [x] 2026-08-02 起草(detail design,8 章节 + 5 决策 + 1 e2e)
- [ ] Eric review(预计 2026-08-04,周一)
- [ ] Eric 拍板 + 升 `spec-approved`
- [ ] M-004 mission plan 起草 + 16 决策 lock
- [ ] M-004 mission 启动(MS-001 → MS-005,5-6 周)
- [ ] v1.x + v2.0 启动条件 #5 满足

---

> **本 spec 作为 M-004 实施 mission 的实施依据**。批准后,Worker-F 移交主 session,主 session 派发 M-004(MS-001 由 Worker-G 实施,3-4 周完成核心 8 schema + tests + persistence)。
