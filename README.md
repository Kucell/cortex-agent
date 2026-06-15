# 🧠 Cortex Agent Framework

**Cortex Agent** 是一个为 AI 编程助手（Cursor、Claude Code、Windsurf、Gemini CLI 等）设计的治理与指令框架。它通过一套结构化的**规则 (Rules)**、**工作流 (Workflows)** 和**技能 (Skills)**，将 AI 从简单的代码生成器提升为具有架构意识和工程规范的"资深工程师"。

## 核心价值

- **架构一致性**：强制 AI 遵循项目预定义的架构模式（六边形、分层、微服务等）。
- **专业化委托**：核心执行 Sub-agent（planner / implementer / researcher / code-reviewer / documenter）与治理型 Sub-agent 分工协作，职责隔离。
- **上下文预算控制**：`context-budget` skill 按 Tier 0-3 分级裁剪上下文，将有效负载控制在窗口 40% 以内。
- **推理三明治**：`/ship` 按 规划(premium) → 执行(standard) → 验证(standard) 分配模型算力，兼顾质量与成本。
- **结构化交接**：`/handoff` 为跨 Agent、跨会话和 sub-agent 接力生成轻量交接文档，避免依赖对话记忆。
- **长周期任务编排**：`/mission` 通过 milestone、验证契约和命令日志支撑多阶段任务稳定推进。
- **熵治理闭环**：`entropy-scanner` 周期扫描知识库漂移，PostCommit Hook 自动修复，保持 `.agent/` 长期健康。
- **工具无关**：同一套 `.agent/` 配置通过符号链接和指令文件适配 11 个主流 AI 平台。

## 快速开始

```bash
# 初始化当前项目（默认中文模板）
npx cortex-agent init

# 英文模板
npx cortex-agent init --lang=en

# 升级已有安装（纯加法，不覆盖已有文件）
npx cortex-agent upgrade
```

初始化后，在 AI 助手中运行 `/configure` 完成项目配置。

常用工作流示例：

```
# 从需求描述生成原型（Mermaid 流程图 + Anime.js HTML），输出验收契约
/prototype T-001

# 指定 UI 模式和中等保真度（需 Pixso MCP）
/prototype T-001 --mode ui --fidelity mid

# 仅生成 Mermaid 流程图（最轻量，无工具依赖）
/prototype T-001 --mode doc --fidelity low
```

### 上手流程一览

<p align="center">
  <img src="docs/assets/quick-start.svg" alt="Cortex Agent 5 步快速上手" width="100%">
</p>

<p align="center">
  <em>左：终端实际命令 · 右：每一步的指示 · 总时长约 12 秒 · 无限循环</em>
</p>

## 目录结构

```text
.agent/
├── rules/          # 核心规则：架构约束、代码规范、语言规则
├── workflows/      # 工作流：/start-task /ship /handoff /mission /configure 等斜杠命令
├── skills/         # 专项技能：architecture-guard / context-budget / validation-contract / self-check
├── sub-agents/     # 子代理：planner / implementer / researcher / coordinator 等
├── hooks/          # 钩子：PostToolUse Lint 检查 + PostCommit 熵清理
├── config/         # 配置：reasoning-config.yml（模型 & API 配置）
├── plans/          # 进度管理：task-progress.md 路线图
├── handoffs/       # 任务交接：跨 Agent / 跨会话的轻量上下文包
├── missions/       # 长周期任务状态：/mission 按需创建
├── registry/       # Agent Registry：coordinator 多 agent 协调
├── artifacts/      # Artifact Bus：coordinator 结构化产物存储
├── locks/          # Progress Lock：任务级 / 文件级互斥
└── references/     # 知识库：/scan-project 生成的模块参考文档

> **自举仓库**：cortex-agent 自身的 `.agent/` 目录作为独立仓库管理：[Kucell/cortex-agent-agent](https://github.com/Kucell/cortex-agent-agent)
> 本仓库通过 `cortex-agent untrack`（默认）保持 `.agent/` 不被主仓库追踪，IDE 仍可通过符号链接识别 slash 命令菜单。
> 详见 [docs/architecture/self-bootstrapping.md](docs/architecture/self-bootstrapping.md)

docs/
├── architecture/   # 架构设计与演进方案
├── exec-plans/     # 跨会话执行计划资产
├── quality/        # knowledge lint、doc-gardening 与质量治理
├── reliability/    # 日志、指标、Trace、浏览器验证等运行时证据
├── security/       # 安全边界与扫描策略
└── tech-debt.md    # 已知技术债务与偿还路径
```

