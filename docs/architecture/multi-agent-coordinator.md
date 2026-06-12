<!-- cspell:disable -->
<!-- cspell:words myworks EXCLUSIVE CREAT -->

# Multi-Agent Coordinator（多 agent × 多模型协调层）设计

> 状态：主线架构 · v0.4
> 范围：A. Agent Registry · B. Artifact Bus · C. Progress Lock · D. Handoff 协议升级
> 当前阶段：T-C06 Handoff 协议升级已完成，随后进入 T-C07 Model Registry

## 0. 问题陈述

cortex-agent 当前支持多 sub-agent 与多模型路由（`routing-defaults.yml` + `/configure-model`），但缺一层**协调层**，导致以下场景落地困难：

1. **任务做了一半被切换**——Claude 写到一半的中间产物，Codex 看不到、也无法接手
2. **多 agent 并发改同一文件**——`/parallel` 第五步的"冲突检测"是事后合并，不是预防
3. **跨模型状态不可寻址**——Claude 的 `plan_summary.json`、Codex 的同义产物格式不同，新 agent 无法自动消费
4. **没有 agent registry**——sub-agent 启动是临时 worker，没有"谁在跑、跑什么、跑到哪"的全局视图
5. **handoff 是给人看的**——`.agent/handoffs/*.md` 让"人"能接手，但下一个 agent 需手工解析

本文档提出 **Coordinator** 角色与四个核心构件（Registry / Artifact Bus / Progress Lock / Handoff Protocol），在不推翻现有 `/parallel` / `/mission` / `session-manager` 的前提下叠加。

本方案不缩减为 Lite 版本。Coordinator 是 cortex-agent 下一阶段完整主线，目标是建立多 agent / 多模型 / 多会话下的统一协调层；工程实现采用分阶段交付，避免一次性大爆炸。

## 0.1 架构铺垫

Coordinator 建立在两个已完成或已成型的基础之上：

| 基础 | 已提供能力 | Coordinator 如何复用 |
|---|---|---|
| Harness Optimization | `.agent/` 治理层、`docs/` 知识层、context-budget、phase-gate、knowledge-lint、maturity-tracker | 所有 Coordinator 运行态文件、sub-agent、skill、workflow 扩展都落在 `.agent/`；设计与经验沉淀到 `docs/` |
| Mission Lite | mission-plan、validation-contract、command-log、milestone、handoff 状态 | Artifact Bus 索引这些产物；Coordinator 在 mission 执行阶段负责 agent 登记、锁、handoff JSON 和 resume |

边界原则：

- Harness 定义治理与资产边界，不实现调度。
- Mission Lite 定义长任务计划与验证，不维护 agent 运行态。
- Coordinator 定义多 agent 协调运行态，不重写 mission scope 或业务需求。
- Handoff 是 Coordinator 的协议产物之一，不等于完整 Coordinator。

## 1. 设计目标

| 目标 | 验收 |
|---|---|
| 任意 sub-agent 可在任意时刻接管另一个 agent 的任务 | 给定 handoff JSON + Artifact Bus 状态，新 agent 能从正确步骤继续 |
| 跨模型中间产物可寻址、可读 | Claude plan_summary.json 与 Codex 等价物都落到同一 Artifact Bus，使用统一 schema |
| 防并发冲突 | 两个 agent 同时改同一文件时，后者阻塞或收到明确错误（不是事后合并） |
| 协调成本可观察 | 任意时刻可查"哪些 agent 在跑、占什么锁、写了什么产物" |
| 不破坏现有工作流 | `/parallel` / `/mission` / `session-manager` 不需要大改；新增能力叠加 |

## 2. 核心抽象

### 2.1 协调器（Coordinator）

主代理（main agent）或独立 sub-agent，负责：

- 维护 Agent Registry
- 提供 Artifact Bus 读写接口
- 仲裁 Progress Lock
- 生成 / 消费 Handoff

**关键决策**：协调器实现为**新 sub-agent `coordinator`**（不是内置模块）。原因：
- 可复用 model routing（`routing-defaults.yml`）
- 上下文独立，不污染主代理
- 可独立演进

