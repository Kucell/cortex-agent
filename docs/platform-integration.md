# 多平台集成 (Platform Integration)

> Cortex Agent 的核心设计理念是"工具无关"——`.agent/` 目录是所有规则、工作流和知识的唯一真理来源（Single Source of Truth），通过不同集成策略适配各种 AI 工具。

---

## 集成模式

### 指令文件集成（Instruction File）

最通用的集成方式。通过平台特定的配置文件向 AI 代理下达系统级指令，告知其遵循 `.agent/` 目录中的规则和工作流。

适用平台：Aider、Continue、GitHub Copilot、Cline、Amazon Q 等。

### 符号链接集成（Symbolic Link）

部分平台（Cursor、Claude Code、Windsurf、Roo Code）原生支持加载特定目录下的文件作为自定义命令/规则/代理。`init` 命令会自动创建符号链接，将 `.agent` 子目录映射到工具的默认配置路径，实现零开销原生体验。

---

## 平台映射表

| 平台 | 集成配置文件 | 集成方式 | 说明 |
| --- | :---: | --- | --- |
| **Cursor** | `.cursorrules` | 符号链接 | 创建 `.cursor/commands`、`.cursor/rules`、`.cursor/skills` 符号链接，工作流映射为原生斜杠命令 |
| **Claude Code** | `.clauderules` / `CLAUDE.md` | 指令文件 + 符号链接 | 创建 `.claude/commands`、`.claude/agents`、`.claude/plugins` 符号链接，实现深度原生集成 |
| **Windsurf** | `.windsurfrules` | 指令文件 + 符号链接 | 创建 `.windsurf/workflows`、`.windsurf/rules` 符号链接 |
| **Aider** | `.aider.instructions.md` | 指令文件 | 将 `/` 命令路由到 `.agent/workflows/` 对应文件 |
| **Continue** | `.continuerules` | 指令文件 | 遵循 `.agent/` 目录中的指导方针 |
| **GitHub Copilot** | `.github/copilot-instructions.md` | 指令文件 | 在代码建议时遵循 `.agent/rules/` 和 `.agent/workflows/` |
| **OpenAI Codex** | `AGENTS.md` + `.codex/` | 指令文件 + 符号链接 | 根目录 `AGENTS.md` 由 `init`/`upgrade` 保证；`cortex-agent add codex` 会生成 `.codex/config.toml`、`.codex/README.md`，并将 `.codex/prompts` 链接到 `.agent/workflows/`（用 `/mention` 引用具体工作流） |
| **Gemini CLI** | `GEMINI.md` | 指令文件 | 自动读取 `GEMINI.md`，以 `AGENTS.md` 为基准扩展 Gemini 特定行为 |
| **Cline** | `.clinerules` | 指令文件 | VS Code 中的 AI 编程助手，直接读取 `.clinerules` 作为系统指令 |
| **Roo Code** | `.roorules` / `.roo/rules/` | 指令文件 + 符号链接 | 支持多模式（Architect/Code/Debug/Ask），双路径集成 |
| **Amazon Q** | `.amazonq/rules/cortex.md` | 指令文件 | AWS 官方 AI 助手，从 `.amazonq/rules/*.md` 注入规则到每次对话上下文 |

---

## 平台管理命令

```bash
# 添加平台集成
cortex-agent add cline
cortex-agent add roo

# 移除平台集成
cortex-agent remove cline

# 查看已安装平台
cortex-agent list
```

已安装的平台状态持久化在 `.agent/.platforms` 文件中。

---

## Claude Code 插件安装（可选）

除了 CLI 初始化之外，Cortex Agent 也可以作为 **Claude Code 插件**直接安装：

```bash
# 在 Claude Code 中运行
/plugin marketplace add Kucell/cortex-agent
/plugin install cortex-agent@cortex-agent
```

插件安装后，Claude Code 自动发现根目录下的 `agents/`、`skills/`、`commands/`、`hooks/hooks.json`，无需手动运行 `cortex-agent init`。

> **CLI vs 插件**：CLI 方式（`cortex-agent init`）支持所有平台；插件方式仅适用于 Claude Code。

---

> 返回：[快速上手](./getting-started.md) | [工作流命令](./workflows.md)
