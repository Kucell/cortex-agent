---
name: recalibrate
description: "持续校准闭环（P-003）：模型/配置变更后重跑核心工作流基线，产出质量/成本/时长三维对比并写 metrics/model-calibration.json；仅显著退化才落 boundary-signal 经验；结论经 /briefing 只读展示。不自动执行、不自动切换模型。"
type: procedure
applicable_to:
  - all
inputs:
  - "最近一次 provider/model 或角色分配变更（来自 /configure-model 的提示；无变更时也可手动触发）"
  - "既有基线 metrics/model-calibration.json（无基线时本工作流先建立首份）"
outputs:
  - ".agent/metrics/model-calibration.json（追加或新建校准记录，模型维度对比的唯一事实源）"
  - ".agent/experiences/（仅显著退化时追加一条 boundary-signal 经验：EXP-xxx.md + index.json 登记）"
linked_skills:
  - agent-review-benchmark（benchmark 引擎：质量/成本/时长三维字段与不合并分数的完整性规则）
  - experience-recall（boundary-signal 经验的检索消费方）
linked_rules:
  - ../rules/ai-behavior.md（不自动执行 / 不自动切换模型的边界）
linked_workflows:
  - configure-model.md（模型/配置变更入口，切换后提示运行本工作流）
  - briefing.md（校准摘要的只读展示面）
  - ship.md（代表工作流来源：REVIEW→COMMIT 链路）
owner: Kucell
last_verified: 2026-08-19
status: stable
---

<!-- EN translation pending: structural English skeleton; detailed Chinese body below is the source of truth. TODO: translate the 6-step flow details, the record JSON schema, and the output summary into English. -->

# Continuous Calibration Workflow (/recalibrate)

> Background: P-003 "continuous calibration loop" (ai-native-work-mode). After a model/config change, capability boundaries drift;
> this workflow turns "re-run the core workflow baseline" into a repeatable, comparable, traceable process, and explicitly
> captures "unexpected behavior" as a calibration signal.

## Hard Boundaries (read first)

1. **Never auto-runs**: this workflow only prompts and records; it is off by default and is triggered explicitly by the user or by the `/configure-model` switch prompt. Never run on a schedule or on its own.
2. **Never auto-switches models / never upgrades config**: model and role assignment are exclusively owned by `/configure-model`; this workflow only reads config, runs the baseline, and writes records. It never modifies `config/reasoning-config.yml` or the sub-agent `model:` fields.
3. **Lightweight**: re-testing only runs the core workflow baseline (1 representative workflow or a minimal reproducible benchmark subset), not the full task set, to control token and time cost.
4. **Privacy boundary**: only explicitly opted-in summary information is recorded (model, config summary, three-dimensional metrics, lessons learned); no session content is captured.

## Flow (6 steps)

### 1. Read the current config

读取 `.agent/config/reasoning-config.yml` 的 provider / 模型别名 / 角色分配，以及 sub-agent 的 `model:` 字段，得到当前生效的模型身份：

```text
provider    → {api.provider}
cost_mode   → {active_mode}
模型别名     → fast / standard / premium 的实际模型 ID
角色分配     → planner / implementer / code_reviewer / documenter / entropy_scanner …
```

同时计算 `config_hash`（`reasoning-config.yml` 的内容摘要，如 SHA-256），作为本次校准记录与既有记录对比的配置指纹。若 `reasoning-config.yml` 路径不同（项目定制），按实际存在的配置路径读取并记录实际路径。

### 2. Baseline selection

读取 `.agent/metrics/model-calibration.json`：

- **有基线 (baseline exists)**: take the newest `baselines[]` entry (most recent `date`) and record its `baseline_family` / `representative_workflow` / `dataset_id` / `dataset_version`.
- **无基线 (no baseline)**: establish the first baseline first (step 3) as the anchor for all future comparisons.

### 3. Re-run the core workflow baseline

调用 `agent-review-benchmark` 引擎（`benchmark` 模式）跑**同一数据集**，或跑 1 个代表性核心工作流。

