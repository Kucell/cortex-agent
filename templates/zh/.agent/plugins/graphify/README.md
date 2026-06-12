# Graphify × Cortex Agent 集成插件

> 将 Graphify 知识图谱接入 Cortex Agent 的 Artifact Bus 和 Handoff 协议，
> 让接手方 agent 无需重新探索代码库，直接从子图导航。

## 前置要求

```bash
npx graphify init        # 初始化 .graphify/ 目录
npx graphify scan        # 生成项目知识图谱（.graphify/map.json）
```

详细安装说明：https://github.com/safishamsi/graphify

## 工作原理

```
代码库 → Graphify 全图谱 → extract-subgraph.js → 任务级子图
                                                        ↓
                               Artifact Bus（kind: knowledge-graph）
                                                        ↓
                               Handoff JSON（graphify_context 字段）
                                                        ↓
                                         接手方 agent 直接导航
```

## 接入方式

### 1. 生成任务子图（在 /handoff 前执行）

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task T-C06 \
  --files "lib/commands.js,.agent/skills/handoff/SKILL.md"
```

输出：`.agent/artifacts/<task_id>/graphify-subgraph.json`

### 2. 子图自动注册到 Artifact Bus

脚本执行后自动写入 `kind: knowledge-graph` artifact，coordinator 可在 handoff 时引用。

### 3. Handoff 中携带图谱上下文

handoff JSON 的 `graphify_context` 字段会指向子图路径，接手方 agent 可直接读取。

```json
{
  "graphify_context": {
    "enabled": true,
    "subgraph_path": ".agent/artifacts/T-C06/graphify-subgraph.json",
    "relevant_files": ["lib/commands.js"],
    "entry_functions": ["upgrade()"]
  }
}
```

## 配置

编辑 `.agent/plugins/graphify/config.yml` 调整扫描范围和子图深度。

## 跳过逻辑

Graphify 未安装（`.graphify/map.json` 不存在）时，`extract-subgraph.js` 静默退出，
不影响 handoff 正常工作。`graphify_context.enabled` 自动设为 `false`。
