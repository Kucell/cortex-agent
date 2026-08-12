---
name: automation-pipeline
description: "P-006 Cross-Project Automation Pipeline — 把 'proposal 审批 → mission 落地 → inbox 监听 → 自动 dispatch → mission 完成 → 自动 emit 下一个项目' 串成零人工闭环。"
type: procedure
applicable_to:
  - all
inputs:
  - proposal: "必填。已 approved 的 proposal markdown 路径(含 YAML frontmatter,含 cross_project_peers + source_project_id)。"
  - mission: "可选。mission id。默认从 proposal title 派生(M-<TITLE-HASH>-<xxhash>)。"
  - host_root: "必填。目标项目根路径。"
  - handler_id: "可选。.agent/bridges/<handler_id>.json 配置文件名。"
  - source_project_id: "可选。当前项目 self-id,写入 mission frontmatter bridge_emit_on_done.source。"
  - event_type: "可选。emit 时使用的 bridge event_type(默认 checkpoint.closed)。"
  - correlation_group: "可选。订阅/emit 时使用的关联组(例如 agentic-ui-delivery)。"
outputs:
  - "目标项目 .agent/missions/<mission>/{mission-plan.md, validation-contract.json, command-log.md, handoffs/README.md}"
  - ".agent-runtime/cross-project/outbox/<source_project_id>/<event-id>.json  (emit)"
  - ".agent-runtime/cross-project/inbox/<source>/<event-id>.json       (sync)"
  - ".agent/missions/<target_mission>/<bridge_event_id>-<rand>.dispatch-pending.json  (watch-inbox)"
linked_skills:
  - experience-recall
prerequisites:
  - "源项目和目标项目都已 `topology init <project_id> --host-root` 注册 (P-001A)"
  - "源项目和目标项目都已订阅到 topology (P-001 §topology list 可见)"
  - "proposal frontmatter 含 cross_project_peers: [<peer_id>...]  或 proposal 引用了 peer 项目"
owner: Kucell
status: stable
last_verified: 2026-08-12
verified_by: Kucell
sources:
  - lib/automation/proposal-to-mission.js
  - lib/automation/proposal-to-bridge-gate.js
  - lib/automation/inbox-listener.js
  - lib/automation/mission-completion-hook.js
  - lib/cross-project/outbox.js
  - lib/commands/automation.js
  - scripts/p006-e2e-smoke.js
---

# P-006 Cross-Project Automation Pipeline

## 概述

把 P-001 (topology) + P-001A (self-id) + P-003 (bridge) 拼成零人工闭环:

```
proposal.md (approved)                              [本仓]
  ↓ materialise-mission
.agent/missions/M-XXX/                               [本仓]
  ↓ mission 完成 (claude-code / mission runtime)
emit-on-done → .agent-runtime/.../outbox/<self>/  [本仓]
  ↓ bridge sync (manual or SessionStart hook)
.agent-runtime/.../inbox/<peer>/...                  [peer仓]
  ↓ watch-inbox (manual or cron)
.agent/missions/<target>/<event>-<rand>.dispatch-pending.json
  ↓ 后续 mission runtime 处理 dispatch sidecar
```

## 子能力对照

| 能力 | CLI 子命令 | 库 | 测试 |
|---|---|---|---|
| A) bridge emit | `bridge emit` | `lib/cross-project/outbox.js` | `tests/cross-project/outbox.test.js` (17) |
| B) materialise-mission | `automation materialise-mission` | `lib/automation/proposal-to-mission.js` | `tests/automation/proposal-to-mission.test.js` (10) |
| C) watch-inbox | `automation watch-inbox` | `lib/automation/inbox-listener.js` | `tests/automation/inbox-listener.test.js` (7) |
| D) emit-on-done | `automation emit-on-done` | `lib/automation/mission-completion-hook.js` | `tests/automation/mission-completion-hook.test.js` (8) |
| E) bridge_sync gate | (自动,随 B) | `lib/automation/proposal-to-bridge-gate.js` | `tests/automation/proposal-to-bridge-gate.test.js` (5) |

## 端到端示例 (P-008B 桥接)

完整 8 步闭环见 `scripts/p006-e2e-smoke.js`,可随时跑:

