# 多平台集成 (Platform Integration)

> Cortex Agent 的核心设计理念是"工具无关"——`.agent/` 目录是所有规则、工作流和知识的唯一真理来源（Single Source of Truth），通过不同集成策略适配各种 AI 工具。

> **目录边界**：`.agent/` 是唯一维护源。`.agents/skills/source-command-*` 等复数目录如果出现，通常是外部工具把 slash command 转换为 skill 的生成适配层，不应作为 Cortex Agent 规则、工作流或技能的编辑入口。

> **运行期回归**：宿主在 `AGENTS.md` 中看到的 `## Compatibility Adapter Bootstrap` 受管块明确约定——适配器只负责识别命令 `<command>`，识别后**任何任务动作之前必须**加载 `.agent/workflows/<command>.md`；若该真源缺失，必须显式报告并停止，不得回退到适配器副本。

---

## 适配器与真源不一致的诊断示例

当宿主读取了 `.agents/skills/source-command-<command>/SKILL.md` 但 `.agent/workflows/<command>.md` 不存在时，应该输出类似下面的诊断并停止相关工作流，而不是执行适配器副本：

```text
[adapter-vs-truth mismatch] source-command-<command> 指向 <command>，
但 .agent/workflows/<command>.md 缺失。请检查：
  1. 是否漏跑 `cortex-agent update` 补齐真源；
  2. 是否手编辑了 .agents/skills/source-command-*；
  3. .agent/workflows/<command>.md 是否被项目忽略。
已停止本任务的适配器执行。
```

该诊断语气与 `.agent/rules/ai-behavior.md` 中“缺源即停”的规则保持一致，避免适配器副本静默抢占真源。

---

## 集成模式

### 指令文件集成（Instruction File）

最通用的集成方式。通过平台特定的配置文件向 AI 代理下达系统级指令，告知其遵循 `.agent/` 目录中的规则和工作流。

适用平台：Aider、Continue、GitHub Copilot、Cline、Amazon Q 等。

### 符号链接集成（Symbolic Link）

部分平台（Cursor、Claude Code、Windsurf、Roo Code）原生支持加载特定目录下的文件作为自定义命令/规则/代理。`init` 命令会自动创建符号链接，将 `.agent` 子目录映射到工具的默认配置路径，实现零开销原生体验。

### 全局配置 symlink 与可移植性（M-SETUP-PORT-001 / T-ISSUE-3 follow-up）

> **Symlink 跨机器可移植性**：T-ISSUE-3 之后，`linkGlobalConfig()` 会主动生成 5 个本机专属 symlink，全部采用相对路径以保证跨用户 / 跨机器 / 跨容器可移植。仓库根 `.gitignore` 会自动追加这些条目，避免绝对路径 symlink 进版本控制。`doctor` 会在 5 类状态（`missing` / `not-symlink` / `broken` / `wrong-target` / `home-missing`）上对每个 symlink 主动检查并报告。

**`linkGlobalConfig()` 管理的 5 个 symlink**

| 相对路径 | 目标 | 用途 |
|---|---|---|
| `.agent/global` | `~/.agent` | 全局 Cortex 配置入口 |
| `.agent/global-shared-skills` | `~/.agents/skills` | Agent Skills 标准共享技能 |
| `.cursor/global-rules` | `~/.agent/rules` | Cursor 全局规则 |
| `.cursor/global-commands` | `~/.agent/workflows` | Cursor 全局工作流命令 |
| `.claude/global-commands` | `~/.agent/workflows` | Claude Code 全局工作流命令 |

**要点**

