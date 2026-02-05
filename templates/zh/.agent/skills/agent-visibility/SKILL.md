---
name: agent-visibility
description: 管理 .agent 目录在 Git 中的可见性，解决插件菜单识别与版本控制之间的冲突。
---

# Agent Visibility Manager

## 🎯 目标

本 Skill 旨在通过自动化 Git 配置，解决以下矛盾：

1. **IDE 识别需求**：插件通常需要 `.agent` 不在 `.gitignore` 中才能索引 Slash (/) 菜单。
2. **脱敏/私有需求**：用户通常不希望将个人或项目的 `.agent` 配置推送到公共仓库。

## 🛠 参数说明

通过参数 `mode` 控制行为：

- `private` (默认/推荐):
  - 效果：IDE 菜单生效，Git 不追踪文件。
  - 逻辑：从 `.gitignore` 移除 `.agent`，增加到 `.git/info/exclude`。
- `ignore`:
  - 效果：Git 彻底忽略文件，IDE 菜单可能无法识别。
  - 逻辑：将 `.agent` 写入 `.gitignore`，并从 `info/exclude` 移除。
- `track`:
  - 效果：Git 正常追踪并同步文件到远程。
  - 逻辑：从所有忽略清单移除，并执行 `git add .agent`。

## 📝 使用指南

当用户要求“配置 .agent 可见性”或“让菜单生效”时，调用此 Skill。

### 脚本位置

`./scripts/manage.sh [mode]`
