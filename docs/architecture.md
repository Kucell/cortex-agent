# Cortex Agent — 架构设计文档

本文档描述 Cortex Agent 当前的整体架构、知识分层、Sub-agent 角色，以及主要工作流的协作方式。

---

## 一、整体架构

```mermaid
graph TD
    subgraph Entry["入口层"]
        A1["AGENTS.md"]
        A2["CLAUDE.md / GEMINI.md / Codex"]
    end

    subgraph Governance[".agent/ — 治理层"]
        G1["rules/<br/>底线约束"]
        G2["workflows/<br/>开发 SOP"]
        G3["skills/<br/>复用能力"]
        G4["sub-agents/<br/>角色分工"]
        G5["hooks/<br/>自动化 Gate"]
        G6["plans/<br/>执行中进度"]
    end

    subgraph Knowledge["docs/ — 知识层"]
        K1["architecture/"]
        K2["exec-plans/"]
        K3["quality/"]
        K4["reliability/"]
        K5["security/"]
        K6["tech-debt.md"]
    end

    Entry --> Governance
    Entry --> Knowledge
    G2 --> G3
    G2 --> G4
    G5 --> G3
    G6 -.长期沉淀.-> K2
```

**核心原则：**

- `.agent/` 是执行期治理的真理来源
- `docs/` 是长期知识资产的承接层
- 各 AI 工具通过入口文件读取同一套规则和知识，不维护多份分叉副本

---

## 二、目录职责一览

| 目录 | 职责 | 修改时机 |
| :--- | :--- | :--- |
| `rules/` | 定义 AI 必须遵守的底线（架构、代码、提交规范、语言约定） | 架构变更、新增语言规范时 |
| `workflows/` | 预定义开发场景的 SOP，通过斜杠命令触发 | 新增/优化开发流程时 |
| `skills/` | 封装可复用的复杂逻辑，供工作流和 sub-agent 调用 | 抽取通用能力时 |
| `sub-agents/` | 专职代理，有独立模型、工具权限和上下文边界 | 新增专业领域代理时 |
| `hooks/` | 事件驱动，在文件编辑、提交等关键操作前后自动执行 | 需要强制策略或自动化时 |
| `plans/` | 存储当前路线图和任务进度，让 AI 随时掌握项目状态 | 每次任务规划/交付时更新 |
| `docs/architecture/` | 记录架构设计、演进方案和高层设计决策 | 架构演进或设计收敛时 |
| `docs/exec-plans/` | 记录跨会话、可追踪的执行计划资产 | 大任务启动、阶段切换或归档时 |
| `docs/quality/` | 记录质量标准、质量度量和后续 lint 策略 | 质量规则收敛时 |
| `docs/reliability/` | 记录可观测性、运行时验证与可靠性实践 | 增加验证与观测能力时 |
| `docs/security/` | 记录安全边界、扫描与治理策略 | 安全策略明确化时 |
| `docs/tech-debt.md` | 统一记录已知债务及偿还路径 | 发现结构性债务时 |

---

## 三、Sub-agent 架构

### 3.1 代理总览

```mermaid
graph LR
    O["🎯 主 AI<br/>Orchestrator"] -->|调研与规划| RS["researcher<br/>技术调研 + 方案评估<br/>model: sonnet"]
    O -->|制定计划| PL["planner<br/>任务拆解 + plan_summary<br/>model: sonnet"]
    O -->|实现| IM["implementer<br/>功能实现 + execution_report<br/>model: sonnet"]
    O -->|审查| CR["code-reviewer<br/>结构化审查 + verdict<br/>model: sonnet"]
    O -->|文档补充| DC["documenter<br/>轻量文档更新<br/>model: haiku"]

    style O fill:#6366f1,color:#fff,stroke:none
    style PL fill:#0ea5e9,color:#fff,stroke:none
    style IM fill:#10b981,color:#fff,stroke:none
    style RS fill:#f59e0b,color:#fff,stroke:none
    style CR fill:#ef4444,color:#fff,stroke:none
    style DC fill:#8b5cf6,color:#fff,stroke:none
```

### 3.2 代理职责与触发方式

| Sub-agent | 模型 | 职责 | 触发方式 |
| :--- | :--- | :--- | :--- |
| `planner` | sonnet | 任务拆解、依赖分析、制定实施计划，输出 `plan_summary` | `/start-task` 自动调用 |
| `implementer` | sonnet | 独立完成功能编码，包含单元测试与实现报告 | `/ship` 默认流水线；并行任务中可实例化多个 |
| `researcher` | sonnet | 技术调研、方案对比、可行性评估（只读） | `/start-task` 默认前置调研；复杂任务可独立派发 |
| `code-reviewer` | sonnet | 架构合规、代码质量、安全和结构化 verdict 输出 | `/ship`、`/code-review` 自动调用 |
| `documenter` | haiku | 轻量文档更新，如 README / API 文档 / CHANGELOG | `/ship` 或手动流程按需调用 |