```bash
node scripts/p006-e2e-smoke.js
# ▶ hmi: emit task.state_changed
# ▶ sam: subscribe to hmi-platform
# ▶ sam: sync from hmi outbox
# ▶ sam: write automation handler
# ▶ sam: automation watch-inbox
# ✓ dispatch sidecar: M-019/BR-EVT-m017-ready-msphg2lq.dispatch-pending.json → M-019/MS-INTEGRATION
# ▶ sam: materialise-mission M-019
# ▶ sam: emit-on-done M-019
# ✓ SamHMI outbox now has 1 event(s)
# ✅ ALL P-006 SMOKE STEPS PASSED
```

## 真实项目使用流程 (SamHMI ↔ hmi-platform 实战)

### 1. 一次性准备 (per consumer project)

```bash
# hmi-platform (源)
cortex-agent topology init hmi-platform --host-root /path/to/hmi-platform
cortex-agent bridge emit --source hmi-platform --type checkpoint.closed \
  --summary '{"milestone":"MS-001"}' --group agentic-ui-delivery \
  --id BR-EVT-bootstrap  # 触发一次事件以注册 source

# SamHMI (目标)
cortex-agent topology init SamHMI --host-root /path/to/SamHMI
cortex-agent bridge subscribe --source hmi-platform \
  --group agentic-ui-delivery \
  --types task.state_changed,decision.resolved,checkpoint.closed,waitpoint.released
mkdir -p /path/to/SamHMI/.agent/bridges
cat > /path/to/SamHMI/.agent/bridges/m019-integration.json <<EOF
{
  "source_project_id": "hmi-platform",
  "correlation_group": "agentic-ui-delivery",
  "event_types": ["task.state_changed"],
  "target_mission_id": "M-019",
  "target_milestone": "MS-INTEGRATION"
}
EOF
```

### 2. 每轮 pipeline 触发

```bash
# hmi-platform: 某个 mission 完成,emit 一个事件
cortex-agent bridge emit --source hmi-platform --type task.state_changed \
  --summary '{"task_id":"M-017","state":"READY_FOR_REVIEW","milestone":"MS-001"}' \
  --group agentic-ui-delivery --id BR-EVT-m017-ready

# SamHMI: 同步 + 监听 (通常做成 cron / SessionStart hook)
cortex-agent bridge sync --source hmi-platform --source-root /path/to/hmi-platform
cortex-agent automation watch-inbox --handler m019-integration
```

### 3. mission 完成时 emit-on-done

```bash
cortex-agent automation emit-on-done \
  --mission M-019 --source-project SamHMI
# validation-contract.json 中的 bridge_emit gate 决定 emit 哪个 event_type
```

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `watch-inbox` 没有 dispatched | inbox 里事件 propagated_at ≤ cursor | `bridge inbox --source <peer>` 看最新时间;删 `<handler_id>.cursor.json` 重跑 |
| `materialise-mission` 写出来的 mission-plan 没有 bridge_emit_on_done | proposal frontmatter 缺 cross_project_peers | 在 proposal frontmatter 加 `cross_project_peers: [<peer>]` |
| `emit` 报 schema invalid | event_type 不在白名单 (4 个) 或 summary 不是 JSON object | `bridge emit --help` 看白名单 + JSON 校验 |
| `watch-inbox` 写不出 sidecar | 目标 mission dir 权限 / 磁盘满 | `ls -la .agent/missions/<target>` |

## SessionStart 自动同步 (可选增强)

P-006 §3.5 polish: 可在 AGENTS.md 的 SessionStart hook 中加:

```bash
CORTEX_BRIDGE_AUTO_SYNC=1 node .agent/hooks/session-start.js
# → 自动调 bridge sync --auto 把所有订阅源的 inbox 拉一遍
```

未在 rc.8 默认开启,需要消费项目 opt-in。

## 相关文档

- 提案: `.agent/plans/proposals/projects/cross-project-coordination/p-006-cross-project-automation.md`
- Release notes: `docs/releases/v1.12.0-rc.8.md`
- E2E smoke: `scripts/p006-e2e-smoke.js`
- 拓扑自注册: `.agent/workflows/topology-self-id.md`