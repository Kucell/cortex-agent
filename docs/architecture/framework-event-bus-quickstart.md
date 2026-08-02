# Framework Event Bus — Quickstart

> **Spec**: `docs/architecture/framework-event-bus-design.md` (8 章节 detail design)
> **Status**: `spec-draft` (待 Eric review)
> **Audience**: framework 实施者 + 集成 host adapter 的开发者 + mission 编排者

本 quickstart 给实施者一个 5 分钟入门。完整 spec 见姊妹文件 `framework-event-bus-design.md`。

---

## 1. 一句话总结

**FAE-002 = 把 cortex-agent framework 从「显式 emit + 半自动 inbox + journal 轮询」升级为「真事件总线 + sub-agent 自动 emit + 父端自动 subscribe & resume」**。

---

## 2. 5 分钟入门

### 2.1 publish 一个 event

```js
// 父 agent 派发 sub-agent 后,自动 emit subagent_spawned
const { createEventBus } = require("../../../lib/event-bus/event-bus.js");

const bus = createEventBus({
  busId: "macbook-pro-1:M-004",
  dataDir: ".agent/event-bus",
});

const result = await bus.publish(
  {
    event_name: "subagent_spawned",
    payload: {
      subagent_role: "explore",
      task_description: "扫描 FAE-002 spec 引用文档",
    },
  },
  {
    producer: { producer_id: "parent-agent-M-004", producer_kind: "parent_agent" },
    correlation: {
      mission_id: "M-004",
      subagent_id: "sub-exp-001",
      parent_run_id: "R-M-004-001",
    },
  }
);

console.log(result);
// { ok: true, event_id: "eb-evt-a1b2c3d4-...", persisted_at: "2026-08-02T10:00:01.000Z" }
```

### 2.2 subscribe 监听 event

```js
// 父 agent 端(parent-resume client)订阅 sub-agent 完成事件
const subscriptionId = await bus.subscribe(
  {
    event_names: ["subagent_completed", "subagent_failed", "subagent_cancelled"],
    correlation: { mission_id: "M-004" },
  },
  async (event, ctx) => {
    // 在这里实现父 agent 自动 resume mission 逻辑
    console.log(`[EVENT-BUS] ${event.event_name} for ${event.correlation.subagent_id}`);

    // 校验 mission lease / 读 sub-agent output / resume 父 agent
    const output = await readSubAgentOutput(event.correlation.subagent_id);
    await sessionManager.resume(event.correlation.mission_id, {
      inject: `[EVENT-BUS] subagent ${event.correlation.subagent_id} ${event.event_name}. output: ${output.summary}`,
    });

    return { ack: true };
  },
  { ackTimeoutMs: 30000, retryCount: 3 }
);
```

### 2.3 CLI 形式

```bash
# publish
cortex-agent event-bus publish \
  --event-name subagent_spawned \
  --payload-json '{"subagent_role":"explore","task_description":"..."}' \
  --correlation-mission-id M-004 \
  --correlation-subagent-id sub-exp-001 \
  --producer-kind parent_agent

# subscribe(daemon 形式,parent-resume client 内部用)
cortex-agent event-bus subscribe \
  --filter-event-names "subagent_completed,subagent_failed" \
  --client parent-resume

# 看 bus 历史
cortex-agent event-bus list-events --bus-id "macbook-pro-1:M-004" --limit 50
```

---

## 3. 8 类 Core Event 一览

| Event | 触发 | ack? | 主要订阅者 |
| :--- | :--- | :---: | :--- |
| `subagent_spawned` | 派发时(自动) | 否 | dashboard, coordination |
| `subagent_progress` | 心跳(显式 5-30s) | 否 | dashboard |
| `subagent_completed` | 成功(自动) | **是** | parent-resume, dashboard |
| `subagent_failed` | 失败(自动) | **是** | parent-resume, notification-pump |
| `subagent_cancelled` | 取消(自动) | 否 | coordination, dashboard |
| `handoff_ready` | 跨 host/session(自动) | 否 | parent-resume(跨 host) |
| `decision_resolved` | decision resolve(自动监听) | 否 | coordination, dashboard |
| `waitpoint_released` | waitpoint 释放(自动监听) | 否 | coordination, parent-resume |
| `custom:*` | host 扩展(显式) | 否 | 自定义 |

**完整 schema**:见 `framework-event-bus-design.md` §3.2 + `lib/event-bus/schemas/`。

---

## 4. 目录结构

```
.agent/event-bus/<bus-id>/
  events.jsonl              # append-only event stream
  subs.json                 # 订阅者清单 + offset
  acks/<sub-id>.acks.jsonl  # ack 标记
  archive/events-*.jsonl.gz # 10MB cap 滚动
  meta.json                 # bus 元信息
```

**例**:`.agent/event-bus/macbook-pro-1:M-004/events.jsonl`

---

## 5. 关键 Invariant

