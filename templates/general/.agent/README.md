# `templates/general/.agent/` — general 模式专属模板层

> **Mission**: M-002 / MS-001
> **RFC**: [`docs/architecture/general-mode-design.md`](../../../../../docs/architecture/general-mode-design.md) §6.5 / §6.6 / §8 Phase 2
> **M-002 mission plan**: [`../../../missions/M-002/mission-plan.md`](../../../../../missions/M-002/mission-plan.md)
> **M-001 binding contract**: `templates/_base/.agent/README.md` §1 — `_base/` 是骨架,模式是皮肤
> **Status**: 模板骨架 publish(workflows / skills / sub-agents / domains / prompts / config + README)

## 1. 这是什么

`templates/general/` 是 **general 模式专属** 的模板层,对应 RFC §2 目标「日常任务 + 对话管理 + 跨 agent 续接」。

`general` 模式 init 时,CLI 会从以下两层拼装目标项目的 `.agent/`:

| 层 | 来源 | 内容 |
| :--- | :--- | :--- |
| 共享层 | `templates/_base/.agent/` | 11 个 data 目录(inbox / decisions / waitpoints / runs / sessions / missions / handoffs / conversations / memory / agents / tasks),M-001 MS-001 publish |
| 模式层 | `templates/general/.agent/` | workflows / skills / sub-agents / domains / prompts / config,**本任务 publish** |

**`_base/` 是骨架,`general/` 是皮肤**。两者解耦,`code` 模式用 `_base/` + `templates/{zh,en}/`,`general` 模式用 `_base/` + `templates/general/`(本目录)。

## 2. 7 子目录关系图

```
                       ┌─────────────────────────────────┐
                       │  templates/_base/.agent/        │
                       │  (M-001 共享层,11 data 目录)     │
                       │  inbox/decisions/runs/sessions  │
                       │  missions/handoffs/waitpoints   │
                       │  conversations/memory/agents    │
                       │  tasks                          │
                       └────────────────┬────────────────┘
                                        │  init --mode general
                                        v
                       ┌─────────────────────────────────┐
                       │  templates/general/.agent/      │
                       │  (本任务 — 6 模式层子目录)        │
                       └────────────────┬────────────────┘
                                        │
       ┌────────────┬─────────────┬─────┴────┬────────────┬─────────────┐
       v            v             v          v            v             v
   ┌────────┐  ┌────────┐  ┌──────────┐ ┌────────┐  ┌────────┐  ┌──────────┐
   │workflows│  │ skills │  │sub-agents│ │domains│  │prompts│  │  config  │
   │  (4)    │  │  (≥2)  │  │   (≥1)   │ │ (≥1)  │  │ (≥1)  │  │   (≥1)   │
   └────┬───┘  └────┬───┘  └────┬─────┘ └───┬────┘  └───┬────┘  └────┬─────┘
        │           │           │           │           │            │
        │           │           │           │           │            │
        │           │           │           │           │            │
        └────────┬──┴───────────┴───────────┴─────┬─────┴────────────┘
                 │                                │
                 v                                v
          ┌────────────┐                    ┌──────────────┐
          │  行为层     │                    │  配置层       │
          │ workflow   │                    │ system-      │
          │ → skill    │                    │ prompt +     │
          │ → sub-     │                    │ general-     │
          │   agent    │                    │ config.yaml  │
          │ → domain   │                    │              │
          └────────────┘                    └──────────────┘
```

