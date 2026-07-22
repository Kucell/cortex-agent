---
name: changelog-generator
description: 从 Git 提交记录自动生成用户友好的 CHANGELOG，按 Conventional Commits 分类归组，支持版本号推断。由 documenter 在 /ship 流程中调用。
---

# 变更日志生成技能 (changelog-generator)

灵感来源：[Changelog Generator by ComposioHQ](https://claudeskills.info/skill/changelog-generator/)

## 触发时机

- `/ship` 流程的最后阶段，由 `documenter` 自动调用
- 手动触发：「生成 changelog」或「update CHANGELOG」

---

## 执行步骤

### 1. 读取提交记录

```bash
# 获取上一个 tag 到 HEAD 的所有提交
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD \
  --pretty=format:"%H %s" --no-merges
```

如果没有 tag，则读取最近 30 条提交。

### 2. 分类规则（Conventional Commits）

按提交信息前缀自动分类：

| 前缀 | 分类 | 面向用户的标题 |
| :--- | :--- | :--- |
| `feat:` / `feat(*)` | ✨ 新功能 | New Features |
| `fix:` / `fix(*)` | 🐛 问题修复 | Bug Fixes |
| `perf:` | ⚡ 性能优化 | Performance |
| `docs:` | 📚 文档 | Documentation |
| `refactor:` | ♻️ 重构 | Refactoring |
| `test:` | 🧪 测试 | Tests |
| `chore:` / `build:` / `ci:` | 🔧 工程 | Chores |
| `BREAKING CHANGE` | 💥 破坏性变更 | Breaking Changes |

不符合 Conventional Commits 格式的提交，归入「其他变更」。

### 3. 版本号推断

根据本次变更内容推断语义化版本号（SemVer）：
- 包含 `BREAKING CHANGE` → **Major** 版本 +1
- 包含 `feat:` → **Minor** 版本 +1
- 只有 `fix:` / `chore:` → **Patch** 版本 +1

读取 `package.json` 或最新 Git tag 作为当前版本基线。

### 4. 写入 CHANGELOG.md

在文件顶部插入新版本记录，保留历史记录：

```markdown
## [x.y.z] - YYYY-MM-DD

### ✨ 新功能
- feat(auth): 支持 OAuth2 登录 (#123)

### 🐛 问题修复
- fix(api): 修复并发请求时的竞态条件 (#124)

### 💥 破坏性变更
- refactor(config): 移除废弃的 `legacyMode` 选项
```

---

## 输出规范

- 每条条目：`- [提交摘要] ([scope])` 格式，去除技术实现细节，保留用户可感知的变化
- 日期使用 ISO 8601（`YYYY-MM-DD`）
- 如果 `CHANGELOG.md` 不存在，自动创建
- 不重复写入已存在版本的记录

---

## 与其他工作流的协作

- 在 `/ship` 流程的 `done` 步骤之后、`sync-plans` 之前执行
- 配合 `weekly-report` 技能：周报可引用 CHANGELOG 作为本周变更摘要
