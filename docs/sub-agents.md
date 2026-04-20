# Sub-agent 架构 (Sub-agents)

> Cortex Agent 通过 **5 个核心**子代理实现职责分离，另有 **会话管理**、**熵治理**等辅助子代理，每个代理有独立的模型、工具权限和上下文边界。

---

## 架构总览

```mermaid
graph LR
    O["🎯 主 AI<br>Orchestrator"] -->|制定计划| PL["planner<br>任务拆解 + 依赖图<br>model: premium"]
    O -->|并行派发| IM["implementer<br>功能实现 + 单元测试<br>model: standard"]
    O -->|并行派发| RS["researcher<br>技术调研 + 方案评估<br>model: standard"]
    O -->|并行派发| CR["code-reviewer<br>架构合规 + 代码质量<br>model: standard"]
    O -->|并行派发| DC["documenter<br>README + API文档 + CHANGELOG<br>model: fast"]

    style O fill:#6366f1,color:#fff,stroke:none
    style PL fill:#0ea5e9,color:#fff,stroke:none
    style IM fill:#10b981,color:#fff,stroke:none
    style RS fill:#f59e0b,color:#fff,stroke:none
    style CR fill:#ef4444,color:#fff,stroke:none
    style DC fill:#8b5cf6,color:#fff,stroke:none
```

模型别名（`premium` / `standard` / `fast`）可在 `.agent/config/reasoning-config.yml` 中统一配置，支持切换 Anthropic、OpenAI、Ollama 等提供商。

---

## 角色职责

| Sub-agent | 职责 | 默认模型 | 触发方式 |
| :--- | :--- | :--- | :--- |
| `planner` | 任务拆解、依赖分析、制定实施计划，输出 `plan_summary` JSON 契约 | premium | `/start-task`、`/parallel` 自动调用 |
| `implementer` | 独立完成功能编码，包含单元测试，输出 `execution_report` JSON 契约 | standard | `/ship`、`/parallel` 派发 |
| `researcher` | 技术调研、方案对比、可行性评估（只读，不写代码）| standard | `/start-task`、`/parallel` 派发 |
| `code-reviewer` | 架构合规、代码质量、性能检查，输出 `review_verdict` JSON 契约 | standard | `/ship`、`/code-review` 自动调用 |
| `documenter` | 同步 README、API 文档、注释、CHANGELOG | fast | `/ship`、`/parallel` 派发 |

此外还有一个专用的熵治理代理：

| Sub-agent | 职责 | 默认模型 | 触发方式 |
| :--- | :--- | :--- | :--- |
| `entropy-scanner` | 扫描 `.agent/references/` 知识库漂移，按 L0-L3 分级自动修复或标记 | fast | PostCommit Hook（L0）、`/ship` ENTROPY_SCAN 阶段（L1）|

长时会话与上下文续接（可选）：

| Sub-agent | 职责 | 默认模型 | 触发方式 |
| :--- | :--- | :--- | :--- |
| `session-manager` | 评估长任务耗时、会话存档/恢复、时间状态、`warm` 预热提示 | fast | 用户显式调用或 `routing-defaults.yml` 中 `session_continuity` 约定 |

---

## 技能挂载

每个 Sub-agent 按职责挂载专项技能（Skills），实现精准的能力覆盖：

```mermaid
graph TB
    subgraph Agents["🤖 Sub-agents"]
        direction LR
        PL[planner]
        IM[implementer]
        CR[code-reviewer]
        O[Orchestrator]
    end

    subgraph Skills["📦 技能库"]
        direction LR
        AG[architecture-guard]
        PG[phase-gate]
        CB[context-budget]
        CE[code-evaluation]
        MT[maturity-tracker]
    end

    PL -->|架构约束感知| AG
    IM -->|编码前预审| AG
    IM -->|实现质量自评| CE
    CR -->|架构合规 + 细粒度约束| AG
    CR -->|质量评分| CE
    O  -->|阶段门控| PG
    O  -->|上下文裁剪| CB
    O  -->|指标收集| MT

    style PL fill:#0ea5e9,color:#fff,stroke:none
    style IM fill:#10b981,color:#fff,stroke:none
    style CR fill:#ef4444,color:#fff,stroke:none
    style O  fill:#6366f1,color:#fff,stroke:none
    style AG fill:#64748b,color:#fff,stroke:none
    style PG fill:#64748b,color:#fff,stroke:none
    style CB fill:#64748b,color:#fff,stroke:none
    style CE fill:#64748b,color:#fff,stroke:none
    style MT fill:#64748b,color:#fff,stroke:none
```

| 技能 | 作用 |
|------|------|
| `architecture-guard` | 合并了 architecture-audit + architecture-check，双层验证：确定性工具扫描 + AI 多维度审查 |
| `phase-gate` | `/ship` 状态机的阶段前置条件检查，硬性阻断不合规的阶段转换 |
| `context-budget` | 按 Tier 0-3 分级裁剪上下文，将每次任务的有效负载控制在窗口 40% 以内 |
| `code-evaluation` | 实现质量自评：可靠性、性能、可维护性三维评分 |
| `maturity-tracker` | 收集每次 `/ship` 的指标数据，驱动 harness 组件的渐进式退化决策 |

---

## Sub-agent 防火墙（输出契约）

所有 Sub-agent 的输出都经过结构化 JSON 契约压缩，防止上下文污染在代理间传播：

```
planner      → plan_summary.json       (~2K tokens，代替完整规划过程的 ~10K tokens)
implementer  → execution_report.json   (files_changed / tests_passed / deviations / blocked_steps)
code-reviewer→ review_verdict.json     (score / blocking_issues / warnings / verdict: PASS|FAIL)
```

`/ship` 完成后，这些中间产物归档到 `.agent/archive/T-xxx/`，主上下文清零（`CONTEXT_CLEANUP` 阶段）。

---

## 路由配置

默认路由规则定义在 `.agent/sub-agents/routing-defaults.yml`：

- **`/start-task` 流水线**：`researcher` → `planner`（顺序，调研先于规划）
- **`/ship` 流水线**：`implementer` → `code-reviewer` → `documenter`（顺序，有依赖）
- **快速模式**（`fast_mode: true`）：跳过 `code-reviewer`
- **轻量模式**（`lightweight_mode: true`）：跳过 `documenter`

---

## 模型配置

Sub-agent 的模型可通过 `/configure-model` 工作流统一配置，支持：
- 切换 AI 提供商（Anthropic / OpenAI / Azure / Ollama）
- 调整每个角色的模型别名（premium / standard / fast）
- 一键切换成本模式（conservative / balanced / quality）

> 详见 [模型与 API 配置](../templates/zh/.agent/config/reasoning-config.yml)。
