# Waitpoints

Waitpoint 会暂停动作，直到显式证据满足声明的释放条件。稳定 ID 使用 `WP-` 前缀。Waitpoint 围绕 Task gate 协调工作，不会改变 Task gate owner，也不会直接修改 Task gate。

## 生命周期

```text
pending -> blocked -> released
   |          |----> canceled
   |          +----> expired
   +---------------> canceled
   +---------------> expired
```

`released`、`canceled` 和 `expired` 均为终态。由于所有支持的 gate action 都属于高风险动作，释放时必须同时提供 `decision_id`、非空 `evidence_refs`、释放者身份和时间戳。

## 写入所有权

- 检测到条件未满足的 Workflow 拥有创建权和 `pending -> blocked` 状态转换权。
- 只有暂停动作的所属 Workflow 在校验 Decision 与证据后才能释放 Waitpoint。
- 创建 Workflow 或用户指示的治理 Workflow 可以取消 Waitpoint；超时策略可以将其标记为过期。
- Dashboard 与 Management query 均为 `read-only`，不得释放 Waitpoint，也不得批准关联 Decision。

Writer 必须校验实体和索引 Schema，在本目录写入临时文件，flush 并关闭后，通过原子 rename 替换目标文件。只有实体写入成功后才能以相同规则更新 `index.json`。不得原地编辑 JSON 记录。

## 释放校验

释放前，所属 Writer 必须验证：

- 关联 Decision 存在且状态为 `approved`。
- `selected_option` 为 `approve`，或者是 Decision 所属 Workflow 声明的标准审批选项。
- Decision 与 Waitpoint 的 `gate.action` 完全一致。
- Decision 与 Waitpoint 的 `gate.resource_ref` 完全一致。
- `evidence_refs` 除其他验证工件外，还包含关联 Decision 文件引用。

仅匹配 ID 不能作为审批证据。Dashboard 与 read-only query 可以展示这些字段，但不能执行释放。
