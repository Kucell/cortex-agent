# 运行态集成底层约束

## 分类

功能只要具备生命周期转换、跨命令/进程/会话持久化、产生副作用、可能失败或恢复、需要被协调界面查询，或为交付门提供证据，就属于 `stateful`。

只有同时满足同步、无副作用、不持久化，且不产生持久身份、所有者、事件或证据的功能才可声明为 `exempt`。必须在架构与验证产物中记录豁免理由；一旦开始持久化或产生副作用，立即重新分类。

## 必需契约

每个有状态功能必须提供：

1. Resource：稳定 ID、schema、owner，以及 Task/Run/Session 关联。
2. State machine：按适用范围定义初始、合法转换、终态、失败、超时、陈旧、取消与恢复语义。
3. Event journal：只追加的转换/活动事件，并关联 actor 与 evidence。
4. Evidence：命令、验证、产物和脱敏日志游标引用。Worker 的文字说明不算证据。
5. Write gate：归属 workflow、owner 检查，以及高风险操作的 Decision/Waitpoint 门。
6. Query projection：聚焦和聚合的 Management API 只读模型；兼容缺失的旧状态且绝不产生写入。
7. Consumer surface：适用的 CLI、可选 MCP、Dashboard、Briefing、Review、Handoff 或审计视图必须消费同一 projection。

## 真相源与数据方向

- `.agent/` 中的资源状态、事件和证据引用是真相源。
- Management API 是统一只读投影，不是第二真相源。
- CLI、MCP 与 Dashboard 不得重新实现状态转换，也不得解析各自私有状态模型。
- Dashboard 与 MCP 默认只读。未来的写工具必须调用现有归属 workflow，不能绕过 owner、Decision 或 Waitpoint 门。
- 查询不得执行 sweep、release、retry、resolve、merge、repair 或其他状态变更。

## 事件与日志完整性

- 保存摘要和引用，不在状态中塞入大量 stdout/stderr。
- 持久化前脱敏凭据、token、cookie、`.env` 内容和敏感命令输出。
- 跨进程或跨机器的时间过滤日志必须使用目标侧时间戳，并为每个产生日志的目标保存独立游标。
- 保留失败、阻塞、陈旧、超时、取消、重试和补偿事件；后续成功不得覆盖这些事件。
- 只有事件仍保留稳定引用并准确报告证据可用性时，日志轮转才可删除原始字节。

## 交付门

- `/arch-design`：声明 `stateful` 或 `exempt`；有状态功能必须覆盖全部七部分契约。
- `/plan` 与 `/mission`：为状态、事件、证据、投影、消费者、恢复、兼容性与测试建立明确任务。
- `/ship`：缺少任一契约部分、非法转换测试、只读查询测试、消费者、恢复证据或 en/zh 模板镜像时阻止完成。
- 共享 schema 与 Management API writer 必须串行修改；worktree 不能让共享契约的并发编辑变得安全。
