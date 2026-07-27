---
name: uri-resolver
description: 解析 cortex:// URI 协议与 .agent/ 文件系统路径互转，审计 .agent/ 中相对路径引用，受 OpenViking viking:// 启发。所有 `.agent/` 文档引用应优先使用 cortex:// 形式，复现项目时无需改路径。
---

# URI 解析器 (URI Resolver)

## 目标

为 `.agent/` 下所有文档（rules / workflows / skills / references / memory / decisions / experiences / resources）提供稳定 URI，避免路径在不同项目或不同 LLM 改写后失效。

受 OpenViking `viking://` 协议启发，但 cortex-agent 不需要独立运行时——`cortex://` 是 doc-layer 约定，由 `resolve.js` 在需要时解析。

## URI 格式

```
cortex://{scope}/{path...}
```

**已注册 scope**（来自 `registry/uri-map.json`）：

| scope | 默认根目录 | 用途 |
|---|---|---|
| `rules` | `.agent/rules` | 治理规则 |
| `workflows` | `.agent/workflows` | 状态机工作流 |
| `skills` | `.agent/skills` | 可复用技能 |
| `references` | `.agent/references` | 项目架构参考 |
| `memory` | `.agent/memory` | 4 类轻量笔记 |
| `decisions` | `.agent/decisions` | 决策与门禁授权 |
| `experiences` | `.agent/experiences` | 经验教训 |
| `resources` | `.agent/resources` | 外部资源（Phase 2） |

## 使用方式

```bash
# URI → 路径
node .agent/skills/uri-resolver/scripts/resolve.js --uri "cortex://skills/context-budget"

# 路径 → URI
node .agent/skills/uri-resolver/scripts/resolve.js --path ".agent/skills/context-budget/SKILL.md"

# 刷新 uri-map.json 时间戳 + 扫描 scope 根
node .agent/skills/uri-resolver/scripts/resolve.js --rebuild

# 审计 .agent/ 中相对路径引用（dry-run）
node .agent/skills/uri-resolver/scripts/resolve.js --check
```

## 解析规则

- URI 必须以 `cortex://` 开头，scope 必须在 `uri-map.json` 中已注册
- 路径支持自动补全扩展名：`.md` / `.json` / `.yml` / `.yaml`
- 目录引用自动尝试 `SKILL.md` / `README.md`
- 解析失败返回结构化结果（`ok: false` + `suggestion`），**不抛异常**

## 迁移路径

1. **新建引用**：直接用 `cortex://...`
2. **现有引用**：暂不动，`./resolve.js --check` 输出 dry-run 报告
3. **批量迁移**：人工 review 后批量替换，必要时回退到路径（双写兼容）

## 输出示例

```json
{
  "ok": true,
  "uri": "cortex://skills/context-budget",
  "path": ".agent/skills/context-budget/SKILL.md",
  "scope": "skills",
  "file": "context-budget"
}
```

## 边界

- **不实现**运行时注入（OpenViking 的 viking:// 由 server 解析并加载；cortex-agent 是 prompt 层）
- **不替代**相对路径——小范围内 `.agent/...` 仍然可读
- **不复制内容**——URI 仅指向；归档时仍走原 file
- **不依赖** LLM——纯 deterministic 解析

## 与其他组件的关系

- 写入位置：`.agent/registry/uri-map.json`（schema 在 `uri-map.schema.json`）
- 调用方：`context-budget`/`knowledge-retrieval` 输出的 path 可附 `cortex://` 别名
- 工作流：`/agent-update` 新增 rule / skill 时，运行 `resolve.js --rebuild` 刷新时间戳
