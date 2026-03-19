# 🧠 Cortex Agent Framework

**Cortex Agent** 是一个为 AI 编程助手（如 Cursor、Claude Code、Windsurf、Gemini CLI、Antigravity 等）设计的治理与指令框架。它通过一套结构化的**规则 (Rules)**、**工作流 (Workflows)** 和**技能 (Skills)**，将 AI 从一个简单的代码生成器提升为具有架构意识和工程规范的“资深工程师”。

## 🚀 核心价值

- **架构一致性**: 强制 AI 遵循项目预定义的架构模式（如六边形架构、分层设计）。
- **专业化委托**: 通过 **子代理 (Sub-agents)** 机制，将复杂任务分解并委托给具有特定专长的 AI 代理，提高效率和深度。
- **质量保障**: 自动化的提交规范检查、单元测试验证和类型安全审计。
- **事件驱动自动化**: 利用 **钩子 (Hooks)** 在关键操作前后自动执行代码，实现策略强制和自动化流程。
- **上下文透明**: 通过标准化的任务计划 (`plans/`)，让 AI 随时掌握项目进度和下一步行动。
- **标准化流程**: 预定义 `/bug-fix`, `/code-review`, `/arch-design` 等常见场景的 SOP，并通过 **技能 (Skills)** 实现更动态、上下文感知的执行。

## 📂 目录结构

```text
.agent/
├── rules/          # 核心规则：定义 AI 必须遵守的底线（架构、代码、提交规范）
├── workflows/      # 工作流：Slash Commands (如 /start-task, /commit)
├── skills/         # 专项技能：封装复杂逻辑（如架构审计、实现评估）
├── sub-agents/     # 子代理：专职处理特定任务的代理，可被主代理委托
├── hooks/          # 钩子：事件驱动的自动化，用于在特定操作前后执行代码
├── plugins/        # 插件：集成自定义工具、数据源等核心能力
├── plans/          # 进度管理：存储 Roadmap 和详细任务实施计划
└── resources/      # 模板资源：架构提案、计划文档等模板
```

## 🛠️ 如何开始 (Quick Start)

你只需要在你的项目根目录下执行以下命令，即可完成 Cortex Agent 的初始化：

```bash
# 初始化当前项目 (Local, 默认为中文)
npx cortex-agent init

# 指定语言初始化 (可选: zh, en)
npx cortex-agent init --lang=en

# 初始化全局配置 (Global, 存储在 ~/.agent)
npx cortex-agent init --global

```

可选参数（按需使用）：

- `cortex-agent init --track`：初始化时直接纳入 Git 追踪（默认本地忽略）。
- `cortex-agent init --global`：初始化到全局目录 `~/.agent`。
- `cortex-agent upgrade`：**已有 `.agent` 的项目升级用**，仅补充模板中新增的文件，刷新符号链接，绝不修改已有内容。
- `cortex-agent track`：**初始化后**想开启 Git 追踪时使用——移除本地忽略条目，自动 `git add .agent`。
- `cortex-agent untrack`：关闭 Git 追踪——`git rm --cached` + 写入本地忽略，不删除文件。
- `cortex-agent doctor`：一键检查 `.agent`/`AGENTS.md`/`GEMINI.md` 的识别与 Git 状态，并提示下一步操作。

该命令会自动完成以下工作：

1. 在你的项目中创建 `.agent/` 目录并填充核心治理文件（Rules, Workflows, Skills, Sub-agents, Hooks, Plugins）。
2. 自动创建 `AGENTS.md` 与 `GEMINI.md` 入口文件（若不存在），提升多工具（含 Antigravity）识别兼容性。
3. 为 Cursor、Claude Code、Windsurf 等生成对应的入口配置文件（例如 `.cursorrules`, `.clauderules`）。
4. 自动创建必要的符号链接，将 `.agent` 目录下的内容映射到不同平台的习惯配置文件夹中。
5. **自动生成 `.claude/settings.json`**，注入 Claude Code Hooks 配置，实现文件编辑后自动质量检查。
6. **智能识别项目类型**：根据项目是否存在旧的 AI 配置，引导你进入不同的配置流程。

## ⚙️ 项目配置 (Project Configuration)

`cortex-agent init` 命令现在会根据你的项目情况，提供两种初始化配置体验：

### 1. 新项目 (New Project)

如果你的项目中**没有**检测到旧的 AI 助手配置文件（例如 `.cursorrules`, `CLAUDE.md` 等），`init` 命令会为你提供一个全新的 Cortex Agent 框架。

**下一步：运行 `/configure` 命令**
初始化完成后，你将收到提示，建议你在 AI 助手中运行 `/configure` 命令。这是一个交互式的工作流，它将引导你完成以下步骤：

- **项目简要介绍**：描述项目的核心目标和用户。
- **技术栈定义**：明确项目使用的编程语言、框架和关键库。
- **主力语言选择**：选择 TypeScript / Python / Go 等，AI 将自动激活对应的语言规范规则（存放于 `.agent/rules/languages/`）。
- **架构原则**：设定项目的核心设计原则和架构模式。