- **相对路径**：`linkGlobalConfig()` 写入 `path.relative(<parent>, <realTarget>)` 作为 symlink target，不再用 `os.homedir()` 拼绝对路径。绝对路径会在换用户、换机器、换容器（DevContainer / Codespaces / Docker）时立刻断链。
- **创建期校验**：每次创建 symlink 后立即 `realpathSync()` 验证可解析，避免留下"节点在但 target 死"的隐蔽 broken symlink。`realTarget` 不可解析（目标目录缺失）时 warn + skip，绝不静默失败。
- **静态期校验**：`cortex-agent doctor` 的 `setup-portability` 段对每个 symlink 输出 5 类状态：
  - `ok` — symlink 存在且 resolve 到当前 `~/.agent`（或对应 home 路径）
  - `missing` — 节点不存在（`init` 没跑过）
  - `not-symlink` — 节点不是 symlink（被覆盖为普通文件或目录）
  - `broken` — 节点在但 target 不可解析
  - `wrong-target` — target 与当前 home 不一致（跨用户、换机器后）
  - `home-missing` — 目标 home 路径本身不可解析
- **Git 卫生（自动）**：`linkGlobalConfig()` 创建 symlink 后，会**自动**把相对路径追加到仓库根 `.gitignore`，确保绝对路径 symlink 不会进版本控制。如希望不污染项目 `.gitignore`，可在 `init` / `upgrade` 调用时设 `useLocalExclude: true`，改为写入 `.git/info/exclude`（本机专属 exclude）。两个开关：
  - `updateGitignore: false` — 完全跳过 ignore 写入（用于 CI / sandbox）
  - `useLocalExclude: true` — 走 `.git/info/exclude`（默认走 `.gitignore`）
- **不要**手编辑这些 symlink；删除后重跑 `cortex-agent init` 即可重建，且会重新触发 gitignore 写入（幂等）。
- **克隆后行为**：换机器 / 新用户拉取项目后第一次跑 `cortex-agent init` / `update` 时会自动重建相对路径 symlink；无需手动干预。
- **跨平台 doctor**：`doctor` 在 git 仓库里还会输出每个 symlink 的 `git tracked / ignored` 状态；如果 `ok` 但被 git 跟踪，会额外 warning 提示运行 `cortex-agent untrack`。

---

## 平台映射表

| 平台 | 集成配置文件 | 集成方式 | 说明 |
| --- | :---: | --- | --- |
| **Cursor** | `.cursorrules` | 符号链接 | 创建 `.cursor/commands`、`.cursor/rules`、`.cursor/skills` 符号链接，工作流映射为原生斜杠命令 |
| **Claude Code** | `.clauderules` / `CLAUDE.md` | 指令入口文件 + 符号链接 | `CLAUDE.md` 引导加载 `.agent/`；创建 `.claude/commands`、`.claude/agents`、`.claude/plugins` 符号链接，实现深度原生集成 |
| **Windsurf** | `.windsurfrules` | 指令文件 + 符号链接 | 创建 `.windsurf/workflows`、`.windsurf/rules` 符号链接 |
| **Aider** | `.aider.instructions.md` | 指令文件 | 将 `/` 命令路由到 `.agent/workflows/` 对应文件 |
| **Continue** | `.continuerules` | 指令文件 | 遵循 `.agent/` 目录中的指导方针 |
| **GitHub Copilot** | `.github/copilot-instructions.md` | 指令文件 | 在代码建议时遵循 `.agent/rules/` 和 `.agent/workflows/` |
| **OpenAI Codex** | `AGENTS.md` + `.codex/` | 指令文件 + 符号链接 | 根目录 `AGENTS.md` 由 `init`/`upgrade` 保证；`cortex-agent add codex` 会生成 `.codex/config.toml`、`.codex/README.md`，并将 `.codex/prompts` 链接到 `.agent/workflows/`（用 `/mention` 引用具体工作流） |
| **Gemini CLI** | `GEMINI.md` | 指令文件 | 自动读取 `GEMINI.md`，以 `AGENTS.md` 为基准扩展 Gemini 特定行为 |
| **Cline** | `.clinerules` | 指令文件 | VS Code 中的 AI 编程助手，直接读取 `.clinerules` 作为系统指令 |
| **Roo Code** | `.roorules` / `.roo/rules/` | 指令文件 + 符号链接 | 支持多模式（Architect/Code/Debug/Ask），双路径集成 |
| **Amazon Q** | `.amazonq/rules/cortex.md` | 指令文件 | AWS 官方 AI 助手，从 `.amazonq/rules/*.md` 注入规则到每次对话上下文 |

