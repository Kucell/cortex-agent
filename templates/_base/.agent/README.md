# `templates/_base/.agent/` — 模式无关共享层

> **Mission**: M-001 / MS-001
> **RFC**: `docs/architecture/general-mode-design.md` §6.4 + §8 Phase 1
> **Status**: 共享层骨架 publish（schema 完整 + README 完整 + sample 齐全）

## 1. 这是什么

`_base/` 是 **mode 无关** 的 runtime 能力共享层。`code` 模式（编程项目）和 `general` 模式（日常任务/对话管理）共用同一套底层 data schema，由各模式自己决定：

- 哪些目录启用（code 模式一般不开 `conversations/` `memory/`）
- 哪些 workflow 接进来（general 模式接 `/memory recall`，code 模式不接）
- 哪些 sub-agent 运行

换句话说：**`_base/` 是骨架,模式是皮肤**。

## 2. 9-11 个 data 目录(本 milestone 范围)

| 目录 | 用途 | 归属 | RFC 引用 |
| :--- | :--- | :--- | :--- |
| `inbox/` | 通信对象:agent 间消息(information / request / handoff / decision_request / alert) | code + general | §6.4 |
| `decisions/` | 决策记录:架构 / 合并 / 发布 / 风险 gate | code + general | §6.4 |
| `waitpoints/` | 等待点:阻塞性决策前的暂停闸口 | code + general | §6.4 |
| `runs/` | 协作 run journal:plan / implement / validate / merge / handoff / dashboard / publish | code + general | §6.4 |
| `sessions/` | 实时会话状态:5 小时上限管控(session-manager 5 模式) | code + general | §6.4 + sub-agents/session-manager.md |
| `missions/` | 长周期任务编排:mission-plan / validation-contract / milestones / handoffs | code + general | mission-lite-design.md |
| `handoffs/` | 跨 agent 续接 payload:HUMAN_RESUME / AGENT_RESUME | code + general | §6.4.1 + handoff.schema.json |
| `conversations/` | 长期对话档案(turns / handoffs / summary / relations) | **general 专属** | §6.4.1 H-NNN.json |
| `memory/` | 跨 session 蒸馏记忆:episodic / semantic(procedural 推 v1.12) | **general 专属** | §6.4 + 6.5 |
| `agents/` | 项目级 agent registry + capabilities + external/ + credentials/ | code + general | §6.4(升级) |
| `tasks/` | Task Pipeline:stage gates(draft / spec / plan / implement / validate / review / done) | code + general | §6.4(新增) |

**11 个目录**对应 RFC §6.4 + §6.4.1 的完整 data 集合。每个目录包含:

- `<dir>.schema.json` — JSON Schema (draft-07),声明合法字段
- `README.md` — 用途 + 字段说明 + 与其他目录关系
- `sample.json` — 1 个真实示例(参考 `.agent/decisions/D-FAE-001.json` 等现有数据)

## 3. 目录关系图

```
                          +------------------+
                          |  mission M-001   |
                          |  (长周期编排)     |
                          +--------+---------+
                                   |
                                   v
+----------------+         +------------------+         +----------------+
|   tasks/       |<------->|    missions/     |<------->|   handoffs/    |
|  Task Pipeline |         |  Mission state   |         |  cross-agent   |
+----------------+         +------------------+         +----------------+
                                   |                            |
                                   v                            v
                          +------------------+         +----------------+
                          |  milestones/     |         | conversations/ |
                          |  (per MS)        |         |  长期对话档案   |
                          +------------------+         +----------------+
                                                              |
                            +------------------+             |
                            |    sessions/     |   merge up  |
                            |  实时会话 (5h)   |------------>+
                            +------------------+             |
                                   |                         |
                                   v                         v
                          +------------------+         +----------------+
                          |      runs/       |         |    memory/     |
                          |  run journal     |         | episodic/sem/  |
                          +------------------+         |   procedural   |
                                   |                   +----------------+
                                   v
+----------------+   gates    +------------------+    resolved_by
|  decisions/    |<----------|  waitpoints/     |<--------+
|  决策记录       |           |  等待点          |
+----------------+           +------------------+
        ^                            |
        |                            |
        +----------- inbox ----------+

+----------------+
|    agents/     |   (横切:registry / capabilities / external)
+----------------+
```

## 4. 与 code / general 模式的关系

| 目录 | code 模式 | general 模式 |
| :--- | :---: | :---: |
| `inbox/` | ✓ | ✓ |
| `decisions/` | ✓ | ✓ |
| `waitpoints/` | ✓ | ✓ |
| `runs/` | ✓ | ✓ |
| `sessions/` | ✓ | ✓ |
| `missions/` | ✓ | ✓ |
| `handoffs/` | ✓(同构 agent) | ✓(异构 agent) |
| `conversations/` | △(可选) | **✓ 必装** |
| `memory/` | △(可选) | **✓ 必装** |
| `agents/` | ✓ | ✓(+ external adapters) |
| `tasks/` | ✓ | ✓ |

> ✓ = 启用;△ = 可选;**✓** = 模式核心

`code` 模式:编程项目,v1.x 全自动开发;workflow 偏重 `/start-task` `/ship` `/prototype` `/arch-design`。
`general` 模式:日常任务 + 对话管理;workflow 偏重 `/conversation log` `/memory recall` `/memory distill` `/agent invoke` `/handoff`。

## 5. schema 命名约定

每个目录的 schema 文件命名:

- `inbox/inbox.schema.json` — 目录名 = schema 文件名主词
- `decisions/decision.schema.json`
- `waitpoints/waitpoint.schema.json`
- `runs/run.schema.json`
- `sessions/session.schema.json`
- `missions/mission.schema.json`
- `handoffs/handoff.schema.json`
- `conversations/conversation.schema.json`
- `memory/memory.schema.json`
- `agents/agent.schema.json`
- `tasks/task.schema.json`

理由:`cortex-agent validate <dir>/<file>.json --schema <dir>/<dir>.schema.json` 风格保持统一。

## 6. 与 `templates/_shared/` 的关系

- `templates/_shared/` — v1.x 的跨语言共享实现(80+ schema,已 ship,P-001 期间固化)
- `templates/_base/` — v1.10 的模式无关共享层骨架(**本次 MS-001 新建**)

`_shared/` 是"实现层",`_base/` 是"契约层"。`_base/` 的 schema 是 `_shared/` 同名 schema 的最小子集 + 严格化(去掉 mode-specific 字段,只留跨模式通用部分)。

MS-001 不修改 `_shared/`,后续 MS-002/003/004 才会让 `_shared/` 引用 `_base/`,实现真正的"模式无关共享"。

## 7. Phase 1 验收

依据 RFC §8 Phase 1:

> **验收**: 回归测试 100% pass;**9 个核心 data 目录 schema 全部 publish**

MS-001 落 11 个(超出 9,含 `missions/` `conversations/` `tasks/`),全部 `schema.json + README.md + sample.json` 齐备。`tests/_base-extraction.test.js` 跑通 22+ 断言。

## 8. 关联文档

- RFC: `docs/architecture/general-mode-design.md` §6.4 / §6.4.1 / §8
- Mission Lite: `docs/architecture/mission-lite-design.md`
- 现有共享实现: `templates/_shared/.agent/`
- Validation contract: `.agent/missions/M-001/validation-contract.json`
- Mission plan: `.agent/missions/M-001/mission-plan.md`