> **固化代表工作流选取标准 (frozen representative-workflow selection criteria)**:
> - Prefer the `/ship` REVIEW→COMMIT chain;
> - or the minimal reproducible subset of the benchmark case set (minimum case set covering REVIEW gate evidence + COMMIT gate evidence + lint checks).
> - **Within one baseline family the representative workflow must not change** — every re-run must use the same `dataset_id` / `dataset_version` (or the same representative workflow), otherwise the comparison is invalid.

```bash
node .agent/skills/agent-review-benchmark/scripts/index.js benchmark \
  --input <benchmark-input.json> --output <benchmark-summary.json>
```

记录每次运行的三维原始值（整数）：`quality_basis_points` / `cost_microunits` / `duration_ms`，以及 `passed_assertions` / `total_assertions` 与证据引用。

### 4. Compare

按 `agent-review-benchmark` 完整性规则做**三维独立对比，不合并为单一分数**：

| 维度 (Dimension) | 字段 (Field) | 与上一基线对比 (vs previous baseline) |
| :--- | :--- | :--- |
| 质量 (Quality) | `quality_basis_points`（0–10000，断言加权通过率） | Δ 质量 |
| 成本 (Cost) | `cost_microunits`（整数微单位） | Δ 成本 |
| 时长 (Duration) | `duration_ms`（毫秒） | Δ 时长 |

三维各自独立展示升降，禁止折算成单一「分数」；任何单维波动都需要结合断言数与证据解读，不凭单个数字下结论。

### 5. Record

把本次校准追加写入 `.agent/metrics/model-calibration.json`（唯一事实源），每条记录含：

```json
{
  "baseline_id": "CALIB-YYYY-MM-DD-NNN",
  "baseline_family": "<代表工作流/数据集族名>",
  "representative_workflow": "<固化的代表工作流描述>",
  "provider": "<provider>",
  "model": "<provider>/<model>",
  "config_hash": "<reasoning-config 内容摘要>",
  "date": "YYYY-MM-DD",
  "dimensions": {
    "quality_basis_points": 0,
    "cost_microunits": 0,
    "duration_ms": 0
  },
  "comparison": {
    "vs_baseline_id": "<上一基线 id 或 null>",
    "delta_quality_basis_points": 0,
    "delta_cost_microunits": 0,
    "delta_duration_ms": 0
  }
}
```

### 6. Feed back

- **对比事实**：全部写入 `metrics/model-calibration.json`（唯一事实源），不留副本。
- **/briefing 只读展示**：校准摘要（最新基线 + 三维对比）由 `/briefing` 只读展示，不触发任何动作（briefing 是只读通信表面）。
- **boundary-signal**：仅**显著退化**（如质量分下降超过预设阈值，或出现 `boundary-breakdown` 类失效）才落一条 `boundary-signal` 经验（type: `boundary-signal`，见 `.agent/experiences/index.json` 登记格式），避免信号噪音；正常波动不落经验。

## Output Summary

```text
✅ 校准完成
──────────────────────────────
候选：{provider}/{model}（config_hash: {前 8 位}）
代表工作流：{固化代表工作流}（family: {baseline_family}）
三维对比（vs {上一基线 id}）：
  质量 {quality_basis_points}（Δ{delta_quality}）
  成本 {cost_microunits}（Δ{delta_cost}）
  时长 {duration_ms}（Δ{delta_duration}）
结论：{无显著退化 / 显著退化（已落 boundary-signal EXP-xxx）}
──────────────────────────────
```

## Relations to Adjacent Workflows

- `/configure-model`: 模型/配置变更入口；切换后**建议**运行本工作流重测基线（suggestion only，不自动运行）。
- `/briefing`: 只读展示校准摘要，不写不触发。
- `agent-review-benchmark`: 引擎保持不变，本工作流是其引导式入口。
- `maturity-tracker`: `component-health.json` 保持组件维度；模型维度统一走 `model-calibration.json`，两者不混叠。
