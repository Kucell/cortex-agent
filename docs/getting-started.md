# 快速上手 (Getting Started)

> 从零开始接入 Cortex Agent，或将其集成到已有项目中。

---

## 安装

### 本地命令优先

如果机器已经通过 `npm link`、全局安装或 Volta 暴露了 `cortex-agent`，直接在目标项目根目录运行：

```bash
command -v cortex-agent
cortex-agent --version
cortex-agent init --lang zh
```

如果项目已经存在 `.agent/`，使用纯加法升级：

```bash
cortex-agent upgrade --lang zh
```

给 LLM / AI 助手的初始化指令：

```text
先执行 `command -v cortex-agent`。
如果命令存在，不要使用 npx，直接执行 `cortex-agent init --lang zh`。
如果当前项目已有 `.agent/`，执行 `cortex-agent upgrade --lang zh`。
完成后运行 `/configure` 和 `/scan-project`。
保留当前项目自己的 Git user.name / user.email。
```

### npx 临时使用

```bash
# 初始化当前项目（默认中文模板）
npx cortex-agent init

# 指定语言模板
npx cortex-agent init --lang=en

# 初始化到全局目录 ~/.agent
npx cortex-agent init --global
```

初始化完成后，`.agent/` 目录会被填充核心文件，并根据检测到的 AI 工具自动生成对应的入口配置文件（`.cursorrules`、`.clauderules` 等）和符号链接。

`.agent/` 是唯一维护源。若某些工具生成 `.agents/skills/source-command-*` 之类的兼容目录，它们只属于外部发现适配层，不应手工维护；`cortex-agent init/untrack` 会把 `.agents` 视为本地生成目录。

---

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `cortex-agent init` | 初始化 `.agent/` 目录，生成平台配置文件和符号链接 |
| `cortex-agent init --lang=en` | 使用英文模板初始化 |
| `cortex-agent init --global` | 初始化到 `~/.agent`（全局共享配置） |
| `cortex-agent init --track` | 初始化时同时纳入 Git 追踪（默认本地忽略）|
| `cortex-agent upgrade` | 纯加法升级：补充 `.agent/` 新增文件；若缺失则创建根目录 `AGENTS.md` / `GEMINI.md`；刷新符号链接，**绝不覆盖已有内容** |
| `cortex-agent track` | 开启 Git 追踪：移除本地忽略，自动 `git add .agent` |
| `cortex-agent untrack` | 关闭 Git 追踪：`git rm --cached` + 写入本地忽略，不删除文件 |
| `cortex-agent doctor` | 健康检查：验证 `.agent`/`AGENTS.md`/`GEMINI.md` 识别与 Git 状态 |
| `cortex-agent add <platform>` | 添加平台集成（如 `cline`、`roo`、`codex`）|
| `cortex-agent remove <platform>` | 移除平台集成 |
| `cortex-agent list` | 列出当前已安装的平台集成 |

---

## 接入流程

`init` 命令会自动检测项目类型，引导进入对应流程：

### 场景 A：全新项目

```
cortex-agent init
        ↓
/configure   ← 在 AI 助手中运行
  填写：项目简介 · 技术栈 · 主力语言 · 架构原则
        ↓
    ✅ 接入完成
```

`/configure` 会自动填充：
- `.agent/rules/tech-stack.md` — 技术栈规则
- `.agent/rules/architecture-design.md` — 架构原则
- `.agent/plans/task-progress.md` — 项目路线图
- 将选择的语言规范规则（TypeScript / Python / Go / Java / Swift）追加到 `tech-stack.md`

如果项目存在特殊运行时、设备、桌面端、跨机器 UI 或领域业务验证，建议基于模板创建领域验证技能：

```text
.agent/resources/templates/domain-validation-skill.md
.agent/skills/validate-<domain>/SKILL.md
```

AI 调试期间产生的截图、日志和临时 JSON 默认放入：

```text
.agent/debug/screenshots/
.agent/debug/logs/
.agent/debug/temp/
```

---

### 场景 B：已有项目（有旧 AI 配置）

检测到 `.cursorrules`、`CLAUDE.md` 等旧配置文件时自动进入迁移模式：

```
cortex-agent init             ← 自动复制旧配置到 .agent/imported_rules/
        ↓
自动注册 CLAUDE.md 项目信息到 .agent/references/project-context-from-claude.md
        ↓
/migrate-rules                ← 引导式逐文件合并旧规则到新体系
        ↓
/scan-project                 ← 扫描项目模块，生成 .agent/references/ 知识库
        ↓
/configure                    ← 补充项目背景和架构原则
        ↓
    ✅ 接入完成
```

旧 `CLAUDE.md` 会保留两份：
- `.agent/imported_rules/imported_from_CLAUDE.md.md`：原文备份，便于人工核对
- `.agent/references/project-context-from-claude.md`：正式项目上下文，并写入 `.agent/context-index.json`

因此旧文件中的技术栈、命令、架构约定会立即进入 Cortex Agent 的 references/context-budget 体系；后续仍可再拆分到更细的 reference 或 `.agent/rules/tech-stack.md`。

---

### 场景 C：已有项目（无旧 AI 配置）

```
cortex-agent init
        ↓
/scan-project                 ← 扫描项目模块，生成 .agent/references/ 知识库
        ↓
/configure                    ← 填写技术栈和架构原则
        ↓
    ✅ 接入完成
```

---

## 接入完成后的日常节奏

```
早上  /briefing          → 同步当前阶段、活跃任务、今日优先级
      /start-task T-xxx  → 开始任务（加载上下文，planner 制定计划）
      编码实施...
下班  /ship T-xxx        → 一键交付（代码审查 → commit → 标记完成）
      /update-refs        → 有结构变更时增量更新知识库（可选）
```

> 下一步：查看 [工作流命令列表](./workflows.md) 了解全部可用命令。
