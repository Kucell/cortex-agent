# 🧠 Cortex Agent Framework

**Cortex Agent** 是一个为 AI 编程助手（如 Cursor Agent, Windsurf 等）设计的治理与指令框架。它通过一套结构化的**规则 (Rules)**、**工作流 (Workflows)** 和**技能 (Skills)**，将 AI 从一个简单的代码生成器提升为具有架构意识和工程规范的“资深工程师”。

## 🚀 核心价值

- **架构一致性**: 强制 AI 遵循项目预定义的架构模式（如六边形架构、分层设计）。
- **质量保障**: 自动化的提交规范检查、单元测试验证和类型安全审计。
- **上下文透明**: 通过标准化的任务计划 (`plans/`)，让 AI 随时掌握项目进度和下一步行动。
- **标准化流程**: 预定义 `/bug-fix`, `/code-review`, `/arch-design` 等常见场景的 SOP。

## 📂 目录结构

```text
.agent/
├── rules/          # 核心规则：定义 AI 必须遵守的底线（架构、代码、提交规范）
├── workflows/      # 工作流：Slash Commands (如 /start-task, /commit)
├── skills/         # 专项技能：封装复杂逻辑（如架构审计、实现评估）
├── plans/          # 进度管理：存储 Roadmap 和详细任务实施计划
└── resources/      # 模板资源：架构提案、计划文档等模板
```

## 🛠️ 如何开始 (Quick Start)

你只需要在你的项目根目录下执行以下命令，即可完成初始化：

```bash
npx cortex-agent init
```

该命令会自动完成以下工作：
1.  在你的项目中创建 `.agent/` 目录并填充核心治理文件（Rules, Workflows, Skills）。
2.  为 **Cursor**, **Claude Code**, **Windsurf** 生成对应的入口配置文件（`.cursorrules`, `.clauderules`, `.windsurfrules`）。

## ⚙️ 初始化配置

初始化完成后，请务必根据项目需求调整以下文件：
-   ` .agent/rules/tech-stack.md`: 定义你的具体技术栈。
-   ` .agent/rules/architecture-design.md`: 明确你的架构原则。
-   ` .agent/plans/task-progress.md`: 填入项目的 Roadmap。

## 🔧 自定义与演进

所有的指令都是活的。你可以通过以下方式不断优化你的 Agent：
- **`/agent-update`**: 使用该指令来新增或修改规则、工作流。

## 🔌 多平台集成 (Multi-platform Integration)

**Cortex Agent** 设计为与工具无关。为了让不同的 AI 助手（如 **Cursor**、**Windsurf/Codex**、**Claude Code**）能够利用其原生的功能（如 Slash Commands），你可以通过文件系统的**软链接 (Symbolic Link)**，将 `.agent` 目录下的内容映射到对应平台习惯的配置文件夹中。

### 核心理念
**`.agent` 目录是唯一的真理来源 (Single Source of Truth)**。所有的规则、工作流和技能都维护在这里。通过软链接映射，你可以实现“一次编写，多端同步”。

### 平台映射指南

| Cortex 目录 | Cursor 习惯 | Windsurf (Codex) | Claude Code |
| :--- | :--- | :--- | :--- |
| `.agent/rules/` | `.cursor/rules/` | `.windsurf/rules/` | `CLAUDE.md` (文件) |
| `.agent/workflows/` | `.cursor/commands/` | `.windsurf/workflows/` | `.claude/commands/` |
| `.agent/skills/` | `.cursor/skills/` | - | - |

> **注意**: 
> - **Cursor** 将 `.cursor/commands` 下的文件识别为 Slash Commands。
> - **Windsurf** 使用 `.windsurf/workflows` 来存储可以通过 `/` 触发的工作流。
> - **Claude Code** 支持通过 `.claude/commands` 自定义项目级命令，并自动读取根目录的 `CLAUDE.md` 作为规则说明。

### 示例操作：映射 Cursor 与 Claude Commands

如果你希望这些工具原生支持 Cortex 的工作流：

```bash
# 为 Cursor 映射 Commands & Rules
mkdir -p .cursor
ln -s ../.agent/workflows .cursor/commands
ln -s ../.agent/rules .cursor/rules

# 为 Claude Code 映射 Commands & Rules
mkdir -p .claude
ln -s ../.agent/workflows .claude/commands
# Claude Code 主要读取 CLAUDE.md，可以映射核心规则或通过脚本合并
ln -s .agent/rules/core-principles.md CLAUDE.md

# 为 Windsurf 映射 Workflows & Rules
mkdir -p .windsurf
ln -s ../.agent/workflows .windsurf/workflows
ln -s ../.agent/rules .windsurf/rules
```

通过这种方式，`workflows` 目录下的 `.md` 文件（如 `/start-task`）就可以直接在 Cursor 的对话框中通过 `/` 触发。同样地，你可以将 rules 映射到 `.cursor/rules` 以支持 Cursor 的原生 Rules 引擎。

## 📄 开源协议

MIT
