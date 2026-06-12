<!-- cspell:disable -->

# Graphify × Cortex Agent 集成提案

> 状态：提案 · 待审批
> 提案日期：2026-06-12
> 影响范围：Artifact Bus（T-C04 扩展）· Handoff 协议（T-C06 同期）
> 提案任务：T-G01 · T-G02 · T-G03

---

## 1. 背景

[Graphify](https://graphifylabs.ai)（[GitHub](https://github.com/safishamsi/graphify)）是一个为 AI 编程助手设计的知识图谱工具。工作原理分三阶段：

1. **代码结构解析**（免费、确定性）：静态分析 import/export、调用链、文件依赖
2. **音视频转录**（via faster-whisper）
3. **文档/PDF/图片语义分析**（via LLM）

核心优势与 Cortex Agent 的契合点：

| Graphify 能力 | 对应 Cortex Agent 痛点 |
|---|---|
| 预生成"项目地图"，AI 直接导航 | sub-agent 每次 dispatch 重复探索代码库 |
| Token 消耗最高降低 60% | context-budget 依赖手工 `estimated_tokens` |
| 支持 Claude Code、Codex 等主流平台 | 多模型切换后接手方缺乏代码结构上下文 |
| 无嵌入系统，纯结构图谱 | 不与现有 harness SST 冲突 |

---

## 2. 架构原则检查

| 架构原则 | 结论 | 说明 |
|---|---|---|
| 零依赖（P1） | ✅ 兼容 | Graphify 二进制留在用户项目，不进入 `bin/cli.js` |
| 模板驱动（P2） | ✅ 兼容 | 集成配置落在 `templates/zh\|en/.agent/plugins/graphify/` |
| 纯加法升级（P3） | ✅ 兼容 | 只新增文件，不修改任何现有文件 |
| 单一真理源（P4） | ✅ 兼容 | 范围划分：`context-index.json` = harness 层；Graphify = 源码层，不重叠 |
| 最小化修改（P5） | ✅ 兼容 | 只改两处 schema，不触碰 cli.js |

---

## 3. 集成点（仅两处）

### 3.1 Artifact Bus — 新增 `knowledge-graph` 类型

**文件**：`.agent/artifacts/artifact-schema.json`

当前 `kind` 枚举：
```json
"enum": ["plan", "execution", "review", "handoff", "validation", "state", "note"]
```

变更后：
```json
"enum": ["plan", "execution", "review", "handoff", "validation", "state", "note", "knowledge-graph"]
```

`knowledge-graph` artifact payload 结构：

```json
{
  "artifact_id": "KG-20260612-001",
  "task_id": "global",
  "agent_id": "graphify",
  "produced_at": "2026-06-12T09:00:00Z",
  "kind": "knowledge-graph",
  "summary": "项目知识图谱快照，由 Graphify 生成",
  "refs": [".graphify/map.json"],
  "payload": {
    "graphify_version": "1.x",
    "map_path": ".graphify/map.json",
    "entry_modules": ["bin/cli.js", "lib/"],
    "generated_at": "2026-06-12T09:00:00Z",
    "total_nodes": 0,
    "total_edges": 0
  }
}
```

**作用**：Graphify 图谱在 Artifact Bus 中可寻址，Coordinator 可将其引用到 handoff payload。

---

### 3.2 Handoff 协议 — 加入可选 `graphify_context` 字段（随 T-C06 同期）

**文件**：T-C06 将新增的 handoff JSON schema

在 handoff JSON 顶层加入可选字段：

```json
{
  "handoff_id": "HO-20260612-001",
  "from_agent": "claude",
  "to_agent": "codex",
  "task_id": "T-C06",
  "resume_from": "HANDOFF",
  "graphify_context": {
    "enabled": true,
    "subgraph_path": ".agent/artifacts/T-C06/graphify-subgraph.json",
    "relevant_files": [
      "lib/commands.js",
      ".agent/skills/handoff/SKILL.md"
    ],
    "entry_functions": ["trackAgent()", "applyGitExclusion()"],
    "generated_at": "2026-06-12T09:00:00Z"
  },
  "last_artifact": ".agent/artifacts/T-C06/execution-latest.json"
}
```

**字段规则**：
- `graphify_context` 完全可选；Graphify 未安装时字段不存在，handoff 正常工作
- `enabled: false` 时接手方跳过 Graphify 上下文，退化为当前行为
- `subgraph_path` 指向从完整图谱裁剪出的任务级子图（由 `extract-subgraph.js` 生成）

---

## 4. 数据流

```mermaid
sequenceDiagram
    participant C as Claude（发起方）
    participant CO as Coordinator
    participant GR as Graphify
    participant AB as Artifact Bus
    participant CX as Codex（接手方）

    C->>CO: /handoff T-C06
    CO->>GR: extract-subgraph --task T-C06
    GR-->>CO: graphify-subgraph.json（裁剪子图）
    CO->>AB: write artifact kind=knowledge-graph
    CO->>AB: write artifact kind=handoff（含 graphify_context）
    CO-->>C: handoff_id + artifact 路径

    CX->>CO: /resume HO-20260612-001
    CO->>AB: read handoff + knowledge-graph artifact
    CO-->>CX: 结构化上下文（handoff JSON + Graphify 子图）
    CX->>CX: 从正确步骤继续，无需重新探索代码库
```

---

## 5. 模板文件结构

```
templates/
├── zh/.agent/plugins/graphify/
│   ├── README.md              # 安装说明 + cortex-agent 配合方式
│   ├── config.yml             # 扫描范围、排除规则、子图提取配置
│   └── scripts/
│       └── extract-subgraph.js   # 按 task_id 从完整图谱裁剪子图
└── en/.agent/plugins/graphify/   # 英文版（内容同步）
    ├── README.md
    ├── config.yml
    └── scripts/
        └── extract-subgraph.js
```

`config.yml` 示例：

```yaml
graphify:
  version: ">=1.0.0"
  map_path: ".graphify/map.json"
  include:
    - "bin/"
    - "lib/"
    - ".agent/skills/"
    - ".agent/sub-agents/"
  exclude:
    - "node_modules/"
    - "templates/"
    - "*.test.js"

subgraph:
  max_nodes: 50         # 单次 handoff 最多携带 50 个节点
  max_depth: 3          # 从入口文件最多展开 3 层依赖
  fallback: skip        # Graphify 不可用时直接跳过，不报错
```

---

## 6. 风险与缓解

| 风险 | 级别 | 缓解方案 |
|---|---|---|
| Graphify 未安装导致 handoff 失败 | 🔴 | `fallback: skip`；`graphify_context` 完全可选字段；coordinator 在写 handoff 前检测 `graphify` 可用性 |
| 子图过大导致 handoff payload 膨胀 | 🟡 | `config.yml` 的 `max_nodes` / `max_depth` 硬上限；超出则只记录 `subgraph_path`，不内联 |
| Graphify 图谱与实际代码不同步 | 🟡 | `extract-subgraph.js` 读取时检查 `generated_at`；超过 24h 则 coordinator 告警，建议重新扫描 |
| 两套"项目地图"概念让用户困惑 | 🟡 | README 明确边界：`context-index.json` = harness 文件索引；Graphify = 源码知识图谱 |
| Graphify schema 升级破坏脚本 | 🟢 | `extract-subgraph.js` 加版本兼容检查，不匹配时 skip 并 warn |

---

## 7. 任务拆解

| 任务 ID | 优先级 | 描述 | 估时 | 依赖 |
|---|---|---|---|---|
| **T-G01** | P1 | `artifact-schema.json` 加 `knowledge-graph` 类型 | 0.5h | T-C04 ✅ |
| **T-G02** | P1 | `templates/zh\|en/.agent/plugins/graphify/` 模板（README + config.yml） | 1h | T-G01 |
| **T-G03** | P1 | `extract-subgraph.js` 脚本（裁剪子图 + fallback 逻辑） | 2h | T-C06 同期 |

**执行时机**：T-G01 和 T-G02 可在 T-C06 之前独立完成；T-G03 随 T-C06 同期实现，handoff JSON schema 在同一 PR 中加入 `graphify_context` 可选字段。

后续增强（不在本提案范围，视需要再立项）：

- `sync-to-context-index.js`：Graphify 精确 token 数同步到 `context-index.json`
- knowledge-lint 扩展：接入 Graphify 源码级断链检测
- `/briefing` Graphify 图谱健康度板块

---

## 8. 验收标准

- [ ] `artifact-schema.json` 的 `kind` 枚举包含 `knowledge-graph`
- [ ] `templates/zh|en/.agent/plugins/graphify/` 目录存在且双语同步
- [ ] `extract-subgraph.js` 在 Graphify 不可用时返回空对象，不抛错
- [ ] T-C06 handoff JSON schema 包含可选 `graphify_context` 字段，并有 `enabled: false` 的 fallback 路径
- [ ] coordinator 在 HANDOFF 模式下：若 Graphify 可用则填充子图，否则静默跳过
- [ ] `/resume` 时接手方收到 handoff 后能正确读取 `graphify_subgraph_path` 并注入上下文

---

## 9. 决策

> 等待确认后进入实施。

- **批准**：T-G01 随 T-C06 前置启动，T-G03 随 T-C06 同期实现
- **推迟**：Coordinator 主线（T-C06~T-C10）全部完成后再开
- **否决**：不集成，保持 Coordinator 现有设计