---

## 四、Skills 与 Sub-agent 挂载关系

每个 Sub-agent 只挂载它职责范围内**确实需要**的技能，避免权限过宽。

```mermaid
graph TB
    subgraph Agents["🤖 Sub-agents"]
        direction LR
        PL[planner]
        IM[implementer]
        CR[code-reviewer]
        RS["researcher<br/>— 默认无挂载"]
        DC["documenter<br/>— 默认无挂载"]
    end

    subgraph Skills["📦 技能库 (skills/)"]
        direction LR
        AG["architecture-guard<br/>架构守卫"]
        CE["code-evaluation<br/>代码质量评分"]
        SS["security-scan<br/>安全扫描"]
    end

    PL -->|规划前审查| AG
    IM -->|编码前预审| AG
    IM -->|实现质量自评| CE
    CR -->|架构合规| AG
    CR -->|质量评分| CE
    CR -->|安全审查| SS

    style PL fill:#0ea5e9,color:#fff,stroke:none
    style IM fill:#10b981,color:#fff,stroke:none
    style CR fill:#ef4444,color:#fff,stroke:none
    style RS fill:#6b7280,color:#fff,stroke:none
    style DC fill:#8b5cf6,color:#fff,stroke:none
    style AG fill:#0ea5e9,color:#fff,stroke:none
    style CE fill:#0ea5e9,color:#fff,stroke:none
    style SS fill:#0ea5e9,color:#fff,stroke:none
```

### 挂载逻辑说明

| Sub-agent | 挂载的 Skills | 挂载原因 |
| :--- | :--- | :--- |
| `planner` | `architecture-guard` | 规划阶段先确认任务边界与架构约束 |
| `implementer` | `architecture-guard` + `code-evaluation` | 编码前审查结构，编码后做实现质量自评 |
| `code-reviewer` | `architecture-guard` + `code-evaluation` + `security-scan` | 审查阶段同时覆盖架构、质量和安全 |
| `researcher` | 无 | 保持只读调研，避免角色越界 |
| `documenter` | 无 | 专注轻量文档同步 |

除 sub-agent 挂载的技能外，仓库还保留直接调用型技能，用于维护知识与治理资产，例如 `knowledge-lint` 与 `doc-gardening`。

---

## 五、完整开发链路

```mermaid
flowchart TD
    A([💡 有想法]) --> B

    subgraph 方案设计
        B["/arch-design"] --> C{确认?}
        C -->|修改| B
    end

    subgraph 任务规划
        C -->|确认| D["/plan"]
        D --> E["docs/exec-plans/active/<plan>.md"]
        E --> F["/briefing"]
    end

    subgraph 任务执行
        F --> G["/start-task T-xxx"]
        G --> H([🔨 编码])
    end

    subgraph 任务交付
        H --> I["/ship T-xxx"]
        I --> J["code-review<br/>commit<br/>done<br/>sync-plans"]
        J --> K([✅ 完成])
    end

    K -->|归档| L["docs/exec-plans/completed/"]
    K -->|循环| F

    style D fill:#4a9eff,color:#fff,stroke:none
    style I fill:#4a9eff,color:#fff,stroke:none
```

> **推荐节奏**：`/briefing` 同步上下文 → `/arch-design` 收敛方案 → `/plan` 形成任务 → `/start-task` 执行 → `/ship` 交付。

---

## 六、Mission Lite 长周期任务编排

Mission Lite 是 Cortex Agent 面向长周期、多功能、多里程碑任务的编排层。它借鉴 Factory Missions 的可靠性思想，但保持 Cortex 的轻量架构：不引入新的运行时依赖，不把所有任务都升级为重型流程，只在任务规模超过普通 `/start-task` + `/ship` 能稳定承载时启用。

详细设计见 [Mission Lite 架构设计方案](architecture/mission-lite-design.md)。

### 6.1 适用边界

| 场景 | 推荐流程 |
| :--- | :--- |
| 单点 bug、单文件修复、轻量文档更新 | `/bug-fix` 或直接 `/ship` |
| 一个明确功能、可在单次上下文内完成 | `/start-task` → `/ship` |
| 多功能、多子系统、需要数小时到数天推进 | Mission Lite |
| 跨 Agent 或跨会话切换 | `/handoff` |

Mission Lite 的目标不是最大化并行，而是最大化长周期任务的稳定性。默认策略是：代码修改串行，研究、验证和文档类工作可并行。

### 6.2 三角色模型

```mermaid
flowchart TD
    O["Orchestrator<br/>编排器"] --> P["Mission Plan<br/>features + milestones + validation contracts"]
    P --> W["Worker<br/>执行者"]
    W --> H["Structured Handoff<br/>git state + progress + command log"]
    H --> V["Validator<br/>验证者"]
    V --> R{Validation Result}
    R -->|PASS| N["Next Milestone"]
    R -->|FAIL| F["Follow-up Fix Task"]
    F --> O
    N --> O

    style O fill:#6366f1,color:#fff,stroke:none
    style W fill:#10b981,color:#fff,stroke:none
    style V fill:#ef4444,color:#fff,stroke:none
```