### OpenAI Codex 集成的内存边界（closes #4）

> **作用域**：本节只描述 OpenAI / Codex CLI 场景下"哪些规则应该放哪里"的边界。 其他工具（Claude Code / Cursor / Windsurf 等）通常只读 `.agent/memory/`，不直接产生个人 memory，这条边界对它们是单方面的——但项目规则存放准则（第四条）对所有平台都适用。

#### 1. 两套 memory 的边界

Codex CLI 在项目中会同时看到两套完全不同的 memory 来源，**它们不是同义词**：

| 来源 | 路径 | 范围 | 谁管理 | 持久性 | 禁止放什么 |
|---|---|---|---|---|---|
| **Cortex 项目级 memory** | `.agent/memory/{user,feedback,project,reference}/*.md` | 单项目 | 由 `MEMORY.md` 索引和 `memory.schema.json` 约束；`init`/`upgrade` 维护 | **进版本控制** | 凭据 / Token / 本机绝对路径 |
| **Codex CLI 个人 memory** | `~/.codex/memories/` | 当前用户 + 当前机器 | Codex CLI 自动生成 | **不进版本控制** | 同上 |

> 关键差异：Cortex 项目级 memory 是**项目的事实**（约束、协议、流程），跟用户/机器无关；`~/.codex/memories/` 是**个人偏好**（语言、风格、命名习惯），跟项目无关。两者由两套 schema 管理，**互不预期对方存在**。

#### 2. 规则存放准则（适用于所有工具）

- **必须执行的项目规则**（行为约束、协议、流程） → `AGENTS.md` 或 `.agent/rules/*.md`
- **跨 session 偏好**（语言、风格、命名习惯） → `.agent/memory/user/*.md`
- **项目事实快照**（已知坑、本项目独有约定） → `.agent/memory/project/*.md`
- **外部参考摘要**（链接、API 速记） → `.agent/memory/reference/*.md`
- **临时观察 / 自动进化产物** → `.agent/memory/feedback/*.md`（带 `expires`）

> **不要**把"必须执行"的项目规则只放在任何一种 memory 里：项目级 memory 受 schema 约束，个人 memory 不进版本控制，两者在多用户/多机器/多工具切换时都会失效。`AGENTS.md` / `.agent/rules/` 是唯一会随项目 Git 走、跨用户/跨机器/跨工具都生效的载体。

完整机制与硬上限（user 10 / feedback 30 / project 20 / reference 50）见 `.agent/memory/README.md`（zh 同步见 `templates/zh/.agent/memory/README.md`），每次 `cortex-agent doctor` 都会跑一次完整性校验（`lib/memory-validate.js`）。

#### 3. 与外部工具的隔离

在启用 MCP / Web 抓取 / 远程文档访问的 session 里，Codex 默认会把外部内容并入 prompt，触发 `memory-recall` 时可能让外部内容污染命中集合。建议在 `.codex/config.toml` 显式：

```toml
disable_on_external_context = true
```

开启后 memory 召回只走受控的 `.agent/memory/`，降低外部内容污染面。**该项不替代**项目内对外部输入的 MCP 工具白名单 / 函数级审计——它是 Codex 侧的最后一道防线。

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
| **OpenAI Codex** | `AGENTS.md` + `.codex/` | 指令文件 + 符号链接 | 根目录 `AGENTS.md` 由 `init`/`upgrade` 保证；`cortex-agent add codex` 会生成 `.codex/config.toml`、`.codex/README.md`，并将 `.codex/prompts` 链接到 `.agent/workflows/`（用 `/mention` 引用具体工作流）。Codex 集成的 memory 边界与规则存放准则见下文 [OpenAI Codex 集成的内存边界](#openai-codex-集成的内存边界closes-4) 一节。 |
