---
name: sync-global
description: 将全局 ~/.agent 下的工作流和技能一键同步(Link)到当前项目。
---

# Global Sync Skill

## 🎯 目标

消除手动维护符号链接的成本，实现全局能力的“一键导入”。

## 🛠 功能

- 自动扫描 `~/.agent/workflows/` 并链接到项目。
- 自动扫描 `~/.agent/skills/` 并链接到项目。
- 保持物理文件在全局，项目内仅存储快捷方式。

## 📝 使用方法

对 Agent 说：“执行 sync-global” 即可完成同步。
