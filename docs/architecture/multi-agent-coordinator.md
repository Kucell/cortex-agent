<!-- cspell:disable -->
<!-- cspell:words myworks EXCLUSIVE CREAT -->

# Multi-Agent Coordinator（多 agent × 多模型协调层）设计

> 状态：设计稿 · v0.1
> 范围：A. Agent Registry · B. Artifact Bus · C. Progress Lock · D. Handoff 协议升级
> 不写代码，仅出设计

## 0. 问题陈述

cortex-agent 当前支持多 sub-agent 与多模型路由（`routing-defaults.yml` + `/configure-model`），但缺一层**协调层**，导致以下场景落地困难：

1. **任务做了一半被切换**——Claude 写到一半的中间产物，Codex 看不到、也无法接手
2. **多 agent 并发改同一文件**——`/parallel` 第五步的"冲突检测"是事后合并，不是预防
3. **跨模型状态不可寻址**——Claude 的 `plan_summary.json`、Codex 的同义产物格式不同，新 agent 无法自动消费
4. **没有 agent registry**——sub-agent 启动是临时 worker，没有"谁在跑、跑什么、跑到哪"的全局视图
5. **handoff 是给人看的**——`.agent/handoffs/*.md` 让"人"能接手，但下一个 agent 需手工解析

本文档提出 **Coordinator** 角色与四个核心构件（Registry / Artifact Bus / Progress Lock / Handoff Protocol），在不推翻现有 `/parallel` / `/mission` / `session-manager` 的前提下叠加。

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

### 2.2 四个构件

#### A. Agent Registry

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/registry/agents.json`

**Schema**：

```json
{
  "agents": [
    {
      "agent_id": "implementer-001",
      "role": "implementer",
      "model": "claude-sonnet-4-6",
      "task_id": "T-H23",
      "session_id": "s-2026-06-10-001",
      "started_at": "2026-06-10T12:00:00Z",
      "last_heartbeat": "2026-06-10T12:15:00Z",
      "status": "running | paused | completed | failed | handed_off",
      "owned_files": ["src/validation/contract.ts"],
      "pending_artifacts": ["003-execution.json"]
    }
  ]
}
```

**接口**：
- `check_in(agent_id, role, model, task_id) → registry_entry`
- `heartbeat(agent_id) → updated_entry`
- `check_out(agent_id, status) → updated_entry`
- `list_active() → [entry]`（按 task_id 过滤）
- `get_conflicts(task_id) → [agent_id]`（检测同 task 多 agent）

**写入规则**：
- append-only，每次操作追加 `event_log` 数组，便于审计
- `last_heartbeat` 超时（默认 5 分钟）视为 `failed`，触发自动 handoff

#### B. Artifact Bus

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/artifacts/<task-id>/*`

**结构**：

```
.agent/artifacts/T-H23/
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
  "required": ["seq", "task_id", "agent_id", "produced_at", "kind", "payload"],
  "properties": {
    "seq": { "type": "integer", "minimum": 1 },
    "task_id": { "type": "string", "pattern": "^T-[A-Z0-9-]+$" },
    "agent_id": { "type": "string" },
    "produced_at": { "type": "string", "format": "date-time" },
    "kind": { "enum": ["plan", "execution", "review", "handoff", "validation"] },
    "payload": { "type": "object" }
  }
}
```

**关键属性**：
- **append-only**（每次写都加序号 + 时间戳 + agent_id）
- **跨模型可读**（JSON 协议，不依赖 LLM 特有格式）
- **state.json 是窗口**——任何新 agent 读 `state.json` 即可知道"该从哪步继续"
- **不重复存储**——大块源码用 git commit ref 引用，避免 Bus 膨胀

**迁移策略**：
- 现有 `plan_summary.json` / `execution_report.json` / `review_verdict.json` 用脚本迁到 Bus
- 旧 sub-agent 输出加 Bus 写入适配器（向后兼容）
- 不强求一次性切换——分阶段灰度

#### C. Progress Lock

**位置**：`/Users/xueyq/myworks/cortex-agent/.agent/locks/<scope>.lock`

**两级锁**：
- **文件级锁**：`locks/file:src/auth.ts.lock` —— 防止两 agent 并发改同一文件
- **任务级锁**：`locks/task:T-H23.lock` —— 防止两 agent 跑同一任务

**Lock 文件格式**：