| 角色 | 职责 | 不做什么 |
| :--- | :--- | :--- |
| Orchestrator | 拆解 features / milestones，维护任务顺序，创建修复任务 | 不直接写业务代码 |
| Worker | 在干净上下文中实现单个 feature，提交结构化结果 | 不重写 mission 计划，不扩大范围 |
| Validator | 按验证契约做对抗式检查，运行测试和必要的 runtime 验证 | 不依赖 Worker 的自我解释 |

### 6.3 核心产物

Mission Lite 应把状态写入文件，而不是依赖对话记忆：

```text
.agent/missions/M-xxx/
├── mission-plan.md
├── validation-contract.json
├── command-log.md
├── milestones/
│   └── MS-001.md
└── handoffs/
    └── YYYYMMDD-HHMMSS-{focus}.md
```

| 产物 | 作用 |
| :--- | :--- |
| `mission-plan.md` | 记录 feature、milestone、顺序、范围和退出条件 |
| `validation-contract.json` | 记录可执行或可审查的验收断言 |
| `command-log.md` | 记录命令、exit code、结果和后续动作 |
| `milestones/*.md` | 记录每个 checkpoint 的状态、验证结论和修复项 |
| `handoffs/*.md` | 复用 `/handoff` 的通用交接模板 |

### 6.4 验证契约

Mission Lite 要求计划阶段先产出验证契约，再允许进入实现。契约不追求一次性覆盖所有细节，但必须让 Validator 有明确检查依据。

```json
{
  "mission_id": "M-001",
  "milestone_id": "MS-001",
  "assertions": [
    {
      "id": "VC-001",
      "type": "test",
      "command": "npm test -- auth",
      "assertion": "invalid password returns 401",
      "blocking": true
    },
    {
      "id": "VC-002",
      "type": "docs",
      "assertion": "public API changes are reflected in INTERFACES.md",
      "blocking": true
    },
    {
      "id": "VC-003",
      "type": "runtime",
      "assertion": "primary UI flow renders and completes without console errors",
      "blocking": false
    }
  ]
}
```

验证契约的来源应优先复用现有资产：

- `.agent/plans/context-manifest.json` 提供相关上下文范围
- `docs/reliability/*` 提供 runtime evidence 和浏览器验证模板
- `.agent/rules/integration-safety.md` 提供接口契约一致性要求
- `/handoff` 提供跨 Agent / 跨会话的结构化交接格式

### 6.5 执行策略

Mission Lite 的默认状态流：

```text
SCOPE → PLAN → CONTRACT → EXECUTE_FEATURE → HANDOFF → VALIDATE_MILESTONE → FIX_OR_ADVANCE → COMPLETE
```

关键约束：

- `CONTRACT` 必须早于 `EXECUTE_FEATURE`
- 每个 milestone 结束必须验证
- Validator 只读取计划、验证契约、diff、命令日志和必要源码
- Worker 的自然语言解释不能作为验证依据
- 失败时由 Orchestrator 创建 follow-up fix task，而不是让 Worker 无限自修
- 命令执行必须记录 exit code；未运行的命令也要记录原因

### 6.6 与现有工作流的关系

| 现有能力 | Mission Lite 中的角色 |
| :--- | :--- |
| `/start-task` | 仍用于启动单个 feature 或 fix task |
| `/ship` | 仍用于单个任务交付；Mission Lite 在 milestone 层聚合多个 `/ship` 结果 |
| `/parallel` | 仅用于只读研究、验证和明确无共享文件的任务 |
| `/handoff` | 作为 Worker / Validator / 新会话之间的标准交接格式 |
| `phase-gate` | 后续可扩展为 Mission 状态转换前置检查 |
| `knowledge-lint` / `doc-gardening` | Mission 完成后维护知识资产健康度 |

---

## 七、Hooks 触发机制

```mermaid
sequenceDiagram
    participant IDE as AI 助手
    participant Hook as hooks/
    participant Skill as skills/

    IDE->>Hook: 触发 PostToolUse (Write/Edit)
    Hook->>Hook: 先运行确定性检查
    Hook->>Skill: 再调用 AI 质量能力
    Skill-->>Hook: 返回审查结果
    Hook-->>IDE: 有问题则阻断并提示修复
```

当前注册的 Hooks：
- `PostToolUse(Write, Edit)` → 确定性检查优先，再触发 AI 审查
- `PostCommit` → 轻量熵治理与自动清理

---

## 八、版本与演进

架构变更时，请至少同步以下资产：

- `docs/architecture.md`
- `docs/architecture/*.md`
- `.agent/plans/task-progress.md`
- `docs/exec-plans/active/` 或 `docs/exec-plans/completed/`
