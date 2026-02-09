---
name: weekly-report
description: 根据 Git 提交记录自动生成周报，并支持全局/本地存储管理。
---

# Weekly Report Skill

## 🎯 目标

自动化汇总开发者的 Git 贡献，生成结构化的周报文档。

## 🛠 参数说明

- `date_range`: 日期区间，例如 "2024.1.24-2024.1.31" 或简写 "1.24-1.31"。
- `output_path`: (可选) 存储路径，默认为 `~/.agent/reports/`。

## 📝 执行逻辑

1. **日期处理**: 将输入转换为 Git 可识别的 `--since` 和 `--until` 格式。
2. **Git 提取**: 获取指定区间内的 `git log`。
3. **AI 摘要**: 对原始 Log 进行分类（feat/fix/chore）和价值提炼。
4. **持久化**: 生成 Markdown 文件并保存。
