---
name: cortex-setup
description: 引导完成 Cortex Agent 的完整项目初始化。在 Claude Code 插件安装后运行此命令以完成全部配置。
---

# 🧠 Cortex Agent — 完整初始化引导

欢迎使用 Cortex Agent！你已通过 Claude Code 插件市场安装了核心组件（commands / agents / skills）。

但要让所有工作流（如 `/arch-design`、`/ship`、`/parallel` 等）完整运行，还需要在**当前项目**中建立项目级配置目录 `.agent/`。

---

## 当前状态检查

// 检查项目根目录是否已有 .agent/ 目录
// 如果存在，跳转到「已有项目」步骤
// 如果不存在，提示用户执行初始化

---

## 选择你的情况

### 🆕 全新项目

在终端中运行：

```bash
npx cortex-agent init
```

这会在当前项目中创建完整的 `.agent/` 目录，包含：
- `rules/` — 架构规则、代码规范、提交标准
- `workflows/` — 所有斜杠命令的 SOP
- `skills/` — 专项技能
- `sub-agents/` — 专职代理
- `hooks/` — 事件驱动自动化
- `plans/` — 任务进度管理

初始化完成后，运行 `/configure` 完成项目专属配置。

---

### 🔄 已有旧 AI 配置的项目（.cursorrules / CLAUDE.md 等）

```bash
npx cortex-agent init
```

`init` 会自动检测旧配置文件并导入到 `.agent/imported_rules/`，然后提示你运行 `/migrate-rules` 进行引导式迁移。

---

### ⬆️ 已有 .agent/ 的项目（升级到最新版本）

```bash
npx cortex-agent upgrade
```

`upgrade` 只补充新增文件，**不覆盖**已有内容，安全增量更新。

---

## 完成后可以做什么

初始化完成后，以下命令即可完整运行：

| 命令 | 作用 |
| :--- | :--- |
| `/configure` | 交互式设置项目背景、技术栈、架构原则 |
| `/briefing` | 每日晨播：当前任务 + 推荐接入点 |
| `/arch-design` | 设计新功能，输出架构图 |
| `/ship T-xxx` | 一键交付：review → commit → done → changelog |
| `/parallel` | 并行派发多个任务给专职 sub-agent |

---

> 💡 **提示**：`npx cortex-agent` 需要 Node.js 18+。如果尚未安装，请先访问 [nodejs.org](https://nodejs.org)。