通过 `/configure` 工作流，Cortex Agent 会自动填充 `.agent/rules/tech-stack.md`、`.agent/rules/architecture-design.md` 和 `.agent/plans/task-progress.md` 等文件，并将语言专属规则追加到 `tech-stack.md`，让 AI 从第一行代码起就遵循语言级约定。

### 2. 现有项目 (Existing Project)

如果 `init` 命令检测到你的项目中**存在**旧的 AI 助手配置文件，它会自动进入迁移模式。

**1. 自动导入 (Automatic Import)**

- `init` 命令会将检测到的旧配置文件（例如 `.cursorrules`, `CLAUDE.md`）的内容，自动复制到新创建的 `.agent/imported_rules/` 目录下。
- 你会收到一份报告，告知哪些文件已被导入。

**2. 运行迁移工作流 (Run Migration Workflow)**

- **手动融合的时代结束了！** `init` 命令执行完毕后，你将收到提示，建议你在 AI 助手中运行 `/migrate-rules` 命令。
- 这是一个为迁移而生的交互式工作流，Cortex Agent 将会：
  - 逐一展示导入的旧规则。
  - 询问你希望将这些旧规则合并到哪个新的核心规则文件（如 `tech-stack.md`）中。
  - 通过对话，辅助你完成规则的**比较、筛选和合并**。
  - 在合并成功后，自动清理已处理的旧规则文件。

通过 `/migrate-rules` 工作流，`cortex-agent` 将繁琐的手动文件比对与合并工作，转变为一个由 AI 辅助的、清晰、可控的对话流程，帮助你更顺畅地将现有项目的 AI 配置，逐步整合到 Cortex Agent 的统一治理框架中。

## 🔧 自定义与演进

所有的指令都是活的。你可以通过以下方式不断优化你的 Agent：

- **`/agent-update`**: 使用该指令来新增或修改规则、工作流。
- **扩展专业能力**: 新增**子代理 (Sub-agents)** 来处理特定领域的复杂任务，例如专门的架构师代理或安全审计代理。
- **精细化控制**: 通过定义**钩子 (Hooks)**，在 Agent 的操作生命周期中插入自定义逻辑，实现更精细的自动化和策略执行。
- **集成新功能**: 通过**插件 (Plugins)** 引入外部工具、自定义数据源或与特定 IDE 的集成，不断扩展 Agent 的核心能力。

## 📦 默认工作流 (Default Workflows)

`cortex-agent` 提供了一系列预定义的工作流，以覆盖常见的开发场景。这些工作流可以通过在 AI 助手（如 Cursor）中输入斜杠命令来调用。

| 工作流 (Command)      | 描述                                           | 使用示例                       |
| :-------------------- | :--------------------------------------------- | :----------------------------- |
| `/agent-update`       | 用于更新或创建 Agent 的规则、工作流或技能。    | `/agent-update "新增一条规则..."` |
| `/arch-design`        | 引导完成新功能的架构设计和提案文档。           | `/arch-design "用户认证模块"`   |
| `/briefing`           | 获取当前项目的简报，了解背景和目标。           | `/briefing`                    |
| `/bug-fix`            | 引导完成一个 Bug 的分析、定位和修复流程。      | `/bug-fix "登录按钮无响应"`     |
| `/code-review`        | 对指定的代码文件或变更进行评审。               | `/code-review "src/utils.js"`  |
| `/commit`             | 遵循项目规范，生成并执行 Git Commit。          | `/commit`                      |
| `/configure`          | **新功能**: 交互式地初始化项目背景、技术栈与架构模式。 | `/configure`                   |
| `/configure-agent`    | 交互式地配置和定制 Agent 框架本身。            | `/configure-agent`             |
| `/migrate-rules`      | **新功能**: 引导式地从旧配置(如 .cursorrules)迁移到新框架。 | `/migrate-rules`               |
| `/start-task`         | 开始执行一个新任务，并创建对应的计划。         | `/start-task "开发新 API"`      |
| `/sync-plans`         | 同步和更新项目的任务计划和进度。               | `/sync-plans`                  |


## 🔌 多平台集成 (Multi-platform Integration)

**Cortex Agent** 的核心设计理念是“工具无关”，旨在成为所有 AI 编程助手的统一治理层。为了实现这一点，它支持两种主要的集成模式：**指令文件集成**和**符号链接集成**。

**`.agent` 目录是所有规则、工作流和知识的唯一真理来源 (Single Source of Truth)。** 通过不同的集成策略，我们可以让各种 AI 工具统一遵循 `Cortex` 的规范。

### 集成模式

1.  **指令文件集成 (Instruction File)**: 这是最通用、最广泛的集成方式。我们通过一个平台特定的配置文件（如 `.aider.instructions.md`, `.clauderules`）向 AI 代理下达“系统级指令”，告诉它必须遵循 `.agent` 目录中的规则和工作流。项目中的 `Aider`, `Claude`, `Continue`, `GitHub Copilot` 和 `Windsurf` 都采用此模式。