```json
{
  "scope": "file:src/auth.ts",
  "held_by": "implementer-001",
  "acquired_at": "2026-06-10T12:00:00Z",
  "expires_at": "2026-06-10T12:05:00Z",
  "ttl_seconds": 300
}
```

**接口**：
- `acquire(scope, agent_id, ttl) → lock | null`（失败立即返回 null）
- `renew(agent_id) → updated_lock`（heartbeat 时续期）
- `release(agent_id, scope) → boolean`
- `list_held(agent_id) → [lock]`

**防死锁**：
- TTL 默认 5 分钟
- 写入 `acquire` 时检测 `expires_at`，过期则可被任何 agent 抢占
- 抢占事件写入 `event_log`，原持有者下次操作会收到 `lock_lost` 错误并触发 handoff

**实现**：
- 本地：用 `fs.openSync(path, 'wx')`（O_CREAT | O_EXCL）+ JSON 元数据
- 跨机器：升级为 Redis/etcd（**本轮不实现**，先支持本地 Codex/Claude 切换）

#### D. Handoff Protocol（结构化 agent-to-agent 交接）

**升级现有 `handoff` skill**——从"给人看的 markdown"变成"带契约的 JSON"。

**位置**：
- Markdown 部分：`/Users/xueyq/myworks/cortex-agent/.agent/handoffs/<handoff-id>.md`（保留）
- JSON 部分：写入 Artifact Bus（`kind: handoff`）

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
  "task_progress": {
    "current_step": "step-3-of-7",
    "completed_steps": ["step-1", "step-2"],
    "in_progress": "writing src/validation/contract.ts"
  },
  "artifacts": {
    "completed": ["001-plan", "002-execution"],
    "context_snapshot_ref": ".agent/artifacts/T-H23/state.json"
  },
  "next_action": "complete the validator function and add 2 unit tests",
  "constraints": ["do not modify src/user/"],
  "context_budget_hint": 12000,
  "produced_at": "2026-06-10T12:30:00Z"
}
```

**两种消费模式**：
- `HUMAN_RESUME`（旧）：人读 markdown，决策下一步
- `AGENT_RESUME`（新）：agent 读 JSON，从 `task_progress.current_step` 继续

## 3. 与现有体系的关系

| 现有 | 与 Coordinator 的关系 |
|---|---|
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

按依赖关系与投入产出比排序：

| ID | 任务 | 依赖 | 估时 | 优先级 |
|---|---|---|---|---|
| T-C01 | `docs/architecture/multi-agent-coordinator.md`（本文档） | — | 1h | P0 |
| T-C02 | `coordinator` sub-agent 定义（`.agent/sub-agents/coordinator.md`） | T-C01 | 2h | P0 |
| T-C03 | Agent Registry schema + `agents.json` 模板 + check-in/out 脚本 | T-C02 | 4h | P0 |
| T-C04 | Artifact Bus：`artifact-schema.json` + 读写辅助函数 | T-C02 | 4h | P0 |
| T-C05 | Progress Lock：`acquire/renew/release` 脚本 + TTL 处理 | T-C02 | 3h | P1 |
| T-C06 | handoff skill 升级：双产物 + `AGENT_RESUME` 模式 | T-C04 | 3h | P0 |
| T-C07 | `routing-defaults.yml` 扩展 `model_registry` | T-C02 | 2h | P1 |
| T-C08 | `/mission` 状态机改造：显式 HANDOFF + RESUME 状态 | T-C04, T-C06 | 4h | P1 |
| T-C09 | 端到端验证：起一个 M 任务，模拟 Claude → Codex 切换 | T-C03~T-C08 | 4h | P1 |
| T-C10 | 文档更新：`/briefing` 加入 coordinator 健康度板块 | T-C03, T-C05 | 2h | P2 |

**总估时**：~27 小时（约 3-4 个工作日）

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

## 11. 参考

- `.agent/workflows/parallel.md`——当前并行机制
- `.agent/workflows/mission.md`——当前长周期任务机制
- `.agent/skills/handoff/SKILL.md`——当前 handoff skill
- `.agent/sub-agents/session-manager.md`——会话时间管理
- `.agent/sub-agents/routing-defaults.yml`——当前模型路由
- `docs/architecture/mission-lite-design.md`——Mission Lite 设计
- `docs/tech-debt.md`——TD-005 成本控制可与本设计联动
