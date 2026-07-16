---
name: validate-<domain>
description: 使用明确命令和证据验证项目特定运行时、设备、UI、集成或工作流。
---

# Validate <Domain>

当项目存在通用 lint、typecheck、单元测试无法覆盖的领域验证时，使用此模板创建 `.agent/skills/validate-<domain>/SKILL.md`。

## Preconditions

- 列出必需的服务、设备、账号、fixture 或环境变量。
- 明确所有权和安全边界。
- 明确禁止触碰的对象。

## Commands

```bash
# setup 或 build 命令
# validation 命令
```

## Required Evidence

- 命令输出路径
- 截图或运行时捕获路径
- 日志或结构化 JSON 结果路径
- 必要时的人工验证说明

## Pass Criteria

- 定义 PASS 所需的精确计数、状态、响应字段、UI 状态或日志条件。
- 有结构化证据时，禁止仅凭截图判断成功。

## Failure Preservation

- 重启服务前保留首次失败证据。
- 记录环境、时间戳来源和命令参数。

## Cleanup

- 说明如何停止服务、重置 fixture、清理临时状态。
