# 自定义与演进 (Customization)

> Cortex Agent 的所有配置文件都是"活的"——可以随项目演进不断调整。

---

## 修改规则与工作流

使用 `/agent-update` 工作流来新增或修改规则、工作流、技能：

```
/agent-update "新增规则：所有 API 接口必须有 OpenAPI 文档注释"
/agent-update "修改 commit 规范：type 范围扩展加入 infra"
```

`/agent-update` 会引导你确认修改范围，并写入对应的 `.agent/` 文件。

---

## 扩展 Sub-agent

在 `.agent/sub-agents/` 中新增 `.md` 文件来创建专职代理：

```markdown
---
name: security-auditor
description: 专职安全审计代理，扫描 OWASP Top 10 漏洞
model: claude-sonnet-4-6
tools: Read, Grep, Glob
---

# 安全审计代理
...
```

**何时新增 Sub-agent：**
- 任务场景高度专业化（安全审计、性能分析、数据库优化）
- 该场景会频繁重复出现
- 需要隔离的工具权限或上下文边界

---

## 添加 Hooks

在 `.agent/hooks/hooks.json` 中扩展自动化触发逻辑：

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [{ "type": "command", "command": ".claude/hooks/pre-commit-check.sh" }]
    }
  ],
  "PostCommit": [
    {
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "your-custom-hook.sh", "async": true }]
    }
  ]
}
```

**内置 Hooks：**
- `PostToolUse`（Write/Edit 后）：`pre-commit-check.sh` 触发 ESLint / Ruff / go vet / Checkstyle / SwiftLint
- `PostCommit`：`entropy-scanner` L0 自动清理 `context-index.json` 的过时条目

---

## 新增语言规则

在 `.agent/rules/languages/` 中新增语言规范文件，然后通过 `/configure` 工作流激活（会追加到 `tech-stack.md`）：

```
.agent/rules/languages/
├── typescript.md
├── python.md
├── golang.md
├── java.md
├── swift.md
└── rust.md      ← 新增示例
```

> 语言规则文件详见 [语言规范规则](./language-rules.md)。

---

## 调整模型配置

通过 `/configure-model` 工作流交互式配置：
- 切换 AI 提供商（Anthropic / OpenAI / Azure / Ollama）
- 修改每个角色的模型分配
- 调整成本模式（conservative / balanced / quality）

所有配置集中在 `.agent/config/reasoning-config.yml`，修改后工作流会自动同步所有 Sub-agent 的 `model:` 字段。

---

## 维护知识库

| 场景 | 命令 |
|------|------|
| 功能迭代后模块结构变更 | `/update-refs` — 增量更新 `.agent/references/` |
| 知识库整体扫描 | `/scan-project` — 全量重建 references/ |
| 查看知识库健康度 | `/briefing` — 显示熵值报告和 health_score |

---

> 返回：[工作流命令](./workflows.md) | [Sub-agent 架构](./sub-agents.md)
