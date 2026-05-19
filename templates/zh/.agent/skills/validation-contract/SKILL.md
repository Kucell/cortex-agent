---
name: validation-contract
description: 在实现开始前，为 Mission Lite milestone 和高风险任务创建、检查、压缩可执行验证契约。
---

# Validation Contract Skill

## 目标

当任务需要在实现前明确验证标准时，使用本技能。它会把目标、范围、验收标准、API 契约和运行时预期转成结构化断言，让 Worker 按契约实现，让 Validator 独立检查。

Mission Lite milestone 必须使用本技能；高风险 `/start-task` 或 `/ship` 任务建议使用本技能。

## 模式

### CREATE

从任务、feature 或 milestone 描述创建 `validation_contract` JSON 对象。

输入：

- Mission 或任务 ID
- Feature 或 milestone 范围
- 相关文件或模块
- 验收标准
- Public API 或文档影响
- 运行时证据需求，如有

输出：

```json
{
  "type": "validation_contract",
  "mission_id": "M-001",
  "task_id": "T-H25",
  "milestone_id": "MS-001",
  "scope": {
    "feature": "validation-contract-skill",
    "files": [
      ".agent/skills/validation-contract/SKILL.md",
      "templates/en/.agent/skills/validation-contract/SKILL.md",
      "templates/zh/.agent/skills/validation-contract/SKILL.md"
    ]
  },
  "assertions": [
    {
      "id": "VC-001",
      "type": "docs",
      "assertion": "The skill defines CREATE, CHECK, and SUMMARIZE modes.",
      "evidence": ".agent/skills/validation-contract/SKILL.md",
      "blocking": true
    }
  ]
}
```

### CHECK

检查已有契约是否完整。

必检项：

1. `type` 必须是 `validation_contract`。
2. 至少存在 `mission_id` 或 `task_id`。
3. 必须存在 `scope.feature`。
4. `assertions` 必须是非空数组。
5. 每条 assertion 必须包含 `id`、`type`、`assertion`、`blocking`。
6. 每个 milestone 至少有一条 `blocking: true` assertion。
7. `type: "test"`、`typecheck`、`lint` 的 assertion 应包含 `command`。
8. 没有 `command` 的 assertion 必须包含 `evidence` 或清晰的人工验证依据。
9. Public API 变化必须包含至少一条 `api` 或 `docs` assertion。
10. Runtime 断言必须引用 runtime evidence 来源或模板。

输出紧凑报告：

```json
{
  "type": "validation_contract_check",
  "status": "PASS",
  "blocking_issues": [],
  "warnings": [],
  "coverage_gaps": []
}
```

### SUMMARIZE

为 handoff 或 reviewer 输入压缩契约。

摘要必须包含：

- 契约身份
- 范围
- 阻断性断言
- 待运行命令
- 仍需补充的 runtime 或 manual evidence
- 已知 waiver，如有

## Assertion Types

| Type | 用途 |
| :--- | :--- |
| `test` | 单元、集成或端到端测试命令 |
| `typecheck` | 类型检查命令 |
| `lint` | 静态 lint 或格式检查命令 |
| `api` | API、schema、payload 或 interface 契约 |
| `docs` | 文档同步要求 |
| `runtime` | 日志、指标、Trace、浏览器验证或人工运行时证据 |
| `security` | 认证、授权、密钥、供应链或危险 API 检查 |
| `manual` | 暂时无法自动化但必须确认的人工检查 |

## 契约规则

- 先定义验证，再开始实现。
- 能用命令验证时，优先写成可执行命令。
- 断言应保持小而独立可检查。
- 只有真正阻断发布的检查才标记 `blocking: true`。
- 不确定性不能隐藏；应记录为 warning、coverage gap 或 manual assertion。
- 如果 assertion 被 waiver，必须记录原因、批准者和 follow-up task。
- Validator 必须基于 contract、代码、diff、命令输出和 runtime evidence 检查。Worker 的自然语言解释不是证据。

## 最小模板

```json
{
  "type": "validation_contract",
  "task_id": "T-xxx",
  "scope": {
    "feature": "short-feature-name",
    "files": []
  },
  "assertions": [
    {
      "id": "VC-001",
      "type": "test",
      "command": "npm test -- feature",
      "assertion": "The feature satisfies the primary success path.",
      "blocking": true
    }
  ]
}
```

