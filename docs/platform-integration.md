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
| **OpenAI Codex** | `AGENTS.md` + `.codex/` | 指令文件 + 符号链接 | 根目录 `AGENTS.md` 由 `init`/`upgrade` 保证；`cortex-agent add codex` 会生成 `.codex/config.toml`、`.codex/README.md`，并将 `.codex/prompts` 链接到 `.agent/workflows/`（用 `/mention` 引用具体工作流）。Codex 项目级 memory 边界与外部上下文隔离见下文 §"平台集成 · Memory 与外部上下文边界" |
| **Gemini CLI** | `GEMINI.md` | 指令文件 | 自动读取 `GEMINI.md`，以 `AGENTS.md` 为基准扩展 Gemini 特定行为 |
| **Cline** | `.clinerules` | 指令文件 | VS Code 中的 AI 编程助手，直接读取 `.clinerules` 作为系统指令 |
| **Roo Code** | `.roorules` / `.roo/rules/` | 指令文件 + 符号链接 | 支持多模式（Architect/Code/Debug/Ask），双路径集成 |
| **Amazon Q** | `.amazonq/rules/cortex.md` | 指令文件 | AWS 官方 AI 助手，从 `.amazonq/rules/*.md` 注入规则到每次对话上下文 |

---

## 平台集成 · Memory 与外部上下文边界

> **背景**：cortex-agent 把"项目级记忆"（`.agent/memory/`）与宿主工具的"个人 memory"明确分层。本节以 **OpenAI Codex** 为代表给出当前仓库**已实现并验证**的边界、规则存放准则与外部上下文隔离做法；其他宿主对应做法见各提案与对应 `AGENTS.md` 段。本节描述的"是否支持"以 `templates/{zh,en}/integrations/codex/.codex/config.toml` 与 `AGENTS.md` 当前模板为准。

### 两套 Memory 的边界

| 来源 | 路径 | 范围 | 谁管理 | 持久性 |
|---|---|---|---|---|
| Cortex 项目级 memory | `.agent/memory/{user,feedback,project,reference}/*.md` + 索引 `MEMORY.md` | 单项目 | 由 `MEMORY.md` 索引 + `memory.schema.json` 约束；`init`/`upgrade` 维护；四类硬上限 user 10 / feedback 30 / project 20 / reference 50 | **进版本控制** |
| Cortex 全局 memory | `~/.agent/memory/` | 当前用户 + 当前机器 | 由 `AGENTS.md` 的 `Memory Bootstrap` 段定义；与项目 `.agent/memory/MEMORY.md` 互为补集 | 一般不进版本控制 |
| Codex 个人 memory | `~/.codex/memories/` | 当前用户 + 当前机器 | Codex CLI 自动生成 | 不进版本控制 |
| Claude Code Auto Memory | `~/.claude/memory/` | 当前用户 + 当前机器 | Claude Code 自动生成 | 不进版本控制 |

> **项目共享索引**：所有宿主（Codex、Claude、Gemini、Cursor、Cline、Roo、Pi、MiniMax、Qoder 等）切换时，统一以**当前项目**的 `.agent/memory/MEMORY.md` 作为共享召回索引（参见 `AGENTS.md` 的 `Memory Bootstrap` 段与 `.agent/rules/memory-protocol.md §5.1`）。宿主私有 memory 只能作为缓存，与当前用户指令、已验证的项目文件或 `.agent/` 内容冲突时，**以后者为准**。需要强调的是：Codex 自身的"本地 memory"配置开关（如 `memories.disable_on_external_context`）只影响 Codex 内部 `~/.codex/memories/` 的**生成**行为，不改变 Cortex 这条"以 `.agent/memory/MEMORY.md` 为共享召回索引"的边界 —— 两者是正交的。

### 规则存放准则（强制分层）

