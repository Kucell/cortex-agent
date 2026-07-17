# Inbox 消息

Inbox 消息是 Agent、Workflow 与用户之间小型、持久的协调记录。稳定 ID 使用 `IM-` 前缀。大段内容应存入 Artifact Bus 文件，并通过 `artifact_refs` 引用；Inbox 记录应保持简洁且可索引。

## 生命周期

```text
unread -> read -> acknowledged -> archived
   |        |            |
   +--------+------------+-> archived
```

`archived` 是终态。`acknowledged` 只表示接收方已承担责任，不会批准 Decision，也不会释放 Waitpoint。

## 写入所有权

- 发送 Workflow 拥有创建权，并且只能创建 `unread` 消息。
- 指定 recipient 或显式 handoff Workflow 拥有 `read` 与 `acknowledged` 状态转换权。
- recipient、来源 Workflow 或用户指示的维护 Workflow 可以归档消息。
- Dashboard 与 Management query 均为 `read-only`，不得确认、归档或以其他方式修改消息。

Writer 必须校验实体和索引 Schema，在本目录写入临时文件，flush 并关闭后，通过原子 rename 替换目标文件。只有实体写入成功后才能以相同规则更新 `index.json`。不得原地编辑 JSON 记录。

## 文件

- `inbox-message.schema.json`：消息的 canonical 契约。
- `index.schema.json`：机器可读索引契约。
- `index.json`：紧凑发现索引；消息正文保留在 `IM-*.json` 文件中。
