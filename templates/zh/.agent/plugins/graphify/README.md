# Graphify × Cortex Agent 集成插件

> 将 Graphify 知识图谱接入 Cortex Agent 的 Artifact Bus 和 Handoff 协议，
> 让接手方 agent 无需重新探索代码库，直接从子图导航。
>
> **T-GWG-001 — 默认可选。** 当 `.agent/plugins/graphify/` 不存在时，
> Cortex Agent 记录 `not_applicable`，回退到源码探索，文件系统除了
> 一次 stat() 外不会被触碰。当插件存在时，`init` 与 `doctor --fix`
> 幂等地安装 post-commit hook（不覆盖无关的用户 hook）；代码变化触发
> AST 增量更新；语义变化（文档 / 提案 / 规则 / 图片）留下被忽略的 stale
> marker；`query` / `path` / `explain` / `preflight` 在图谱过期时
> fail closed，禁止静默信任旧图。

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

推荐入口 `cortex-agent graphify update --project <root>` —— 它会同步
在 `<project>/.agent/artifacts/graphify/global/receipt.json` 写入
freshness receipt 并清理 stale marker。

## Cortex Agent CLI 表面（T-GWG-001）

| 子命令 | 作用 |
| :--- | :--- |
| `graphify context` | 解析并打印 Graphify 上下文（模式、source HEAD、年龄、降级原因）。只读。 |
| `graphify preflight --query "<text>"` | 运行 freshness gate。图谱过期 / 不兼容时返回非零退出。 |
| `graphify update --reason "<text>"` | 重新运行 `graphify update .`，成功后写入 freshness receipt。 |
| `graphify doctor` | 报告插件状态（CLI / config / graph / hooks / freshness）。`--fix` 幂等修复 post-commit hook。 |
| `graphify receipt --task <task-id>` | 读取最近的 freshness receipt（默认 task：`global`）。 |

项目未启用插件时所有子命令返回 `not_applicable` 且退出码 0 —— 无副作用、无安装。

## Freshness 生命周期

| 触发 | 行为 |
| :--- | :--- |
| `cortex-agent init` | 幂等安装 Graphify post-commit hook（项目无插件时跳过）。 |
| `cortex-agent doctor --fix` | 缺失时修复 Graphify post-commit hook；永不覆盖无关用户 hook。 |
| `git commit`（仅代码） | hook 运行 `graphify update .` 做 AST 增量更新；清理 stale marker。 |
| `git commit`（仅语义） | hook 写入 `graphify-out/.graphify-stale.json`（已忽略）；查询 fail closed 直到下次更新。 |
| `graphify query` / `path` / `explain` | 包装层先运行 freshness preflight，禁止静默返回旧图。 |
| `/ship` | 负责 freshness 收口：刷新图谱、写入绑定 source HEAD 的 receipt；拿不到 fresh receipt 时阻断 ship。 |

## 输出结构

```text
graphify-out/
├── graph.json               持久化知识图谱（供 extract-subgraph.js 读取）
├── graph.html               交互式可视化（浏览器打开）
├── GRAPH_REPORT.md          关键节点与社区摘要
├── manifest.json            生成来源（schema / source HEAD / 计数 / 模式）
└── .graphify-stale.json     被忽略的 stale marker（语义 commit 写入）

.agent/artifacts/graphify/<task-id>/receipt.json   freshness receipt
```

## 工作原理

```
代码库 → graphify update . → graphify-out/graph.json + manifest.json
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

### 2. 在 AI 助手中直接查询图谱

```
/graphify query "handoff protocol 与 artifact bus 如何关联？"
/graphify path "handoff-protocol.js" "artifact-bus.js"
/graphify explain "coordinator"
```

每个子命令都先运行 freshness preflight。如果图谱过期，子命令拒绝读取并返回结构化 verdict。

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
项目级覆写放在 `.agent/plugins/graphify/policy.local.yml`，遵循：

```yaml
mode: required-for-topology    # off | advisory | required-for-topology
max_age_days: 7
allow_primary_worktree_fallback: true
require_branch_delta_readback: true
```

`mode: required-for-topology` 时，跨模块 / 调用链 / 架构类查询在 freshness
gate 报告 `stale` / `blocked` 时会 fail closed。

## 跳过逻辑

`graphify-out/graph.json` 不存在时，`extract-subgraph.js` 静默退出（exit 0），
不影响 handoff 正常工作。`graphify_context.enabled` 自动设为 `false`。
Cortex Agent CLI 表面通过 `graphify context --json` 输出的 `fallbackReason`
字段记录缺失原因。