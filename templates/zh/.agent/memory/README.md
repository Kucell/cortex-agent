# Cortex Agent Memory 机制

> 本目录是 cortex-agent 框架的 `.agent/memory/` 标准布局，机制定义在 `templates/{zh,en}/.agent/memory/`，实际数据由各项目 L2 实例持有。

## 这是什么

`memory/` 是给 Agent 用的**轻量笔记层**，用来跨 session 保留"被 recall 的事实"——不是事实/技能/规则/可重放历史（那些归 `decisions/`、`experiences/`、`references/`）。

## 四类 memory

| type | 含义 | 每项目上限 | 过期 |
|---|---|---|---|
| `user/` | 用户偏好、工作风格 | 10 条 | 永久 |
| `feedback/` | session 中观察到的轻量反馈 | 30 条 | 90 天后归档到 `feedback/_archive/` |
| `project/` | 项目级事实速记 | 20 条 | 永久 |
| `reference/` | 指向已有内容的指针（不重复 `.agent/references/` 的内容） | 50 条 | 永久 |

## 文件布局

```
.agent/memory/
├── MEMORY.md          # 索引（SessionStart 自动加载；≤200 行 / 25KB cap）
├── memory.schema.json # topic 文件 frontmatter 的 JSON schema
├── user/              # type=user
├── feedback/          # type=feedback
├── project/           # type=project
└── reference/         # type=reference
```

## 写入约定

- 每个 topic 文件**必须**含 YAML frontmatter（`name` / `description` / `type` / `created` / `tags`）
- `MEMORY.md` 索引按 4 类分组，每行格式：`- [标题](user/xxx.md) — 触发/关键词`
- 超出上限时**自动归档**（不报错，由 agent 决策）
- 详细规则见 `.agent/rules/memory-protocol.md`

## 与已有系统的边界

- **不替代** `.agent/experiences/`（commit-anchored 教训 + 防复发）
- **不替代** `.agent/decisions/`（schema 化 gate 授权）
- **不替代** `.agent/references/`（完整架构文档）
- **不替代** `.agent/context-index.json`（模块路由元数据）
- **不替代** session-continuity skill（session 短期存档）

memory 是"被 recall 的笔记"，不是"长期归档"。