| 规则类型 | 应该放哪里 | **不**应该放哪里 |
|---|---|---|
| 行为约束（"永远中文回复"、"先 lint 再 commit"、协议、流程） | `AGENTS.md` 或 `.agent/rules/*.md`（强约束） | 仅放在任何一种 memory 里 — memory 受 schema 约束、`memory-validate` 可能改写，跨用户/跨机器/多工具切换时不一定被 recall |
| 跨 session 偏好（语言、风格、命名习惯等可复用偏好） | `.agent/memory/user/*.md`（项目内统一）+ `AGENTS.md` 引导所有宿主读 `MEMORY.md` | `~/.codex/memories/` 或 `~/.claude/memory/` 单独存放 — 这些是单用户/单机器私有，不与项目其他协作者共享 |
| 项目事实快照（已知坑、本项目独有约定） | `.agent/memory/project/*.md` | `.agent/memory/reference/`（过重 — `reference/` 只放指向既有 `.agent/` 内容的指针，不复制正文） |
| 外部参考摘要（链接、API 速记） | `.agent/memory/reference/*.md`（1–2 句指针，正文留在 `.agent/references/`） | 把完整正文复制进 `memory/reference/`（违反 `memory-protocol.md §4.5`） |
| 临时观察 / 自动进化产物 | `.agent/memory/feedback/*.md`（必填 `expires`，90 天后归档到 `feedback/_archive/`） | `experiences/`（`experiences/` 是 commit-anchored 防复发载体，不是轻量观察） |

> **核心原则**："必须执行的项目规则"的唯一可靠位置是当前项目的 `AGENTS.md` 与 `.agent/rules/*.md`（强约束位置），**不**依赖任何 memory 层，原因是：
> 1. 项目级 `.agent/memory/` 受 schema 约束与四类硬上限管理（参见 `memory-protocol.md §2/§7`），`memory-validate` 可能在 `user 10 / feedback 30 / project 20 / reference 50` 触发后改写、合并或归档；
> 2. 个人 memory（`~/.codex/memories/`、`~/.claude/memory/`、`~/.agent/memory/` 全局层）不进版本控制，多用户/多机器/多工具切换时**不一定被 recall**；
> 3. 跨宿主唯一可靠来源是当前项目的 `AGENTS.md` + `.agent/rules/`；`.agent/memory/` 只承担"项目内可复用偏好、事实、参考与反馈"的角色，**不**承载"必须执行"的强约束语义。

### 宿主私有 Memory 适配（已验证）

| 宿主 | 用户/全局 memory | 项目/运行时 memory | 接入边界 |
|---|---|---|---|
| OpenAI Codex | `~/.codex/memories/`（CLI 自动生成） | 项目级以 `.agent/memory/MEMORY.md` 为索引 | 通过 `AGENTS.md` 引导读 `MEMORY.md`；不使用 Codex 个人 memory 替代项目 memory |
| Claude Code | `~/.claude/memory/`（Auto Memory 自动生成） | 项目级以 `.agent/memory/MEMORY.md` 为索引 | 同上；宿主私有 memory 仅作缓存 |
| MiniMax | `~/.minimax/memory/user.md`；tracking 日志位于 `~/.minimax/memory/tracking/` | `main` / `topic` 由 runtime 托管；`summary` 是视图 | 使用 MiniMax `memory` / `mavis` 工具；**不**直接编辑 runtime 内部存储或索引缓存 |
| Qoder CN | `~/.qoder-cn/memories/<user-hash>/{global,projects}/<category>/` | 同上，按 `<encoded-project-path>/<category>/` 分桶 | 运行时发现 `<user-hash>` 与项目桶，**不**硬编码；`SharedClientCache/index/` 是索引缓存，**不**是记忆正文 |

> 完整表格与边界说明参见 `.agent/rules/memory-protocol.md §5.1`；本节只摘录 Codex 一行（与本节主题对齐）。其他宿主的等价条目已在 `memory-protocol.md` 中列出。

### 与外部上下文的隔离（Codex 本地 memory 的官方开关 + Cortex 受控层）

> **重要更正（取代 d350135 的同节措辞）**：原平台集成 memory 边界提案（`D-arch-plat-mem-boundary-001`）建议的 `disable_on_external_context` 是 **Codex CLI 官方文档正式收录**的配置键。Codex 官方说明语义为："when true, keeps chats that used external context such as MCP tool calls, web search, or tool search out of memory generation"，旧名 `memories.no_memories_if_mcp_or_web_search` 仍被接受为别名。**该键控制的是 Codex 本地 memory 的"生成"侧（是否纳入含 MCP / web search / tool search 的会话作为生成输入），不是召回侧** —— 因此不会改变"以 `.agent/memory/MEMORY.md` 为项目级共享召回索引"的边界，也不会把召回重定向到 `~/.agent/memory/`。

