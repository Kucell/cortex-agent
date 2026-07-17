# Decisions

Decision 是持久化且只能由用户解析的选择，用于批准或拒绝敏感动作。稳定 ID 使用 `D-` 前缀。调用方提供的 `--gate approve` 字符串不能作为有效证据：被引用的 Decision 必须存在、匹配受保护资源、处于允许的终态，并由所属 Workflow 按规则消费。

## 生命周期

```text
open -> approved
     -> rejected
     -> revision_requested
     -> canceled
     -> superseded
```

`open` 之后的所有状态均为终态。选择发生变化时必须创建新 Decision；旧记录进入 `superseded`，并通过 `superseded_by_decision_id` 关联新记录。

## 写入所有权

- 到达审批边界的 Workflow 拥有创建 `open` Decision 的权限。
- 只有显式用户决策 resolver 可以设置 `approved`、`rejected` 或 `revision_requested`，并填写解析字段。
- 请求 Workflow 可以取消尚未解析的 Decision，也可以运行 `decisions supersede --gate requester`，将其替代为同一 requester 所属且兼容的 open Decision。
- Dashboard 与 Management query 均为 `read-only`，不得选择选项或解析 Decision。

Writer 必须校验实体和索引 Schema，在本目录写入临时文件，flush 并关闭后，通过原子 rename 替换目标文件。只有实体写入成功后才能以相同规则更新 `index.json`。不得原地编辑 JSON 记录。

## Gate 证据

`gate.action` 标识受保护动作，`gate.resource_ref` 标识其精确目标。审批消费方必须校验这两个字段以及 `selected_option`、`resolved_by`、`resolved_at` 和当前 Decision 状态。禁止将 Decision 复用于其他资源。
