# Cortex Agent 模板 (.agent)

本目录是 Cortex Agent 的默认配置中心。

## 🚀 工作流 (Workflows)

- **agent-update**: 更新 AI 指令并与全局配置同步。
- **weekly-report**: 根据 Git 历史自动生成周报。
- **start-task**: 开始一个新任务并创建对应的计划。
- **commit**: 遵循提交规范，生成并执行 Git Commit。
- **bug-fix**: 引导完成 Bug 的分析、定位和修复流程。
- **code-review**: 对指定代码文件或变更进行评审。
- **arch-design**: 引导完成新功能的架构设计和提案文档。
- ... (更多详见 `workflows/` 目录)

## 🛠 技能 (Skills)

- **agent-visibility**: 管理 `.agent` 目录在 Git 中的可见性（私有 / 忽略 / 跟踪）。
- **weekly-report**: 获取并汇总 Git 日志的核心逻辑。
- **sync-global**: 一键将 `~/.agent` 同步到本地项目。
- **architecture-audit**: 审计项目架构合规性。
- **code-evaluation**: 评估代码质量。