2.  **原生/符号链接集成 (Native/Symbolic Link Integration)**: 少数平台（如 `Cursor`, `Claude Code CLI`, `Windsurf`）原生支持加载特定目录下的文件作为自定义命令、规则或代理。对于这些平台，`init` 命令会自动创建符号链接（Symbolic Link），将 `.agent` 的子目录映射到工具的默认配置路径中（例如 `.cursor/commands`, `.claude/commands`），实现更深度的**零开销**原生体验。

### 平台映射指南

下表概述了如何将 `Cortex Agent` 集成到不同的 AI 平台中。

| 平台 (Platform)    | 集成配置文件 (Integration File)                          | 集成方式 (Method)              | 备注 (Notes)                                                                                                                   |
| :----------------- | :------------------------------------------------------- | :----------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| **Cursor**         | `.cursorrules`                                           | 符号链接 (Symlink)             | 同时创建 `.cursor/commands`、`.cursor/rules`、`.cursor/skills` 符号链接，将工作流映射为原生斜杠命令。                          |
| **Claude Code**    | `.clauderules` / `CLAUDE.md`                             | 指令文件 + 符号链接 (Hybrid)   | 同时创建 `.claude/commands`、`.claude/agents`、`.claude/plugins` 符号链接，实现深度原生集成。                                  |
| **Windsurf**       | `.windsurfrules`                                         | 指令文件 + 符号链接 (Hybrid)   | 同时创建 `.windsurf/workflows`、`.windsurf/rules` 符号链接，深度集成工作流和规则。                                             |
| **Aider**          | `.aider.instructions.md`                                 | 指令文件 (Instruction)         | 指示 Aider 将 `/` 命令路由到 `.agent/workflows/` 中的对应文件。                                                               |
| **Continue**       | `.continuerules`                                         | 指令文件 (Instruction)         | 指示 Continue 遵循 `.agent/` 目录中的指导方针。                                                                                |
| **GitHub Copilot** | `.github/copilot-instructions.md`                        | 指令文件 (Instruction)         | 指示 Copilot 在提供代码建议时遵循 `.agent/rules/` 和 `.agent/workflows/`。                                                    |
| **OpenAI Codex**   | `AGENTS.md`                                              | 指令文件 (Instruction)         | Codex 会自动查找并遵循 `AGENTS.md` 文件中的指令。你可以将 `.agent` 中的核心规则聚合或链接到此文件。                            |
| **Gemini CLI**     | `GEMINI.md`                                              | 指令文件 (Instruction)         | Google Gemini CLI (Antigravity) 会自动读取 `GEMINI.md`，以 `AGENTS.md` 为基准并扩展 Gemini 特定行为。         |
| **Cline**          | `.clinerules`                                            | 指令文件 (Instruction)         | VS Code 中极流行的 AI 编程助手，直接读取 `.clinerules` 作为系统指令。                              |
| **Roo Code**       | `.roorules` / `.roo/rules/`                              | 指令文件 + 符号链接 (Hybrid)   | 支持多模式（Architect/Code/Debug/Ask），双路径集成：`.roorules` 指令文件 + `.roo/rules → .agent/rules` 符号链接。 |
| **Amazon Q**       | `.amazonq/rules/cortex.md`                               | 指令文件 (Instruction)         | AWS 官方 AI 编程助手，根据 `.amazonq/rules/*.md` 注入规则到每次对话上下文。                    |

### 快速初始化

`cortex-agent` 的 `init` 命令会根据模板自动创建这些配置文件，为你提供一个开箱即用的起点。你可以根据具体需求进一步调整这些指令文件的内容，以优化特定 AI 助手的性能和行为。

## 🔌 Claude Code 插件安装（可选）

除了 CLI 初始化之外，Cortex Agent 也可以作为 **Claude Code 插件**直接安装，适合仅使用 Claude Code 的团队。

```bash
# 在 Claude Code 中运行（需要 Claude Code ≥ 1.x）
/plugin marketplace add Kucell/cortex-agent
/plugin install cortex-agent@cortex-agent
```

插件安装后，Claude Code 会自动发现根目录下的 `agents/`、`skills/`、`commands/`、`hooks/hooks.json`，无需手动运行 `cortex-agent init`。

> **注意**：CLI 初始化方式（`cortex-agent init`）支持所有平台（Cursor、Windsurf、Claude Code 等）；插件方式仅适用于 Claude Code。

## 🌐 语言规范规则 (Language Rules)

`.agent/rules/languages/` 目录下包含各主流语言的规范文件：

| 语言 | 规则文件 | 覆盖内容 |
| :--- | :--- | :--- |
| TypeScript / JS | `rules/languages/typescript.md` | 类型系统、命名、async、ESLint |
| Python | `rules/languages/python.md` | 类型注解、dataclass、Ruff、mypy |
| Go | `rules/languages/golang.md` | 错误处理、并发、接口设计、golangci-lint |

通过 `/configure` 工作流选择语言后，AI 会自动将对应规则激活。你也可以直接在 `tech-stack.md` 中 `@import` 或手动粘贴对应规则文件的内容。

## 📄 开源协议

MIT
