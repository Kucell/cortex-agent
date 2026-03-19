---
name: scan-project
description: 扫描现有项目结构，自动识别模块/微应用，为每个模块生成结构化的架构参考文档，存放于 .agent/references/。适合项目首次接入 Cortex Agent 时建立知识库。
---

# 项目扫描工作流 (/scan-project)

## 目标

扫描当前项目，识别所有模块/子应用，为每个模块生成 `.agent/references/{模块名}.md` 架构参考文档，让 AI agent 在后续任何任务中都能快速获取准确的项目上下文。

---

## 扫描流程

### 第一步：项目全局探测

// 读取以下文件获取项目全局信息：
// - package.json（根目录）→ 项目名、依赖、脚本
// - README.md → 项目简介
// - 顶层目录结构（ls -la）→ 识别模块组织方式

识别模块组织模式（适用于各类软件开发项目）：

**前端 / 全栈**

| 模式 | 特征目录 / 文件 | 典型框架 |
| :--- | :--- | :--- |
| Monorepo | `packages/`、`apps/`、`pnpm-workspace.yaml`、`turbo.json` | pnpm workspace, Turborepo, Lerna |
| 微前端 | `micro-applications/`、`microapps/`、`shell/` | qiankun, Module Federation |
| 单仓多模块 | `src/modules/`、`src/features/` | 标准 SPA |
| 单体前端 | 仅 `src/` + `package.json` | React / Vue / Angular |

**后端 / 服务端**

| 模式 | 特征目录 / 文件 | 典型框架 |
| :--- | :--- | :--- |
| 微服务 | `services/`、`apps/`，各子目录独立 `Dockerfile` | Spring Boot, Go, Node.js |
| 分层单体 | `controller/`、`service/`、`repository/`（或 `handler/`、`usecase/`、`repo/`） | Spring MVC, Django, Rails, Gin |
| 模块化单体 | `internal/`、`pkg/`、`cmd/`（Go 惯用）| Go standard layout |
| Python 包 | `src/{包名}/`、`pyproject.toml`、`setup.py` | FastAPI, Django, Flask |
| Java/Kotlin | `src/main/java/`，多 `module` 的 `pom.xml` / `build.gradle` | Maven / Gradle multi-module |

**移动端**

| 模式 | 特征目录 / 文件 | 典型框架 |
| :--- | :--- | :--- |
| iOS | `*.xcodeproj`、`*.xcworkspace`、`Podfile` | UIKit / SwiftUI |
| Android | `app/`、`build.gradle`、`AndroidManifest.xml` | Jetpack / KMP |
| 跨平台 | `lib/`、`pubspec.yaml` / `android/` + `ios/` | Flutter / React Native |

**其他**

| 模式 | 特征目录 / 文件 | 典型框架 |
| :--- | :--- | :--- |
| CLI 工具 | `cmd/`、`bin/`、`cli/` | Cobra, Click, Commander.js |
| 数据 / AI | `notebooks/`、`src/`、`requirements.txt` / `pyproject.toml` | PyTorch, TensorFlow, Scikit-learn |
| 基础设施即代码 | `terraform/`、`k8s/`、`helm/`、`.github/workflows/` | Terraform, Helm, GitHub Actions |

### 第二步：逐模块扫描

// 对识别到的每个模块，依次执行以下读取操作：
//
// 【通用】
// 1. 模块根目录结构（深度 2 层）→ 目录职责
// 2. README.md（若存在）→ 模块说明
//
// 【依赖描述文件，按优先级读取存在的那个】
//   package.json（Node.js/前端）
//   pyproject.toml / requirements.txt / setup.py（Python）
//   pom.xml / build.gradle（Java/Kotlin）
//   go.mod（Go）
//   Cargo.toml（Rust）
//   Podfile / Package.swift（iOS）
//   pubspec.yaml（Flutter）
//
// 【入口文件，按语言读取存在的那个】
//   index.tsx / main.ts / App.tsx（前端）
//   main.go / cmd/*/main.go（Go）
//   main.py / app.py / manage.py（Python）
//   Application.java / *Application.kt（Spring Boot）
//   lib/main.dart（Flutter）
//
// 【路由 / 接口入口（若存在）】
//   router/ routes/ → 页面 / 路由列表（前端）
//   controller/ handler/ → API 接口列表（后端）
//   api/ services/ → 接口封装（前端）或 proto 定义（gRPC）
//
// 【类型 / 模型定义（若存在）】
//   types/ *.d.ts → 前端类型
//   model/ entity/ domain/ → 后端数据模型
//   schema/ → 数据库 schema 或 GraphQL schema

### 第三步：生成参考文档

为每个模块生成 `.agent/references/{分类}/{模块名}.md`，格式如下：

```markdown
# {模块名} 架构参考

> **项目路径**: `{相对路径}`
> **模块类型**: {微应用 / 功能模块 / 共享包 / 其他}
> **核心功能**: {一句话描述}
> **文档生成时间**: {YYYY-MM-DD}
> **对应 git commit**: {short hash}

---

## 🎯 模块概述

{AI 根据扫描结果总结，2-3 句话}

## 🛠️ 技术栈

### 核心框架
- {框架名 + 版本}

### 关键依赖
- {依赖名}: {用途}

### 构建 / 开发工具
- {工具名}: {用途}

## 🏗️ 核心架构

### 目录结构
{读取到的目录树，精简至关键路径}

### 状态管理
{Redux / Zustand / Hooks / 无 等}

### 路由结构
{主要页面路由列表}

## 📦 开发命令速查

{从 package.json scripts 提取}

## 📌 关键文件路径

{入口文件、核心配置文件的路径}

## 🛡️ 关键约束与注意事项

{依赖版本限制、特殊配置、跨模块约定等}
```

### 第四步：生成索引文件

创建 `.agent/references/README.md` 作为全局模块索引：

```markdown
# 项目模块索引

> 由 /scan-project 自动生成，最后更新：{日期}

## 模块列表

| 模块 | 类型 | 核心功能 | 文档 |
| :--- | :--- | :--- | :--- |
| {模块名} | {类型} | {功能} | [{模块名}.md](./{路径}) |

## 全局技术栈

{从所有模块汇总的共同依赖}
```

---

## 完成后的提示

扫描完成后，告知用户：
1. 生成了哪些文档（列表）
2. 如何在任务中引用这些文档（AI 自动读取 `.agent/references/`）
3. 提示运行 `/configure` 补充全局架构原则
4. 提示后续用 `/update-refs` 保持文档同步