## 可选增强

### Graphify 知识图谱（可选）

安装 Graphify 后，agent 在 `/handoff` 时可携带当前任务相关的代码知识子图，接手方无需重新探索代码库。未安装时框架自动降级，所有工作流正常运行。

**安装：**

```bash
pip install graphifyy && graphify install
# macOS externally-managed 环境：
pip install --break-system-packages graphifyy && graphify install
```

**扫描项目图谱（在项目根目录执行一次）：**

```bash
graphify update .                        # 代码图谱，无需 API Key
ANTHROPIC_API_KEY=sk-... graphify .      # 完整图谱（含 Markdown 文档）
```

**在 `/handoff` 前提取任务子图：**

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task T-xxx \
  --files "src/main.js,lib/api.js"
# 输出：.agent/artifacts/T-xxx/graphify-subgraph.json
# 并自动注册到 Artifact Bus（kind: knowledge-graph）
```

**在 Claude Code 中查询图谱：**

```
/graphify query "coordinator 与 artifact bus 如何协作？"
/graphify path "handoff-protocol.js" "artifact-bus.js"
/graphify explain "coordinator"
```

详见：[`.agent/plugins/graphify/README.md`](.agent/plugins/graphify/README.md) · [设计提案](docs/architecture/graphify-integration-proposal.md)

---

## 文档索引

| 文档 | 内容 |
| :--- | :--- |
| [docs/getting-started.md](docs/getting-started.md) | CLI 命令参考、新项目/已有项目完整接入流程 |
| [docs/workflows.md](docs/workflows.md) | 全部工作流命令、完整开发链路图、/ship 状态机 |
| [docs/sub-agents.md](docs/sub-agents.md) | Sub-agent 架构图、技能映射、输出契约、路由配置 |
| [docs/platform-integration.md](docs/platform-integration.md) | 11 平台集成方式、Claude Code 插件安装 |
| [docs/language-rules.md](docs/language-rules.md) | TypeScript / Python / Go / Java / Swift 规范 |
| [docs/customization.md](docs/customization.md) | 自定义规则、扩展 Sub-agent、添加 Hooks |
| [docs/architecture.md](docs/architecture.md) | 整体架构设计、模块职责、Mission Lite 设计、Hooks 触发机制 |
| [docs/architecture/mission-lite-design.md](docs/architecture/mission-lite-design.md) | Mission Lite 长周期任务编排的详细架构方案 |
| [docs/architecture/harness-optimization-design.md](docs/architecture/harness-optimization-design.md) | Harness Engineering 与 Mission Lite 演进设计 |
| [docs/architecture/multi-agent-coordinator.md](docs/architecture/multi-agent-coordinator.md) | Multi-Agent Coordinator（多 agent × 多模型协调层）设计稿 |
| [docs/architecture/self-bootstrapping.md](docs/architecture/self-bootstrapping.md) | 自举工作流：框架使用自身能力完成自我验证和实时更新 |
| [docs/architecture/experience-recursion.md](docs/architecture/experience-recursion.md) | 经验自递归：踩坑→沉淀→检索→防复发闭环设计 |
| [docs/architecture/graphify-integration-proposal.md](docs/architecture/graphify-integration-proposal.md) | Graphify 知识图谱集成提案（Artifact Bus 扩展 + Handoff 协议联动） |
| [docs/architecture/prototype-workflow-design.md](docs/architecture/prototype-workflow-design.md) | /prototype 双路径设计（Document + Pixso UI），需求→原型→验收契约完整链路 |

## 开源协议

MIT
