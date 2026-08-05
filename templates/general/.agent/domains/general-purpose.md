---
name: general-purpose
description: General-purpose domain — fallback domain for general mode projects that don't fit a specialized domain. Activates 4 general workflows (memory-recall / memory-distill / agent-invoke / agent-discover) with minimal domain-specific configuration.
mode: general
schema_version: 1
priority: 100  # highest number = lowest priority; specialized domains override this
workflows_enabled: [memory-recall, memory-distill, agent-invoke, agent-discover]
subagents_enabled: [memory-curator]
---

# Domain: General-Purpose (general 模式通用占位)

## 1. 这是什么

`general-purpose` 是 general 模式的**通用 fallback domain**。当项目没有更具体的 domain 匹配时(例 `dialogue` / `knowledge` / `content` / `operations`),自动激活本 domain。

按 RFC §6.2 拍板,general 模式按域分:
- `dialogue` — 客户 / 对话场景(RFC §6.2 中列出,v1.11 评估)
- `knowledge` — 知识库场景
- `content` — 内容生产场景
- `operations` — 运营场景
- `general-purpose` — 通用 fallback(本文件)

**优先级**:`priority: 100` 表示"最低优先",实际匹配时,**先**尝试 specialized domain,匹配不上才 fallback 到本 domain。

## 2. 激活行为

当 `cortex-agent init --mode general` 后,如果用户没指定 `--domain`,默认激活本 domain。

激活后:

- 4 个 general workflow 全启用(`memory-recall` / `memory-distill` / `agent-invoke` / `agent-discover`)
- 1 个 sub-agent 启用(`memory-curator`)
- 0 个 specialized domain 配置加载

## 3. 字段说明

| 字段 | 类型 | 必填 | 说明 |
| :--- | :---: | :---: | :--- |
| `name` | string | ✓ | domain 标识,`general-purpose` 是保留名 |
| `description` | string | ✓ | 用途说明,host 看到 domain 列表时显示 |
| `mode` | enum | ✓ | `general` / `code`,本 domain 是 `general` |
| `schema_version` | int (=1) | ✓ | domain schema 版本 |
| `priority` | int (1-100) | ✓ | 匹配优先级,数字越大越靠后;`general-purpose` = 100 |
| `workflows_enabled` | string[] | ✓ | 本 domain 启用的 workflow 列表(对应 `.agent/workflows/` 里的 frontmatter `name`)|
| `subagents_enabled` | string[] | ✓ | 本 domain 启用的 sub-agent 列表(对应 `.agent/sub-agents/` 里的 frontmatter `name`)|

## 4. 与 specialized domain 的关系

```text
用户选 domain / 自动推断
   ↓
匹配 priority 最低(数字最小)的 specialized domain
   ↓  (没匹配上)
fallback 到 general-purpose(priority: 100)
```

**示例**:

- 用户说"我想用 cortex-agent 管理个人日记" → 匹配 `dialogue`(如已 publish);没匹配上 → `general-purpose`
- 用户说"我想用 cortex-agent 整理产品文档" → 匹配 `knowledge`(如已 publish);没匹配上 → `general-purpose`

## 5. 配置示例

```yaml
# .agent/domains/general-purpose.yaml (用户在项目里覆盖默认)
name: general-purpose
description: General-purpose domain — customized for personal task management
mode: general
schema_version: 1
priority: 100
workflows_enabled:
  - memory-recall
  - memory-distill
  - agent-invoke
  - agent-discover
subagents_enabled:
  - memory-curator
custom_settings:
  memory:
    auto_distill_on_session_end: true
    max_records_per_distill: 20
  agent:
    default_timeout_seconds: 300
```

## 6. 实现状态

本 domain 的**运行时加载**(读 `domains/*.yaml` + 按 priority 匹配)在 MS-003 收口(Agent Registry 扩展的一部分)。

本任务(MS-001)只 publish domain 骨架 + 默认 `general-purpose`,作为 general 模式 init 后的 domain 之一。

## 7. 关联

- RFC: `docs/architecture/general-mode-design.md` §6.2 / §6.7
- 关联 workflow 列表: `templates/general/.agent/workflows/`
- 关联 sub-agent: `templates/general/.agent/sub-agents/memory-curator.md`
- 关联配置: `templates/general/.agent/config/general-config.yaml`
- 实现:MS-003(domain 加载逻辑)