**职责**:
- `workflows/` — 用户入口(/memory recall 等 4 个命令的 frontmatter + 状态机)
- `skills/` — workflow 触发后调用的能力封装(runtime-continuity, memory-curator)
- `sub-agents/` — 长跑 / 跨 session 执行的子任务载体(仅 memory-curator,RFC §6.6 §12 #5 拍板)
- `domains/` — 跨域模板,每个 domain 是一组场景配置(dialogue / knowledge / content / operations)
- `prompts/` — system prompt 模板,general 模式会话起始注入
- `config/` — general 模式专属配置(default config + 行为开关)
- `README.md` — 本文件

## 3. code 模式 vs general 模式 mapping

| 子目录 | `code` 模式来源 | `general` 模式来源 | 备注 |
| :--- | :--- | :--- | :--- |
| `workflows/` | `templates/{zh,en}/.agent/workflows/`(v1.x 20+ 个) | `templates/general/.agent/workflows/`(本任务 4 个) | 完全分立:code 模式装 /ship /prototype /arch-design 等;general 模式装 /memory recall 等 |
| `skills/` | `templates/{zh,en}/.agent/skills/`(v1.x 20+ 个) | `templates/general/.agent/skills/`(本任务 2 个) | 完全分立:code 模式装 architecture-guard / code-review;general 模式装 runtime-continuity + memory-curator |
| `sub-agents/` | `templates/{zh,en}/.agent/sub-agents/`(v1.x 6+ 个) | `templates/general/.agent/sub-agents/`(本任务 1 个) | RFC §6.6 §12 #5 拍板:general 模式**仅** `memory-curator` |
| `domains/` | (无,v1.x 用 `tech-stack.md`) | `templates/general/.agent/domains/`(本任务 1+ 个 + 1 zh 版) | **general 模式新增**:按场景配置(dialogue / knowledge / content / operations)|
| `prompts/` | (无) | `templates/general/.agent/prompts/`(本任务 1 个 + 1 zh 版) | **general 模式新增**:system prompt 模板 |
| `config/` | `templates/{zh,en}/.agent/config/`(v1.x 几个 yaml) | `templates/general/.agent/config/`(本任务 1 个 + 1 zh 版) | 不冲突:general 模式装 `general-config.yaml` 即可;**`templates/{zh,en}/.agent/config/` 零新增**,避免污染 code 模式 init |

**共享层 `_base/`**:
- code 模式与 general 模式**共用**同一套 11 个 data 目录
- code 模式不启用 `conversations/` / `memory/`(可选)
- general 模式 `conversations/` / `memory/` 必装(核心)

## 4. 4 workflow 状态机(简表)

按 D-002-4 拍板:简化为 3 状态 + 失败回滚(RFC §6.5 + M-002 mission-plan §D-002-4)。

| 状态 | 含义 | 进入条件 | 退出条件 |
| :--- | :--- | :--- | :--- |
| `pending` | 等待被 dispatch(尚未 start) | workflow 文件被注册到 `.agent/workflows/` | dispatch 工具将 workflow 实例化为 run,转 `running` |
| `running` | 正在执行 | 前置依赖满足 + 资源可获取 | 完成 → `done`;失败 → 失败回滚 |
| `done` | 已完成(可能成功 / 失败) | `running` 状态终止 | 写 `runs/<run_id>/result.json` + 发 `inbox` 通知父 agent |

**失败回滚规则**(D-002-4 拍板 + RFC §6.5):

1. workflow 失败时,`running` → `done(status=failed)`,**不** 自动 retry
2. 失败时必写 `.agent/runs/<run_id>/error.json`,字段:`error_code` / `error_message` / `stack_trace` / `recoverable`(bool)
3. 父 agent 收到 `inbox` 通知,判断 `recoverable=true` 时可手动 dispatch retry;`recoverable=false` 时必须先修复
4. 涉及外部副作用的 workflow(例:`/agent invoke` 真的发了 HTTP)失败时,必须先 rollback 副作用再置 `done`

**4 workflow 各自的实现责任** — 仅声明 frontmatter + 状态列表,具体实现在 MS-004 收口:

| workflow | 入口命令 | 调用 skill | 调用 sub-agent | 失败回滚责任 |
| :--- | :--- | :--- | :--- | :--- |
| `memory-recall.md` | `/memory recall <query>` | runtime-continuity | (无,只读) | 无副作用,失败仅记 `error.json` |
| `memory-distill.md` | `/memory distill` | (无) | memory-curator | 写 memory 失败 → 删 `draft` 文件 + 通知父 |
| `agent-invoke.md` | `/agent invoke <agent_id> <task>` | runtime-continuity | (按需) | **强**:外部副作用必先 rollback |
| `agent-discover.md` | `/agent discover [query]` | (无) | (无) | 无副作用,失败仅记 `error.json` |

## 5. 双语同步策略

| 内容类型 | 英文 default | 中文版 |
| :--- | :---: | :---: |
| `workflows/*.md` | ✅ `memory-recall.md` 等 4 个 | (M-001 决策:workflow 实现层不需双语,行为不依赖语言) |
| `skills/*/SKILL.md` | ✅ 2 个(英文) | (M-001 决策:同上) |
| `sub-agents/*.md` | ✅ `memory-curator.md` | (M-001 决策:同上) |
| `domains/general-purpose.md` | ✅ 英文 default | ✅ `domains/general-purpose.zh.md` |
| `prompts/system-prompt.md` | ✅ 英文 default | ✅ `prompts/system-prompt.zh.md` |
| `config/general-config.yaml` | ✅ 英文 default | ✅ `config/general-config.zh.yaml` |

**关键决策**:**所有 general 模式专属内容只放 `templates/general/.agent/` 内部**,双语版本以 `<name>.md` + `<name>.zh.md` / `<name>.zh.yaml` 形式共存。

**为什么不在 `templates/{zh,en}/.agent/` 下加 general 专属内容?**

因为 `lib/commands.js` `init()` 的 code 模式路径会全量 `copyRecursive(templates/{zh,en}/.agent/)` 到目标项目(行 181-182)。如果在 `templates/zh/.agent/domains/` 加 `general-purpose.zh.md`,code 模式 init 会**自动 copy** 到所有 code 项目,违反 M-001 binding contract("code 模式 init 行为完全不变")。

**实践**:

- 一般 workflow / skill / sub-agent 写英文 default(M-001 决策:实现层不需双语,行为不依赖语言)
- 用户面向内容(prompt / domain 描述 / config 注释)用 `<name>.md` + `<name>.zh.md` 双语共存
- `templates/{zh,en}/.agent/` **零修改**,纯 v1.x 内容

## 6. 与 M-001 binding contract 的关系

M-001 MS-001 已建立的契约(`templates/_base/.agent/README.md` §1):

> `_base/` 是骨架,模式是皮肤。

本任务(`templates/general/.agent/`)是该契约的**完整落地**:

- **零修改**到 `templates/_base/.agent/`(M-001 拥有,本任务只读)
- **零修改**到 `templates/{zh,en}/` 已有 v1.x 内容(本任务只新增,不删不改)
- **零修改**到 `bin/cli.js` / `lib/commands.js` / `lib/mode-infer.js` / `lib/cli-contract.js` / `package.json` / `CHANGELOG.md`(M-001 binding contract)

本任务的 init 路径(后续 MS-002/003 落地)将让 `cortex-agent init --mode general` 同时 copy `_base/` + `general/`,形成完整 general 模式 `.agent/` 项目。

## 7. Phase 2 验收

依据 RFC §8 Phase 2 + M-002 mission-plan §MS-001:

```text
□ templates/general/.agent/ 7 子目录 publish(workflows / skills / sub-agents / domains / prompts / config + README)
□ 4 workflow frontmatter + 状态列表完整(具体实现在 MS-004)
□ ≥ 2 skill(runtime-continuity copy + memory-curator 新)
□ ≥ 1 sub-agent(memory-curator,RFC §6.6 §12 #5 拍板)
□ ≥ 1 domain(general-purpose 占位)
□ ≥ 1 prompt(system-prompt 模板)
□ ≥ 1 config(general-config.yaml default)
□ 双语同步(prompts/domains/config zh + en 各对齐)
□ templates/_base/ 零修改
□ templates/{zh,en}/ 已有 v1.x 内容零修改
□ bin/cli.js / lib/commands.js / lib/mode-infer.js 零修改
□ 0 npm install(零依赖)
```

## 8. 关联文档

- RFC: [`docs/architecture/general-mode-design.md`](../../../../../docs/architecture/general-mode-design.md) §6.5 / §6.6 / §8 Phase 2 / §12 决策表 / §13.2 v1.11.0 验收
- M-002 mission plan: [`../../../missions/M-002/mission-plan.md`](../../../../../missions/M-002/mission-plan.md)
- M-001 binding contract: [`../../_base/.agent/README.md`](../../_base/.agent/README.md)
- M-008 coordination runtime: [`templates/_shared/.agent/coordination/`](../../_shared/.agent/coordination/)
- Validation contract: `.agent/missions/M-002/validation-contract.json` (M-002 mission plan 引用)