第一版 `coordinator` sub-agent 应具备完整职责边界声明，即使底层构件分阶段实现：

| 阶段 | coordinator 需要知道 | coordinator 可实际执行 |
|---|---|---|
| T-C02 | Registry / Artifact Bus / Lock / Handoff / Model Registry 的完整设计边界 | 读取现有计划和 handoff，输出下一步协调建议 |
| T-C03~T-C04 | registry 与 artifact bus schema | 登记 agent、索引产物、更新 state |
| T-C05~T-C06 | lock 与 handoff JSON 协议 | 仲裁本地锁、生成/消费 AGENT_RESUME |
| T-C07~T-C08 | model registry 与 mission resume 状态 | 根据能力选择接手模型，衔接 `/mission` HANDOFF / RESUME |
| T-C09~T-C10 | E2E 验证与健康度 | 支撑 Claude → Codex 切换验证，并输出 briefing health |

### 2.2 四个构件

#### A. Agent Registry

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/registry/agents.json`

**状态**：T-C03 已落地。当前提供：

- `.agent/registry/agents.json`
- `.agent/registry/agent-registry.schema.json`
- `.agent/registry/scripts/agent-registry.js`
- `templates/en/.agent/registry/*`
- `templates/zh/.agent/registry/*`

**Schema**：

```json
{
  "version": 1,
  "updated_at": "2026-06-12T00:00:00.000Z",
  "agents": [
    {
      "agent_id": "implementer-001",
      "role": "implementer",
      "model": "claude-sonnet-4-6",
      "task_id": "T-H23",
      "mission_id": "M-001",
      "session_id": "s-2026-06-10-001",
      "started_at": "2026-06-10T12:00:00Z",
      "last_heartbeat": "2026-06-10T12:15:00Z",
      "status": "running | paused | completed | failed | handed_off",
      "owned_files": ["src/validation/contract.ts"],
      "pending_artifacts": ["003-execution.json"]
    }
  ],
  "event_log": [
    {
      "event_id": "E-...",
      "type": "check_in",
      "agent_id": "implementer-001",
      "task_id": "T-H23",
      "timestamp": "2026-06-10T12:00:00Z",
      "details": {}
    }
  ]
}
```

**接口**：

```bash
node .agent/registry/scripts/agent-registry.js check-in --agent-id implementer-001 --role implementer --model codex --task-id T-C03
node .agent/registry/scripts/agent-registry.js heartbeat --agent-id implementer-001
node .agent/registry/scripts/agent-registry.js check-out --agent-id implementer-001 --status completed
node .agent/registry/scripts/agent-registry.js list-active --task-id T-C03
node .agent/registry/scripts/agent-registry.js get-conflicts --task-id T-C03 --owned-files src/a.ts
node .agent/registry/scripts/agent-registry.js mark-stale --ttl-seconds 300
```

**写入规则**：
- append-only，每次操作追加 `event_log` 数组，便于审计
- `last_heartbeat` 超时（默认 5 分钟）视为 `failed`，触发自动 handoff
- 脚本使用原子 rename 写入，避免半写状态
- 不保存源码、完整 diff、PRD 或长命令输出，只保存路径、状态和 artifact 引用

#### B. Artifact Bus

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/artifacts/<task-id>/*`

**状态**：T-C04 已落地。当前提供：

- `.agent/artifacts/artifact-schema.json`
- `.agent/artifacts/state-schema.json`
- `.agent/artifacts/scripts/artifact-bus.js`
- `templates/en/.agent/artifacts/*`
- `templates/zh/.agent/artifacts/*`

**结构**：

```
.agent/artifacts/
  ├── artifact-schema.json
  ├── state-schema.json
  ├── scripts/
  │   └── artifact-bus.js
  └── T-H23/
  ├── 001-plan.json        # 第 1 个有序产物（planner 输出）
  ├── 002-execution.json   # implementer 检查点 1
  ├── 003-execution.json   # implementer 检查点 2
  ├── 004-review.json      # code-reviewer 输出
  └── state.json           # 当前进度 + 下一步建议（每次写都更新）
```

**Schema 约束**（`artifact-schema.json`）：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["artifact_id", "seq", "task_id", "agent_id", "produced_at", "kind", "payload"],
  "properties": {
    "artifact_id": { "type": "string" },
    "seq": { "type": "integer", "minimum": 1 },
    "task_id": { "type": "string" },
    "mission_id": { "type": ["string", "null"] },
    "agent_id": { "type": "string" },
    "produced_at": { "type": "string", "format": "date-time" },
    "kind": { "enum": ["plan", "execution", "review", "handoff", "validation", "state", "note"] },
    "summary": { "type": "string" },
    "refs": { "type": "array", "items": { "type": "string" } },
    "payload": { "type": "object" }
  }
}
```

**接口**：

```bash
node .agent/artifacts/scripts/artifact-bus.js append --task-id T-C04 --agent-id coordinator --kind plan --payload-json '{"steps":[]}'
node .agent/artifacts/scripts/artifact-bus.js list --task-id T-C04
node .agent/artifacts/scripts/artifact-bus.js read --task-id T-C04 --seq 1
node .agent/artifacts/scripts/artifact-bus.js state --task-id T-C04
node .agent/artifacts/scripts/artifact-bus.js validate --task-id T-C04
```

**关键属性**：
- **append-only**（每次写都加序号 + 时间戳 + agent_id）
- **跨模型可读**（JSON 协议，不依赖 LLM 特有格式）
- **state.json 是窗口**——任何新 agent 读 `state.json` 即可知道"该从哪步继续"
- **不重复存储**——大块源码用 git commit ref 引用，避免 Bus 膨胀
- **原子写入**——脚本写入 artifact 和 state 时使用临时文件 + rename

**迁移策略**：
- 现有 `plan_summary.json` / `execution_report.json` / `review_verdict.json` 用脚本迁到 Bus
- 旧 sub-agent 输出加 Bus 写入适配器（向后兼容）
- 不强求一次性切换——分阶段灰度

#### C. Progress Lock

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/locks/<encoded-scope>.lock.json`

**状态**：T-C05 已落地。当前提供：

- `.agent/locks/progress-lock.schema.json`
- `.agent/locks/lock-events.json`
- `.agent/locks/scripts/progress-lock.js`
- `templates/en/.agent/locks/*`
- `templates/zh/.agent/locks/*`

**两级锁**：
- **文件级锁**：scope 为 `file:src/auth.ts` —— 防止两 agent 并发改同一文件
- **任务级锁**：scope 为 `task:T-H23` —— 防止两 agent 跑同一任务

**Lock 文件格式**：

```json
{
  "scope": "file:src/auth.ts",
  "held_by": "implementer-001",
  "task_id": "T-H23",
  "mission_id": null,
  "acquired_at": "2026-06-10T12:00:00Z",
  "expires_at": "2026-06-10T12:05:00Z",
  "ttl_seconds": 300,
  "metadata": {}
}
```

**接口**：

```bash
node .agent/locks/scripts/progress-lock.js acquire --scope task:T-C05 --agent-id coordinator --ttl-seconds 300
node .agent/locks/scripts/progress-lock.js renew --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js release --scope task:T-C05 --agent-id coordinator
node .agent/locks/scripts/progress-lock.js inspect --scope task:T-C05
node .agent/locks/scripts/progress-lock.js list-held --agent-id coordinator
node .agent/locks/scripts/progress-lock.js sweep-expired
```

命令语义：

- `acquire(scope, agent_id, ttl) → { acquired, lock }`：成功时写入 lock；失败时返回当前 holder
- `renew(scope, agent_id, ttl) → { renewed, lock }`：仅当前未过期 holder 可续期
- `release(scope, agent_id) → { released }`：仅当前未过期 holder 可释放
- `inspect(scope) → { exists, expired, lock }`
- `list-held(agent_id?) → [lock]`
- `sweep-expired() → { swept }`

**防死锁**：
- TTL 默认 5 分钟
- 写入 `acquire` 时检测 `expires_at`，过期则可被任何 agent 抢占
- 抢占事件写入 `event_log`，原持有者下次操作会收到 `lock_lost` 错误并触发 handoff
- `sweep-expired` 可清理过期本地锁，不影响未过期 holder

**实现**：
- 本地：用 `fs.openSync(path, 'wx')`（O_CREAT | O_EXCL）+ JSON 元数据
- scope 文件名使用 base64url 编码，避免 `file:src/auth.ts` 等 scope 直接成为嵌套路径
- `lock-events.json` 记录 `acquire`、`acquire_blocked`、`renew`、`release`、`expired_removed` 等事件
- 跨机器：升级为 Redis/etcd（**本轮不实现**，先支持本地 Codex/Claude 切换）

#### D. Handoff Protocol（结构化 agent-to-agent 交接）

**升级现有 `handoff` skill**——从"给人看的 markdown"变成"带契约的 JSON"。

**状态**：T-C06 已落地。当前提供：

- `.agent/handoffs/handoff.schema.json`
- `.agent/handoffs/scripts/handoff-protocol.js`
- `.agent/handoffs/README.md`
- `templates/en/.agent/handoffs/*`
- `templates/zh/.agent/handoffs/*`
- `.agent/skills/handoff/SKILL.md` 与中英模板已支持 `HUMAN_RESUME` / `AGENT_RESUME`
- `.agent/workflows/handoff.md` 与中英模板已支持 Markdown + JSON 双产物

**位置**：
- Markdown 部分：`/Users/xueyq/myworks/cortex-agent/.agent/handoffs/<handoff-id>.md`（保留）
- JSON 部分：`/Users/xueyq/myworks/cortex-agent/.agent/handoffs/<handoff-id>.json`，并写入 Artifact Bus（`kind: handoff`）

**Schema**：

```json
{
  "handoff_id": "H-2026-06-10-001",
  "from": {
    "agent_id": "implementer-001",
    "model": "claude-sonnet-4-6",
    "session_id": "s-2026-06-10-001"
  },
  "to": {
    "role": "implementer",
    "model_pref": ["codex", "claude-sonnet-4-6"],
    "required_capabilities": ["code_generation", "test_writing"]
  },
  "task_id": "T-H23",
  "mission_id": "M-001",
  "mode": "AGENT_RESUME",
  "task_progress": {
    "current_step": "step-3-of-7",
    "completed_steps": ["step-1", "step-2"],
    "in_progress": "writing src/validation/contract.ts",
    "remaining_steps": ["step-3", "step-4"]
  },
  "artifacts": {
    "completed": ["001-plan", "002-execution"],
    "context_snapshot_ref": ".agent/artifacts/T-H23/state.json",
    "markdown_ref": ".agent/handoffs/20260610-123000-heart-rate.md",
    "artifact_refs": []
  },
  "next_action": "complete the validator function and add 2 unit tests",
  "constraints": ["do not modify src/user/"],
  "verification": {
    "commands_run": [
      {
        "command": "npm test -- validation",
        "exit_code": 0,
        "summary": "passed"
      }
    ],
    "commands_needed": ["run dashboard integration test"],
    "known_failures": []
  },
  "graphify_context": null,
  "context_budget_hint": 12000,
  "produced_at": "2026-06-10T12:30:00Z"
}
```

**接口**：

```bash
node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/handoffs/H-20260610-123000-heart-rate.json
node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/handoffs/H-20260610-123000-heart-rate.json --markdown-path .agent/handoffs/20260610-123000-heart-rate.md --agent-id coordinator
node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file .agent/handoffs/H-20260610-123000-heart-rate.json
```

**两种消费模式**：
- `HUMAN_RESUME`（旧）：人读 markdown，决策下一步
- `AGENT_RESUME`（新）：agent 读 JSON，从 `task_progress.current_step` 与 `next_action` 继续

**Graphify 扩展点**：

- `graphify_context` 是 T-C06 预留的可选字段。
- 当 T-G03 落地后，可引用知识图谱子图 artifact，帮助接手 agent 读取最小相关代码结构。
- 在没有子图时，该字段为 `null` 或省略，不阻塞 handoff。

## 3. 与现有体系的关系

| 现有 | 与 Coordinator 的关系 |
|---|---|
| Harness Optimization | Coordinator 的治理底座；约束其必须保持模板驱动、零 CLI runtime 依赖、平台无关和纯加法升级 |
| `/parallel` | worker 启动前必须 `registry.check_in` + `lock.acquire`；同 batch 互不依赖原则不变，但锁机制作为安全网 |
| `/mission` | Artifact Bus 成为 mission 的存储后端——`mission-plan.md` 等价于 `artifacts/<M-id>/000-scope.json`（kind: plan） |
| `handoff` skill | 升级为双产物（markdown + JSON），新增 `AGENT_RESUME` 模式 |
| `session-manager` | 不重叠——session-manager 管 5h 时间窗，coordinator 管多 agent 协调；可串联（session 超时 → 触发 handoff → 自动 resume） |
| `routing-defaults.yml` | 扩展 `model_registry` 字段，记录每个模型的能力/上下文/token 成本（详见 §4） |
| `validation-contract` | 完全复用——artifact bus 写入时同时调用 CHECK 模式 |
| `/configure-model` | 不变——继续负责模型注册，coordinator 只读不改 |

## 4. Model Registry（`routing-defaults.yml` 扩展）

**新增字段**：

```yaml
model_registry:
  models:
    - id: claude-sonnet-4-6
      provider: anthropic
      capabilities: [code_generation, code_review, planning, research, long_context]
      context_window: 200000
      cost_per_1k_tokens: { input: 0.003, output: 0.015 }
      strengths: ["nuanced code review", "long context reasoning"]
      weaknesses: ["slow on large file diffs"]

    - id: codex
      provider: openai
      capabilities: [code_generation, test_writing, refactor]
      context_window: 128000
      cost_per_1k_tokens: { input: 0.0015, output: 0.006 }
      strengths: ["fast code generation", "good at unit tests"]
      weaknesses: ["less nuanced planning"]

    - id: claude-haiku-4-5
      provider: anthropic
      capabilities: [lightweight_tasks, classification, routing]
      context_window: 200000
      cost_per_1k_tokens: { input: 0.0008, output: 0.004 }
      strengths: ["cheap", "fast"]
      weaknesses: ["weaker on complex planning"]
```

**coordinator 用法**：
- Handoff `to.model_pref` 排序——优先匹配 `required_capabilities`
- 选模型时考虑 `cost_per_1k_tokens` 与 `context_window` 是否够用
- `weaknesses` 写入 handoff 警告，提示接手 agent 注意

## 5. 状态机（扩展 `/mission`）

```
                 ┌────────────────┐
                 │   SCOPE        │
                 └────────┬───────┘
                          ↓
                 ┌────────────────┐
                 │   PLAN         │  ← 写 001-plan.json
                 └────────┬───────┘
                          ↓
                 ┌────────────────┐
                 │   CONTRACT     │  ← 写 validation-contract.json
                 └────────┬───────┘
                          ↓
            ╔═══════════════════════════╗
            ║   EXECUTE_FEATURE         ║
            ║   (可中断、可移交)         ║
            ║   - acquire locks         ║
            ║   - 写 00N-execution.json ║
            ║   - 更新 state.json       ║
            ║   - 触发 handoff 时       ║
            ║     释放锁、写 handoff   ║
            ╚═══════════╤═══════════════╝
                        ↓
                 ┌────────────────┐
                 │   HANDOFF      │  ← 新增独立状态（之前在 EXECUTE_FEATURE 内隐式）
                 └────────┬───────┘
                          ↓
            ╔═══════════════════════════╗
            ║   RESUME (新 agent)        ║
            ║   - 读 handoff JSON        ║
            ║   - 读 state.json          ║
            ║   - acquire locks          ║
            ║   - 续写 00(N+M)-exec.json║
            ╚═══════════╤═══════════════╝
                        ↓
                 ┌────────────────┐
                 │   VALIDATE     │
                 │   _MILESTONE   │
                 └────────┬───────┘
                          ↓
                 ┌────────────────┐
                 │   COMPLETE     │
                 └────────────────┘
```

**关键变化**：
- `HANDOFF` 显式成为独立状态（之前隐含在 EXECUTE_FEATURE）
- `RESUME` 是新状态——接手的 agent 从这里进入
- 每个状态转换都对应 Artifact Bus 的一次写入

## 6. 错误与边界

| 场景 | 行为 |
|---|---|
| agent 崩溃（heartbeat 超时） | registry 标 `failed`；Coordinator 触发自动 handoff；如果有锁，让 TTL 自然过期 |
| 锁被抢占 | 原持有者下次操作收到 `lock_lost`；自动写 handoff JSON；state.json 标记 `paused` |
| Artifact Bus 文件被外部修改 | schema 校验失败 → 写入 `event_log` 不抛错；state.json 用 git commit ref 兜底 |
| handoff JSON 找不到接手 agent | Coordinator 按 `required_capabilities` 在 routing-defaults.yml 选模型；若无匹配 → 写 `event_log` + 通知主代理人工决策 |
| 跨机器 Codex 调用 | **本轮不支持**——lock 用本地文件；如需要，后续升级 Redis |

## 7. 子任务清单（实现时按此推进）

按依赖关系与投入产出比排序。完整 Coordinator 目标不变，但拆成可独立交付的任务：

| ID | 任务 | 依赖 | 估时 | 优先级 |
|---|---|---|---|---|
| T-C01 | `docs/architecture/multi-agent-coordinator.md`（本文档） | — | 1h | P0 |
| T-C01A | Coordinator 前置架构对齐：Harness / Mission Lite / Coordinator 边界与任务拆解同步 | T-C01 | 1h | P0 |
| T-C02 | `coordinator` sub-agent 定义（`.agent/sub-agents/coordinator.md`），包含完整职责边界与阶段化能力声明 | T-C01A | 2h | P0 |
| T-C03 | Agent Registry schema + `agents.json` 模板 + check-in/out 脚本 | T-C02 | 4h | P0 · done |
| T-C04 | Artifact Bus：`artifact-schema.json` + 读写辅助函数 | T-C02 | 4h | P0 · done |
| T-C05 | Progress Lock：`acquire/renew/release` 脚本 + TTL 处理 | T-C02 | 3h | P1 · done |
| T-C06 | handoff skill 升级：双产物 + `AGENT_RESUME` 模式 | T-C04 | 3h | P0 · done |
| T-C07 | `routing-defaults.yml` 扩展 `model_registry` | T-C02 | 2h | P1 |
| T-C08 | `/mission` 状态机改造：显式 HANDOFF + RESUME 状态 | T-C04, T-C06 | 4h | P1 |
| T-C09 | 端到端验证：起一个 M 任务，模拟 Claude → Codex 切换 | T-C03~T-C08 | 4h | P1 |
| T-C10 | 文档更新：`/briefing` 加入 coordinator 健康度板块 | T-C03, T-C05 | 2h | P2 |

**总估时**：~27 小时（约 3-4 个工作日）

### 7.1 分阶段交付计划

| 阶段 | 包含任务 | 目标 | 验收 |
|---|---|---|---|
| Phase C0：架构对齐 | T-C01A | Harness / Mission Lite / Coordinator 边界一致 | 三份架构文档与 task-progress 同步 |
| Phase C1：Coordinator 角色 | T-C02 | 定义完整 coordinator sub-agent 与输入/输出契约 | 主代理能知道何时调用 coordinator、coordinator 输出可执行建议 |
| Phase C2：状态与产物 | T-C03 / T-C04 | 建立 Agent Registry 与 Artifact Bus | agent 状态和 plan/execution/review/handoff artifacts 可寻址 |
| Phase C3：冲突与交接 | T-C05 / T-C06 | 本地 Progress Lock 与 handoff JSON | 同任务/同文件并发有明确阻断或交接路径 |
| Phase C4：模型与 Mission 衔接 | T-C07 / T-C08 | Model Registry 与 `/mission` HANDOFF / RESUME | 新 agent 可基于能力和 mission state 接手 |
| Phase C5：验证与可见性 | T-C09 / T-C10 | Claude → Codex E2E 与 briefing health | 真实切换场景无状态丢失，briefing 可见 coordinator 状态 |

### 7.2 每阶段的架构约束

- 每个阶段都必须保持零第三方 runtime 依赖；脚本只使用 Node.js 内置模块。
- CLI 不硬编码 Coordinator 业务逻辑；优先落在 templates、`.agent/skills`、`.agent/workflows`、`.agent/sub-agents` 和可选辅助脚本。
- 所有新增模板必须同步 zh / en。
- `upgrade` 仍然只添加不存在的文件，不覆盖用户已有 `.agent/`。
- Artifact Bus 和 Registry 不复制源码或长 diff，只保存路径、commit ref、摘要和结构化 payload。

## 8. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| schema 约束过严导致旧 agent 拒绝写入 | 迁移困难 | 双轨：旧 agent 可写非 schema 文件，新 agent 写 schema 校验 |
| 文件锁性能开销 | 大项目卡顿 | 仅在 `EXCLUSIVE` 标记的文件上加锁（`package-lock.json` 之类的不锁） |
| Registry JSON 膨胀 | git diff 噪声 | `event_log` 滚动 7 天后归档到 `archive/registry/` |
| 跨模型 schema 兼容性 | Codex 写出的 JSON 字段名不同 | schema 严格定义，coordinator 做归一化映射 |
| 协调器成为性能瓶颈 | 所有 agent 启动都要等协调器 | coordinator 本地部署，O(1) 读写 |

## 9. 不在本设计范围

- **跨机器协调**（Codex 跑在云端）——需要 Redis/etcd 升级
- **Agent 之间的工具调用**（A agent 调 B agent 的 tool）——属于 LangGraph/AutoGen 路线，与本文档解耦
- **运行时模型自动切换**——coordinator 只在 handoff 时建议模型，不在执行中途切换
- **Token 成本实时监控**——属于 TD-005，由 `maturity-tracker` 跟踪

## 10. 验收（end-to-end 验证场景）

T-C09 实施时，跑以下场景：

1. 起一个 M-001（多 milestone 任务）
2. Claude implementer 启动，跑 milestone 1，写 001-execution.json
3. 用户切到 Codex（或 `routing-defaults.yml` 临时改首选）
4. 切回 Claude，启动新 session
5. 新 agent 读 registry → 发现 implementer-001 已 paused
6. 读 handoff JSON → 知道从 step-3 继续
7. 读 state.json → 知道已完成 001-execution.json
8. acquire lock → 写 002-execution.json → release
9. 完成 milestone 1 → 进入 VALIDATE_MILESTONE

如果以上全部走通且无丢状态，验收通过。

## 10.1 Coordinator 完整验收边界

完整 Coordinator 达到可用状态时，应满足：

| 能力 | 验收标准 |
|---|---|
| Agent Registry | 能列出当前/最近 agent、任务、模型、状态、心跳或最后更新时间 |
| Artifact Bus | 能按 task / mission 读取 plan、execution、review、validation、handoff 与 state |
| Progress Lock | 同任务或同文件并发写入有明确 acquire / renew / release / timeout 语义 |
| Handoff Protocol | Markdown 面向人，JSON 面向 agent；AGENT_RESUME 可独立恢复下一步 |
| Model Registry | handoff 可表达 required_capabilities 与 model preference |
| Mission Integration | `/mission` 可显式进入 HANDOFF / RESUME，而不是隐式依赖自然语言 |
| E2E Validation | Claude → Codex / Codex → Claude 切换时无状态丢失 |
| Observability | `/briefing` 可报告 coordinator 健康度、活动 agent、锁和待处理 handoff |

## 11. 参考

- `.agent/workflows/parallel.md`——当前并行机制
- `.agent/workflows/mission.md`——当前长周期任务机制
- `.agent/skills/handoff/SKILL.md`——当前 handoff skill
- `.agent/sub-agents/session-manager.md`——会话时间管理
- `.agent/sub-agents/routing-defaults.yml`——当前模型路由
- `docs/architecture/mission-lite-design.md`——Mission Lite 设计
- `docs/tech-debt.md`——TD-005 成本控制可与本设计联动