1. **events.jsonl 是 source of truth** — 任何损坏场景优先恢复 events.jsonl
2. **ack 必填**(subagent_completed / subagent_failed)— 不 ack → 3 次重投 → escalate decision
3. **parent-resume 必在 mission 上下文 resume 父 agent** — 不是 spawn 新 agent
4. **dedupe by event_id** — 同 event_id 多次 emit 只首次有效
5. **0 npm install** — 纯 node:fs.watch + JSONL + node:fs/promises
6. **backward compat** — `runs/<id>.json#subagent_fanout[]` 读侧接口 0 改动

---

## 6. 实施路径

| MS | 估时 | 内容 | 依赖本 quickstart |
| :--- | :--- | :--- | :--- |
| MS-001 | 1 周 | lib/event-bus/ 核心 + 8 schema + tests | §2.1 / §2.2 / §3 / §4 |
| MS-002 | 3-4 天 | subagent-trace 升级(自动 emit)+ bin/cli.js event-bus 子命令 | §2.3 |
| MS-003 | 1 周 | parent-resume client + e2e 验证 | §2.2 + §5 invariant 3 |
| MS-004 | 1 周 | coordination-sync + dashboard-push + notification-pump | §3 订阅者映射 |
| MS-005 | 1 周 | RFC v0.5 + release notes + AI-Brain 实战 2 月 | (收口) |

---

## 7. 常见错误

### 7.1 误把 subagent_completed 当不需 ack

```js
// ❌ 错:handler 抛异常没 ack → 3 次重投 + escalate
async (event) => {
  processEvent(event); // throw 抛异常
  return { ack: true }; // 不会执行到
}

// ✅ 对:try-catch 包,失败 return { ack: false, error }
async (event) => {
  try {
    await processEvent(event);
    return { ack: true };
  } catch (e) {
    return { ack: false, error: e };
  }
}
```

### 7.2 误 spawn 新 agent 而不是 resume 父

```js
// ❌ 错:spawn 新 agent 接管(状态机断)
async (event) => {
  await spawnNewAgent("handle-event", { event });
  return { ack: true };
}

// ✅ 对:在 mission 上下文 resume 父 agent
async (event) => {
  await sessionManager.resume(event.correlation.mission_id, { inject: ... });
  return { ack: true };
}
```

### 7.3 误用大 payload(events.jsonl cap 10MB)

```js
// ❌ 错:1MB 大 payload 写 events.jsonl
await bus.publish({
  event_name: "subagent_completed",
  payload: { output_summary: "...1MB text..." },
});

// ✅ 对:大 output 写 artifact 引用,events.jsonl 只存路径
await bus.publish({
  event_name: "subagent_completed",
  payload: {
    output_summary: "5 必读文件清单",
    output_artifact_refs: [".agent/missions/M-004/evidence/fae-002-references.md"],
  },
});
```

---

## 8. 测试 quick check

```bash
# 跑 5 类核心测试
node --test tests/event-bus-publish.test.js
node --test tests/event-bus-subscribe.test.js
node --test tests/event-bus-ack.test.js
node --test tests/event-bus-dedupe.test.js
node --test tests/event-bus-persistence.test.js

# 跑 e2e(MS-003 实施时启用)
node --test tests/event-bus-e2e.test.js

# 跑 perf benchmark
node --test tests/event-bus-perf-bench.test.js

# 跑 backward compat
node --test tests/event-bus-bc-subagent-trace.test.js
```

**总**:5 + 1 + 1 + 1 = 8 测试套件,105+ cases。

---

## 9. 故障排查

| 症状 | 原因 | 修复 |
| :--- | :--- | :--- |
| publish 抛 `event_bus_write_failed` | 磁盘满 / flock 死锁 | `df -h` + `fuser <events.jsonl>`;删 archive / 释放 flock |
| handler 不触发 | fs.watch 跨平台行为差异 | 启用 polling fallback(1s) |
| ack 超时疯狂重投 | client handler 卡死 | 加 `console.time` 在 handler 测耗时 |
| dedupe 跳太多 | LRU 容量 10000 不够 | 调 `opts.lruCapacity`(需 spec 改) |
| parent-resume 进错 mission | mission_id 拼错 | 检查 `event.correlation.mission_id` 一致性 |
| mavis 桥接断 | mavis 服务端 5xx | bridge 自动重连 5 次后降级 framework 独立跑 |

---

## 10. 关联文档

- **主 spec**:`docs/architecture/framework-event-bus-design.md`(8 章节 + 5 决策 + 1 e2e)
- **提案**:`.agent/plans/proposals/projects/full-automation-evolution/proposals/FAE-002-framework-event-bus.md`
- **RFC v0.3**:`docs/architecture/general-mode-design.md` §17
- **M-008**:`.agent/missions/M-008/`
- **subagent-trace**:`.agent/skills/subagent-trace/SKILL.md`

---

> 实施开始后,本 quickstart 与主 spec 同步更新。MS-001 实施完成后,补 `lib/event-bus/` 实际 API doc(JSDoc)。
