---
name: spec
description: "Lightweight structured Spec workflow for non-dev or one-off doc/analysis tasks. Guides users through field-by-field clarification, writes a Spec to .agent/specs/, and tracks execution against acceptance criteria."
type: procedure
applicable_to:
  - all
inputs:
  - 用户口头/模糊需求（如"帮我做简报"、"帮我优化登录逻辑"）
outputs:
  - ".agent/specs/<spec-id>/spec.md"
  - ".agent/specs/<spec-id>/state.json"
  - ".agent/specs/index.json（追加登记）"
linked_skills:
  - validation-contract（VERIFY 阶段 drift-check）
  - ai-behavior（两步确认；与 P-002 联动）
linked_rules:
  - ai-behavior.md §6 两步确认
  - rules/judgment.md silent-failure 检查（P-002）
linked_workflows:
  - prd.md（升级路径：需要多轮评审/UI 设计时转 /prd）
  - plan.md（升级路径：需要长期追踪/跨会话时转 /plan）
  - mission.md（升级路径：需要里程碑验证时转 /mission）
owner: Kucell
last_verified: 2026-08-19
status: stable
---

# 轻量 Spec 工作流 (/spec)

## Usage

```text
/spec start "<spec-id>" "<initial 需求描述>"
/spec status [<spec-id>]
/spec clarify <spec-id> [--field <field-name>]
/spec execute <spec-id>
/spec verify <spec-id>
/spec deliver <spec-id>
/spec upgrade <spec-id> --to prd|plan|mission
```

> 调用方式：用户口头/模糊需求 → AI 自动建议 `/spec start "<id>" "<需求>"` 并进入 CLARIFY。

## Purpose

为**非开发任务**（简报、调研、文档、一次性分析）与**轻量编程任务**（范围明确的单点改动）提供结构化 Spec 入口。把"差指令 vs 好指令"固化为模板与清单，让意图精确度对所有任务类型生效。

## Status Machine

```
IDEA → CLARIFY → SPEC → EXECUTE → VERIFY → DELIVER
                                              ↘ DROPPED（升级到 /prd 或 /plan）
```

无 Task Pipeline gate，不创建 `.agent/tasks/<id>.json` 记录；需要长期追踪时升级到 `/prd` / `/plan` / `/mission`。

## 与相邻工作流的边界

| 工作流 | 适用场景 | 升级路径（来自 /spec） |
| :--- | :--- | :--- |
| `/spec`（本工作流） | 一次性文档/分析任务；范围明确的单点改动 | — |
| `/prd` | 多轮评审、UI/视觉设计、跨团队 PRD | "需要多轮评审" → `/prd upgrade` |
| `/plan` | 长期开发任务，需要 Task Pipeline gate 追踪 | "需要 Task Pipeline 追踪" → `/plan` |
| `/mission` | 多里程碑、跨会话、需独立验证 | "需要里程碑验证" → `/mission` |

## Data Layout

```text
.agent/specs/
├── index.json                      # spec 登记索引（id / title / status / updated_at）
├── README.md                       # 数据布局说明
└── <spec-id>/
    ├── spec.md                     # Spec 正文（按 resources/templates/spec.md 填充）
    └── state.json                  # 状态机：idea|clarify|spec|execute|verify|deliver|dropped
```

## Step-by-Step

### 1. CLARIFY（澄清阶段）

按 `resources/templates/spec.md` 必填字段逐字段引导用户澄清：

- **文档/分析任务** 必填：受众、目标、非目标、输出格式、篇幅与结构、风格约束、数据与来源约束、成功标准
- **编程任务** 必填：目标、非目标、范围、边界、验收标准、禁止事项（与 `architecture-design.md`、`test-policy.md` 对齐）

字段缺失时给出**差/好指令对照示例**：

```text
❌ 差指令："帮我做简报"
✅ 好指令：8页简报；受众是非技术主管；结论优先；机会/风险/下一步；不写技术细节
```

禁止 AI 自行猜测后跳过字段。每填完一组必填字段，更新 `state.json` → `clarify` → `spec`。

### 2. SPEC（写入阶段）

把澄清结果写入 `.agent/specs/<spec-id>/spec.md`（严格按模板填充），同时：

- 写 `.agent/specs/<spec-id>/state.json` 记录状态机 + 时间戳
- 追加登记到 `.agent/specs/index.json`：

```json
{
  "specs": [
    {
      "id": "<spec-id>",
      "title": "<标题>",
      "status": "spec",
      "task_type": "doc | analysis | code | other",
      "created_at": "<iso>",
      "updated_at": "<iso>",
      "spec_path": ".agent/specs/<spec-id>/spec.md"
    }
  ]
}
```

state.json 推进到 `spec`。

### 3. EXECUTE（执行阶段）

AI 严格按 Spec 执行：

- 每完成一个字段对应产出即勾选验收清单 checkbox
- 长任务可分多轮：每轮开始前先回读 Spec 防漂移（与 P-002 drift-check 联动）
- 状态写入 `state.json`：进入 `execute` 时记录 `execute_started_at`，每个验证项完成后更新 `checklist_progress`

### 4. VERIFY（验收阶段）

对照成功标准自检：

- 文档类：受众可读、结论可溯源、未超出非目标范围
- 编程类：测试通过、边界守住、禁止事项未触碰、依赖零增量

调用 `validation-contract` skill（CHECK 阶段）的 `drift-check` 断言：

```
node .agent/skills/validation-contract/scripts/index.js check \
  --contract .agent/specs/<spec-id>/spec.md \
  --assertion drift-check \
  --evidence <diff_or_artifact_path>
```

VERIFY 失败 → 回 EXECUTE（状态写 `verify` → `execute`）；通过 → 状态写 `verify` + `verified_at`。

### 5. DELIVER（交付阶段）

输出：

- 产物路径（按 Spec 约定）
- Spec 回读确认（"我按这份 Spec 做了 X，未做 Y"）
- 状态推进到 `deliver`，更新 `index.json` 与 `state.json`

## Non-Goals

- 不创建 Task Pipeline gate / Mission 状态机（轻量交付；需要时升级）
- 不做多轮评审 / UI 设计 / 视觉稿（属于 `/prd` + `/prototype`）
- 不自动采集用户对话内容生成 Spec（字段由用户显式确认，遵守隐私边界）
- 不引入任何 npm 第三方运行时依赖
- 不触碰既有 `/start-task`、`/prd`、`/plan`、`/mission` 工作流的既有契约（仅在 `/start-task` 前置澄清清单步骤，详见 start-task.md §3.5）

## Verification

- Phase 1 自举：cortex-agent 主仓库 `.agent/specs/` 创建一份示例 Spec（如本文档自身的中文摘要简报），跑通 CLARIFY → DELIVER 全链路
- Phase 2 模板同步：`templates/{zh,en}/.agent/workflows/spec.md` + `templates/{zh,en}/.agent/resources/templates/spec.md` 对齐
- Phase 3 升级路径实测：在 DELIVER 后调 `/spec upgrade --to prd|plan|mission`，验证状态机正确推进
- Phase 4 实战验证：下发 samhmi 或其他下游项目，跑一份真实 Spec

## Cross-References

- M-028 / MS-001（执行载体）
- P-001 轻量 Spec 工作流提案（源）
- P-002 Judgment Risk Taxonomy（drift-check 联动）
- `.agent/rules/ai-behavior.md` §6 两步确认
- `.agent/rules/architecture-design.md`（编程任务范围/边界对齐）
- `.agent/rules/test-policy.md`（编程任务验收标准对齐）