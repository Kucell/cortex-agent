# Graphify × Cortex Agent 集成插件

> 将 Graphify 知识图谱接入 Cortex Agent 的 Artifact Bus 和 Handoff 协议，
> 让接手方 agent 无需重新探索代码库，直接从子图导航。

## 前置要求

```bash
pip install graphifyy && graphify install
```

> macOS externally-managed 环境：`pip install --break-system-packages graphifyy && graphify install`
>
> Windows PATH 问题：使用 `pipx install graphifyy`

详细安装说明：https://github.com/safishamsi/graphify

## 初始化知识图谱

在项目根目录运行：

```bash
# 纯代码图谱（无需 LLM API Key）
graphify update .

# 完整图谱（代码 + 文档 + Markdown，需要 API Key）
ANTHROPIC_API_KEY=sk-... graphify .
```

输出结构：

```text
graphify-out/
├── graph.json       持久化知识图谱（供 extract-subgraph.js 读取）
├── graph.html       交互式可视化（浏览器打开）
└── GRAPH_REPORT.md  关键节点与社区摘要
```

## 工作原理

```
代码库 → graphify update . → graphify-out/graph.json
                                      ↓
               extract-subgraph.js --task T-C06 --files "lib/commands.js"
                                      ↓
               .agent/artifacts/T-C06/graphify-subgraph.json
                                      ↓
               Artifact Bus（kind: knowledge-graph）← coordinator 可引用
                                      ↓
               Handoff JSON（graphify_context 字段）← 接手方 agent 直接导航
```

## 使用方式

### 1. 生成任务子图（在 /handoff 前执行）

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task T-C06 \
  --files "lib/commands.js,.agent/skills/handoff/SKILL.md"
```

输出：`.agent/artifacts/<task_id>/graphify-subgraph.json`

### 2. 直接在 Claude Code 中查询图谱

```
/graphify query "handoff protocol 与 artifact bus 如何关联？"
/graphify path "handoff-protocol.js" "artifact-bus.js"
/graphify explain "coordinator"
```

### 3. Handoff 中携带图谱上下文

handoff JSON 的 `graphify_context` 字段会指向子图路径：

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

`graphify-out/graph.json` 不存在时，`extract-subgraph.js` 静默退出（exit 0），
不影响 handoff 正常工作。`graphify_context.enabled` 自动设为 `false`。
