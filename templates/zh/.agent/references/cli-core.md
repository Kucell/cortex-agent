---
module: cli-core
module_path: "bin + lib"
module_type: "CLI 工具核心"
keywords:
  - CLI
  - init
  - upgrade
  - doctor
  - add
  - remove
  - list
  - track
  - untrack
  - link-global
  - platform
  - registry
  - setup
  - git
estimated_tokens: 900
last_updated: 2026-06-08
last_commit: 957cc7b
dependencies: []
summary: "cortex-agent CLI 入口与核心执行引擎，提供 init/upgrade/add/remove 等全部命令"
status: stable
owner: Codex
last_verified: 2026-06-08
verified_by: Codex
sources:
  - bin/cortex-agent.js
  - lib/
linked_decisions:
  - D-M005-architecture-cd9bb0a8
---

# cli-core 架构参考

> **项目路径**: `bin/` + `lib/`
> **模块类型**: CLI 工具核心
> **核心功能**: cortex-agent 全部命令的入口解析与执行逻辑
> **文档生成时间**: 2026-06-08
> **对应 git commit**: 957cc7b

---

## 🎯 模块概述

`bin/cli.js` 是 CLI 入口，解析命令行参数后将控制权分发给 `lib/commands.js`。`lib/` 目录包含 5 个功能模块，职责清晰隔离：命令实现、平台管理、注册表、文件系统操作和 Git 操作。

## 🛠️ 技术栈

### 核心框架
- Node.js >= 14.0.0（无外部依赖，纯 stdlib）

### 关键模块
- `lib/commands.js`（18KB）: 所有命令的完整实现（init / upgrade / add / remove / list / track / untrack / link-global / doctor）
- `lib/registry.js`: PLATFORM_REGISTRY — 11 个平台的配置声明（files / links / cleanupPaths）
- `lib/platform.js`: 平台增删查、交互式选择、状态持久化（`.agent/.platforms`）
- `lib/setup.js`: 文件复制、旧配置迁移、entry 文件生成、Claude settings 注入
- `lib/git.js`: Git 追踪管理（exclude / untrack）

## 🏗️ 核心架构

### 目录结构
```
bin/
└── cli.js          # 参数解析 + 命令分发
lib/
├── commands.js     # 所有命令实现
├── registry.js     # 平台注册表 + 常量
├── platform.js     # 平台生命周期管理
├── setup.js        # 文件操作 + 初始化
└── git.js          # Git 追踪操作
```

### 命令路由
```
cortex-agent init        → init(ctx)
cortex-agent add         → addPlatforms(ctx)
cortex-agent remove      → removePlatforms(ctx)
cortex-agent list        → listPlatforms(ctx)
cortex-agent upgrade     → upgrade(ctx)
cortex-agent track       → trackAgent(ctx)
cortex-agent untrack     → untrackAgent(ctx)
cortex-agent link-global → linkGlobal(ctx)
cortex-agent doctor      → doctor(ctx)
```

### 支持的平台（PLATFORM_REGISTRY）
cursor, claude, windsurf, aider, copilot, continue, codex, cline, roo-code, amazon-q
默认平台：cursor, claude, windsurf, cline

## 📦 开发命令速查

```bash
npm run release:patch   # patch 版本发布到 npm
npm run release:minor   # minor 版本发布到 npm
npm pub                 # 直接发布（不 bump 版本）
```

## 📌 关键文件路径

- 入口: `bin/cli.js:1`
- 命令实现: `lib/commands.js`
- 平台注册: `lib/registry.js:4`（PLATFORM_REGISTRY）
- 初始化逻辑: `lib/commands.js` → `init()`

## 🛡️ 关键约束与注意事项

- `upgrade` 是纯加法操作，不覆盖已有文件（幂等性保证）
- 语言通过 `--lang=zh/en` 或系统 `$LANG` 自动检测，默认英文
- `lib/` 目录必须在 `package.json files` 字段中声明才能随 npm 发布
