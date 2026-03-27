# 快速上手 (Getting Started)

> 从零开始接入 Cortex Agent，或将其集成到已有项目中。

---

## 安装

```bash
# 初始化当前项目（默认中文模板）
npx cortex-agent init

# 指定语言模板
npx cortex-agent init --lang=en

# 初始化到全局目录 ~/.agent
npx cortex-agent init --global
```

初始化完成后，`.agent/` 目录会被填充核心文件，并根据检测到的 AI 工具自动生成对应的入口配置文件（`.cursorrules`、`.clauderules` 等）和符号链接。

---

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `cortex-agent init` | 初始化 `.agent/` 目录，生成平台配置文件和符号链接 |
| `cortex-agent init --lang=en` | 使用英文模板初始化 |
| `cortex-agent init --global` | 初始化到 `~/.agent`（全局共享配置） |
| `cortex-agent init --track` | 初始化时同时纳入 Git 追踪（默认本地忽略）|
| `cortex-agent upgrade` | 纯加法升级：补充新增文件，刷新符号链接，**绝不覆盖已有内容** |
| `cortex-agent track` | 开启 Git 追踪：移除本地忽略，自动 `git add .agent` |
| `cortex-agent untrack` | 关闭 Git 追踪：`git rm --cached` + 写入本地忽略，不删除文件 |
| `cortex-agent doctor` | 健康检查：验证 `.agent`/`AGENTS.md`/`GEMINI.md` 识别与 Git 状态 |
| `cortex-agent add <platform>` | 添加平台集成（如 `cline`、`roo`）|
| `cortex-agent remove <platform>` | 移除平台集成 |
| `cortex-agent list` | 列出当前已安装的平台集成 |

---

## 接入流程

`init` 命令会自动检测项目类型，引导进入对应流程：

### 场景 A：全新项目

```
npx cortex-agent init
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

---

### 场景 B：已有项目（有旧 AI 配置）

检测到 `.cursorrules`、`CLAUDE.md` 等旧配置文件时自动进入迁移模式：

```
npx cortex-agent init         ← 自动复制旧配置到 .agent/imported_rules/
        ↓
/migrate-rules                ← 引导式逐文件合并旧规则到新体系
        ↓
/scan-project                 ← 扫描项目模块，生成 .agent/references/ 知识库
        ↓
/configure                    ← 补充项目背景和架构原则
        ↓
    ✅ 接入完成
```

---

### 场景 C：已有项目（无旧 AI 配置）

```
npx cortex-agent init
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