**Codex 本地 memory 的官方开关（已在 Codex 官方 `codex/customization/memories` 页明确收录）**

| 层级 | 键 | 推荐值 | 作用 |
|---|---|---|---|
| 启用开关（features 段） | `[features] memories = true` | `true` | 默认关闭；不启用此 flag，下面的 memory-specific 设置不会生效。Codex 桌面应用侧等价路径：Settings → Personalization → Enable memories |
| 生成侧外部上下文隔离 | `[memories] disable_on_external_context = true`（或旧别名 `no_memories_if_mcp_or_web_search = true`） | `true` | 让"用过 MCP 工具调用 / web search / tool search 的会话"**不**进入 Codex 本地 memory 的生成输入；只影响 `~/.codex/memories/` 的写入，**不**改变 recall |
| 其他相关（memory） | `memories.generate_memories`、`memories.use_memories`、`memories.min_rate_limit_remaining_percent`、`memories.extract_model`、`memories.consolidation_model` | 按需 | 控制"新会话是否可作为生成输入 / 是否注入既有 memory / 低于多少 rate-limit 跳过 / 抽取与合并模型" |

**模板与项目级配置的关系**

- `templates/{zh,en}/integrations/codex/.codex/config.toml` 当前模板**未**写入这些键；启用与否留给用户在仓库根 `.codex/config.toml` 或 `~/.codex/config.toml` 自行决定。`cortex-agent add codex` 也**不**自动改写 `~/.codex/config.toml`。
- 当且仅当用户在 `.codex/config.toml`（项目层）中加入上述块、且仓库被 Codex 标记为受信任时，这些键才会生效；CI / DevContainer 等场景建议走 `~/.codex/config.toml`（用户层），避免把个人偏好签入仓库。

**Cortex 侧的补充受控层**（与上面 Codex 开关**叠加生效**，覆盖不到的部分由本仓库自身约束兜底）

1. **AGENTS.md 受控读取**：根目录 `AGENTS.md` 引导宿主读 `MEMORY.md` 与 `.agent/rules/` 时不抓外部内容（除非用户显式要求 fetch），本身是受控的；
2. **memory-recall 走受控索引**：宿主做项目级 memory 召回时统一走 `.agent/memory/MEMORY.md`（参见 `AGENTS.md` 的 `Memory Bootstrap` 段），外部抓取内容默认不进入 MEMORY.md；
3. **memory-protocol.md §8 Staleness Rule**：与当前用户指令或已验证项目文件冲突时，**memory 优先级更低**，防止外部抓取内容污染下次 session 的判断。

> **关于"启用 Codex 本地 memory 后是否会污染 Cortex 项目 memory"的回答**：**不会**。Cortex 的 `.agent/memory/` 由本仓库协议（`memory-protocol.md`）管控写入路径；Codex 自动生成的 `~/.codex/memories/` 是另一套独立文件。两者是正交存储，不会互相写入。

### 链接到既有项目 memory 文档

- `.agent/memory/README.md` — `.agent/memory/` 的整体机制说明（四类、硬上限、写入约定）
- `.agent/memory/MEMORY.md` — 项目级 memory 索引（≤200 行 / 25 KB）
- `.agent/memory/memory.schema.json` — topic 文件 YAML frontmatter 的 JSON Schema
- `.agent/rules/memory-protocol.md` — 四类的写入 / 读取 / 过期 / 归档协议（含 §5.1 跨宿主私有 memory 适配与 §8 Staleness Rule）
- `AGENTS.md` 的 `Memory Bootstrap` 段 — 跨宿主共享记忆与切换交接约束
- `.agent/memory/project/cross-host-memory-handoff.md` — 项目级 memory 的跨宿主交接事实

> 本节是该体系在"平台集成"维度上的入口；具体写入 / 校验 / 归档协议见 `memory-protocol.md`，schema 见 `memory.schema.json`。

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
