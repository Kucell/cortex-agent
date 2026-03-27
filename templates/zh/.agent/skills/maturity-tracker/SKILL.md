---
name: maturity-tracker
description: Harness 组件成熟度追踪。在 /ship CLEAN 阶段收集各组件表现指标，写入 metrics/component-health.json，供 /briefing 展示成熟度看板和退化决策依据。
---

# Maturity Tracker Skill

## 目标

收集 Harness 各组件的表现指标，追踪其成熟度演进，为渐进式退化决策提供数据支撑。

## 调用时机

在 `/ship` 的 `CLEAN` 最终状态后自动调用（即 ENTROPY_SCAN 完成后）。

## 收集的指标

### context_budget（上下文预算）
- `overflow_prevented`：本次任务是否因预算控制避免了超出 40%（boolean）
- `actual_utilization`：读取 `context-manifest.json` 的 `utilization` 字段
- `within_limit`：读取 `context-manifest.json` 的 `within_limit` 字段

### reasoning_sandwich（推理三明治）
- `first_pass`：本次 /ship 是否一次通过（reviewer verdict = PASS，retry_count = 0）
- `retry_count`：读取 ship 执行日志中的重试次数
- `cost_mode_used`：读取 `reasoning-config.yml` 的 `cost_mode`

### agent_firewall（防火墙）
- `contamination_detected`：读取 `review_verdict.json` 的 `input_contamination` 字段
- `blocked_steps_count`：读取 `execution_report.json` 的 `blocked_steps` 数量

### entropy_scanner（熵治理）
- `health_score`：读取 `entropy-report.json` 的 `health_score`
- `auto_fixes`：读取 `entropy-report.json` 的 `auto_fixed` 数量
- `l2_pending`：读取 `entropy-report.json` 的 `pending_human` 数量

### phase_gate（阶段门控）
- `gates_passed`：本次 /ship 成功通过的 gate 数量（读取 ship 执行日志）
- `gates_blocked`：被 gate 阻断的次数

## 输出格式

将指标追加到 `.agent/metrics/component-health.json`（滚动保留最近 30 条记录）：

```json
{
  "records": [
    {
      "task_id": "T-xxx",
      "timestamp": "2026-03-27T10:30:00Z",
      "metrics": {
        "context_budget": {
          "overflow_prevented": true,
          "actual_utilization": "25.4%",
          "within_limit": true
        },
        "reasoning_sandwich": {
          "first_pass": true,
          "retry_count": 0,
          "cost_mode_used": "balanced"
        },
        "agent_firewall": {
          "contamination_detected": false,
          "blocked_steps_count": 0
        },
        "entropy_scanner": {
          "health_score": 92,
          "auto_fixes": 1,
          "l2_pending": 0
        },
        "phase_gate": {
          "gates_passed": 6,
          "gates_blocked": 0
        }
      }
    }
  ],
  "rolling_averages": {
    "window_days": 30,
    "context_budget": {
      "overflow_rate": "0%",
      "avg_utilization": "28.3%"
    },
    "reasoning_sandwich": {
      "first_pass_rate": "87.5%",
      "avg_retry_count": 0.13
    },
    "agent_firewall": {
      "contamination_rate": "0%",
      "avg_blocked_steps": 0.1
    },
    "entropy_scanner": {
      "avg_health_score": 89,
      "avg_auto_fixes_per_ship": 0.8
    },
    "phase_gate": {
      "avg_gates_blocked_per_ship": 0.2
    }
  },
  "last_updated": "2026-03-27",
  "total_records": 8
}
```

## 退化建议生成

读取 `harness-manifest.yml` 中每个组件的退化条件，对比 `rolling_averages` 中的指标：

若某组件满足 `advisory` 触发条件：
```
⚡ [context_budget] 退化建议：连续 30 天 overflow_rate = 0%，满足 advisory 条件。
   建议将 40% 硬上限改为 60% 软建议。
   操作：手动修改 harness-manifest.yml 中 context_budget.status = advisory
```

此建议输出到 `metrics/component-health.json` 的 `degradation_suggestions` 字段，并在 `/briefing` 成熟度看板中展示。

## 数据丢失处理

若某次 /ship 缺少某组件的数据文件（如未生成 context-manifest.json），对应指标记录为 `null`，不影响其他指标的收集。
