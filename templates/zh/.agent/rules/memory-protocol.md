# Memory 协议规则

> 本规则定义 `.agent/memory/` 下的 4 类笔记（user / feedback / project / reference）的写入、读取、过期和归档协议。
> 配套机制：`templates/{zh,en}/.agent/memory/`（机制）+ `templates/{zh,en}/.agent/hooks/hooks.json`（自动加载）+ 本规则（行为约束）。

## 1. 适用范围

仅适用于 `.agent/memory/` 目录下的 topic 文件（`{user,feedback,project,reference}/*.md`）和 `MEMORY.md` 索引。**不适用**于：

- `.agent/experiences/EXP-*.md`（commit-anchored 教训）
- `.agent/decisions/D-*.json`（gate 授权）
- `.agent/references/*.md`（完整架构文档）
- `.agent/context-index.json`（模块路由元数据）
- session-continuity skill 的 `~/.agent/contexts/<project>/ctx_*.md`（session 短期存档）

## 2. 四类定义

| type | 含义 | 长度上限 | 过期策略 | 主要写入者 |
|---|---|---|---|---|
| `user` | 用户偏好、工作风格 | ≤10 条/项目 | 永久 | 用户手动 / `/configure` |
| `feedback` | session 中观察到的轻量反馈 | ≤30 条/项目 | 90 天后自动归档到 `feedback/_archive/` | `agent-update` Step 4.5 |
| `project` | 项目级事实速记 | ≤20 条/项目 | 永久 | `/plan` `/ship` `/mission` DONE 阶段 |
| `reference` | 指向已有 `.agent/` 内容的指针 | ≤50 条/项目 | 永久 | `/update-refs` Step 6 |

## 3. 必填 frontmatter

每个 topic 文件**必须**含 YAML frontmatter，字段定义见 `memory.schema.json`：

- `name`（slug，匹配 `^[a-z0-9-]+$`）
- `description`（≤200 字符，触发关键词放这里）
- `type`（4 选 1）
- `created`（ISO 8601 日期）
- `tags`（1-10 个 slug 关键词，供未来 memory-recall 使用）

可选字段：`expires`（feedback 类必填，其他选填）、`source`、`related`。

## 4. MEMORY.md 索引约定

- 启动时 SessionStart hook 自动加载 `MEMORY.md`（**只**索引，不加载 topic）
- 200 行 / 25KB 双 cap（对齐 Claude Code 官方 Auto Memory）
- 索引按 4 类分组，每行格式：`- [标题](<type>/<file>.md) — 触发/关键词`
- 每组首行显示 `(<当前数>/<上限>)`，agent 看到接近上限应主动归档旧条

## 5. 写入触发

| 触发场景 | 写入路径 |
|---|---|
| 用户说"记住我偏好 X" | 用户手动 Write 到 `user/` |
| agent 观察到 session 中重复 pattern | `agent-update` Step 4.5 → `feedback/` |
| `/plan` `/ship` `/mission` 完成 | workflow DONE 阶段检查"是否有可复用的项目事实" → `project/` |
| `/update-refs` 新增/更新 references | Step 6 → 在 `reference/` 留指针（不重复内容） |

## 6. 显式边界（Non-Goals）

以下事情**不做**（显式回应 P-006 反通用 MEMORY 立场）：

1. **不替代** `.agent/decisions/`（gate 授权）
2. **不替代** `.agent/state/` 和 checkpoint
3. **不替代** `.agent/handoffs/`
4. **不实现**"无限增长的事实/技能/规则/可重放历史"——每类有硬上限
5. **不替代** `.agent/docs/` `.agent/rules/`
6. **不**自动加载 topic 文件（用 cap + 按需 Read 代替）
7. **不**实现跨项目 memory 同步
8. **不**写入个人隐私或凭证（feedback/project 严禁放 token、密码、内部 URL）

memory 是**被 Agent recall 的轻量笔记**，不是"长期归档"。

## 7. 容量与陈旧控制（实施级约束，对齐 Claude Code Auto Memory）

| 约束 | 数值 | 来源 |
|---|---|---|
| 单 topic 文件大小上限 | **102400 字节**（100 KB） | Claude Code binary 内部常量 |
| MEMORY.md 启动加载 | 200 行 / 25 KB 双 cap | Claude Code Auto Memory 公开文档 |
| `name` slug 字符集 | `^[a-z0-9_-]+$`（含下划线） | Claude Code binary 内部常量 |
| 路径段数 | ≤20 段 | Claude Code binary 内部常量 |
| 路径字节 | ≤1024 字节 | Claude Code binary 内部常量 |

## 8. 陈旧风险（Stale Risk）

**memory 可能过期或冲突于真实状态**——这一点 Claude Code 内部 prompt 显式提醒：

> "verify files/functions/flags before recommending because memory can be stale"

实操规则：
- 当用户提出"项目用 X"、"项目不用 Y"等与 `memory/project/*.md` 冲突的陈述时，**先验证**（`ls`、`cat package.json` 等）再采纳
- `memory/user/*.md` 的偏好**优先级低于**用户当前 prompt（用户随时可覆盖）
- `memory/feedback/*.md` 标注 `expires` 后**自动降权**（Phase 2 skill 实现）
- 重大变更（项目迁移、用户换工作风格）应**手动删除**对应 memory 文件，而不是逐条 update

## 9. 实施兼容性（对偶 Claude Code）

本设计参考 Claude Code v2.1.216 binary 内部 prompt 字符串（`/Users/xueyq/.local/bin/claude` 的 `strings` 提取），与官方 Auto Memory 字段（`name` / `description` / `metadata`）兼容：

- `metadata` 字段为可选（cortex-agent 顶层 `type` 仍为正典）
- slug regex 含下划线（与 Claude Code 一致）
- 单文件 100 KB cap（防止 memory 文件成为性能瓶颈）

**注意**：Claude Code 行为可能版本演化，本设计仅在 v2.1.216 实施级证据基础上对齐；不是 public API 契约承诺。
