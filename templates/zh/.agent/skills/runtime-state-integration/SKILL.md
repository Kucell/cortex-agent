---
name: runtime-state-integration
description: 判定功能属于有状态或可豁免，创建并检查七部分运行态集成契约，并汇总验证缺口。用于架构、规划、Mission、实现评审或交付包含生命周期、持久化、副作用、恢复、查询界面或持久证据的功能。
---

# 运行态集成

使用确定性脚本分类功能，并对缺失的运行态集成 fail closed。通过 `--input` 传入 JSON；可用 `--output` 持久化 JSON。

## 模式

### ASSESS

分类功能特征：

```bash
node .agent/skills/runtime-state-integration/scripts/index.js assess --input feature.json
```

任一有状态信号为 true 时结果为 `stateful`。只有四项豁免保证全部明确为 true 时才是 `exempt`。输入不明确时按 `stateful` 处理。

### CREATE

从功能声明创建规范化契约：

```bash
node .agent/skills/runtime-state-integration/scripts/index.js create --input feature.json --output contract.json
```

创建操作保留已提供的契约部分并报告缺口；不会编造证据或集成声明。

### CHECK

验证分类与全部七个部分：

```bash
node .agent/skills/runtime-state-integration/scripts/index.js check --input contract.json
```

分类缺失/无效、豁免理由不成立，或有状态功能的必需部分缺失/不完整时，以非零状态退出。只有说明而没有证据引用，仍视为缺口。

### SUMMARIZE

生成稳定、紧凑的交接摘要：

```bash
node .agent/skills/runtime-state-integration/scripts/index.js summarize --input contract.json
```

包含分类、部分覆盖、阻塞缺口、证据引用、消费者与状态。

## 契约规则

- 有状态功能必须包含 `resource`、`state_machine`、`event_journal`、`evidence`、`write_gate`、`query_projection` 和 `consumer_surface`。
- `.agent/` 状态/事件/证据是真相源；Management API 是只读投影。
- 高风险写入必须保留 workflow、owner、Decision 与 Waitpoint 门。
- 查询和消费者声明必须只读；不得接受查询侧修复或清理。
- 跨目标时间过滤日志必须使用目标侧时间戳，并为每个生产者保存独立游标。
- 保留失败与恢复历史；持久化前脱敏秘密。
- 以脚本输出和引用产物为证据；Agent 文字说明本身不是证据。
