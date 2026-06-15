# /prototype Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Cortex Agent 框架新增 `/prototype` 工作流，支持从需求文字生成文档型原型（Mermaid + Anime.js HTML）和 UI 型原型（Pixso MCP），两条路径均输出可执行的 validation-contract。

**Architecture:** `/prototype` 是一个新的斜杠命令工作流，通过 `--mode doc|ui|both` 控制分支路径。Document 路径使用现有的 Mermaid + Anime.js 能力产出可浏览 HTML；UI 路径通过 Pixso MCP 调用生成设计帧并记录帧链接。两条路径最终汇合到 `validation-contract` skill 产出验收契约，再交接给 `/arch-design` 或直接进入 `/ship`。

**Tech Stack:** Markdown workflow、Mermaid、Anime.js（CDN，无构建）、Pixso MCP（`pixso` MCP server）、现有 `validation-contract` skill

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `docs/architecture/prototype-workflow-design.md` | 新建 | 架构设计：双路径、边界、与现有工作流的关系 |
| `.agent/workflows/prototype.md` | 新建 | 本地工作流（cortex-agent 自用） |
| `templates/zh/.agent/workflows/prototype.md` | 新建 | 中文模板，分发给用户 |
| `templates/en/.agent/workflows/prototype.md` | 新建 | 英文模板，分发给用户 |
| `docs/architecture.md` | 修改 | 在工作流章节加入 `/prototype` 说明 |
| `README.md` | 修改 | 文档索引表加入 prototype-workflow-design.md |
| `cspell.json` | 修改 | 加入 `pixso`、`Pixso` |

---

## Task 1：架构设计文档

**Files:**
- Create: `docs/architecture/prototype-workflow-design.md`

- [x] **Step 1：写架构设计文档**

内容结构：
1. 背景与问题（当前框架缺失需求→原型阶段）
2. 双路径设计（Document + UI）及路由逻辑
3. Document 路径详细设计（Mermaid → Anime.js HTML 模板 → validation-contract）
4. UI 路径详细设计（Pixso MCP 调用约定 → 帧链接记录 → validation-contract）
5. 输入/输出契约（`/prototype` 的入参与产物规范）
6. 与现有工作流的关系图（`/prototype` → `/arch-design` → `/ship`）
7. 任务拆解表（T-P01~T-P05）

文件放在 `docs/architecture/prototype-workflow-design.md`，格式与同目录其他设计文档一致（`# Title`，状态头，Mermaid 流程图）。

- [x] **Step 2：commit**

```bash
git add docs/architecture/prototype-workflow-design.md
git commit -m "docs(architecture): add prototype workflow design (dual-path doc+ui)"
```

---

## Task 2：核心工作流 — Document 路径

**Files:**
- Create: `.agent/workflows/prototype.md`（本地，不 git 追踪）

Document 路径产物结构：
```
.agent/prototypes/<task-id>/
├── flow.md              # Mermaid 交互流程图
├── prototype.html       # Anime.js 可点击 HTML 原型
└── validation-contract.json
```

- [x] **Step 1：写本地工作流文件**

创建 `.agent/workflows/prototype.md`，包含：

```markdown
---
name: prototype
description: 从需求描述生成文档型原型（Mermaid + Anime.js）或 UI 型原型（Pixso MCP），输出 validation-contract。
---

# 原型设计工作流 (/prototype)

## 使用方式

/prototype <task-id> [--mode doc|ui|both] [--fidelity low|mid|high]

默认：--mode both，--fidelity low

## 状态机

REQUIREMENTS → ROUTE → [DOC_PROTOTYPE | UI_PROTOTYPE | BOTH] → CONTRACT → DONE

## Phase 1: REQUIREMENTS

读取任务描述，提取：
- 核心用户流程（Happy Path）
- 关键实体和交互节点
- 项目类型（UI-heavy / API / mixed）

## Phase 2: ROUTE

根据 --mode 和项目类型路由：
| mode | 执行路径 |
|------|---------|
| doc  | → DOC_PROTOTYPE |
| ui   | → UI_PROTOTYPE |
| both | → DOC_PROTOTYPE → UI_PROTOTYPE 串行 |

## Phase 3a: DOC_PROTOTYPE

### Step 1：Mermaid 交互流程图
生成 .agent/prototypes/<task-id>/flow.md，包含：
- 用户操作序列图（sequenceDiagram）
- 页面/状态流转图（stateDiagram-v2）

### Step 2：Anime.js HTML 原型
生成 .agent/prototypes/<task-id>/prototype.html：
- 基于 coordinator-dispatch.html 的结构和风格
- 将需求中的步骤映射为 Anime.js timeline 节点
- 深色终端风格，Play / Reset 控件
- 通过 CDN 加载 animejs，无构建步骤

模板节点结构（每个需求步骤对应一个 .node）：
<div class="node" id="step-N">
  <div class="label">Step N</div>
  <div class="name">[动作]</div>
  <div class="status">[状态]</div>
</div>

## Phase 3b: UI_PROTOTYPE

### Step 1：调用 Pixso MCP
调用 pixso MCP 工具，传入需求描述和用户流程，生成设计帧。

记录输出到 .agent/prototypes/<task-id>/pixso-frames.json：
{
  "file_id": "<pixso-file-id>",
  "frames": [
    { "name": "Step N - [页面名]", "url": "<pixso-frame-url>" }
  ]
}

### Step 2：导出资产说明
在 pixso-frames.json 中记录导出路径建议：
{
  "export_hint": "在 Pixso 中选中所有帧 → 导出为 PNG/SVG → 放入 docs/assets/prototypes/<task-id>/"
}

## Phase 4: CONTRACT

调用 validation-contract skill（CREATE 模式），根据原型产物生成验收契约：

contract 中必须包含的 assertion 类型：
- type: "manual" — 原型与需求描述是否对齐（人工确认）
- type: "docs"   — flow.md Mermaid 图是否覆盖所有用户流程
- type: "runtime"（UI 路径）— Pixso 帧链接是否可访问

输出到 .agent/prototypes/<task-id>/validation-contract.json

## Phase 5: DONE

输出摘要：
🎨 /prototype 完成：<task-id>

  📐 模式：<doc|ui|both>
  📄 流程图：.agent/prototypes/<task-id>/flow.md
  🌐 HTML 原型：.agent/prototypes/<task-id>/prototype.html（doc 路径）
  🖼  Pixso 帧：.agent/prototypes/<task-id>/pixso-frames.json（ui 路径）
  ✅ 验收契约：.agent/prototypes/<task-id>/validation-contract.json

  推荐下一步：/arch-design（如需架构设计）| /ship <task-id>（如直接实现）
```

- [x] **Step 2：本地测试可读性**

检查文件存在且格式正确：
```bash
head -5 .agent/workflows/prototype.md
```
预期输出：YAML frontmatter `---` 开头。

---

## Task 3：模板同步 — 中文版

**Files:**
- Create: `templates/zh/.agent/workflows/prototype.md`

- [ ] **Step 1：将 Task 2 的工作流文件复制到中文模板**

内容与 `.agent/workflows/prototype.md` 完全一致（本工作流已是中文，无需翻译）。

```bash
cp .agent/workflows/prototype.md templates/zh/.agent/workflows/prototype.md
```

- [ ] **Step 2：commit**

```bash
git add templates/zh/.agent/workflows/prototype.md
git commit -m "feat(prototype): add /prototype workflow to zh template"
```

---

## Task 4：模板同步 — 英文版

**Files:**
- Create: `templates/en/.agent/workflows/prototype.md`

- [ ] **Step 1：写英文版工作流文件**

基于中文版翻译，关键字段：
- `name: prototype`（保持不变）
- description 改为英文
- 所有中文说明翻译为英文
- 代码注释、字段值保持英文
- 文件路径、命令完全一致

核心翻译对照：
| 中文 | 英文 |
|------|------|
| 原型设计工作流 | Prototype Design Workflow |
| 从需求描述生成... | Generate prototypes from requirements... |
| 调用 Pixso MCP | Invoke Pixso MCP |
| 验收契约 | Validation Contract |
| 推荐下一步 | Recommended next step |

- [ ] **Step 2：commit**

```bash
git add templates/en/.agent/workflows/prototype.md
git commit -m "feat(prototype): add /prototype workflow to en template"
```

---

## Task 5：文档更新与收尾

**Files:**
- Modify: `docs/architecture.md`（工作流章节加 `/prototype`）
- Modify: `README.md`（文档索引加 prototype-workflow-design.md）
- Modify: `cspell.json`（加 `pixso`、`Pixso`）

- [ ] **Step 1：更新 docs/architecture.md**

在"工作流命令"列表中加入：

```markdown
| `/prototype` | 从需求描述生成文档型原型（Mermaid + Anime.js）或 UI 型原型（Pixso MCP），输出 validation-contract |
```

- [ ] **Step 2：更新 README.md 文档索引**

在文档索引表末尾加：

```markdown
| [docs/architecture/prototype-workflow-design.md](../../architecture/prototype-workflow-design.md) | /prototype 双路径设计（Document + Pixso UI），需求→原型→验收契约完整链路 |
```

- [ ] **Step 3：更新 cspell.json**

在 words 数组末尾加入：
```json
"pixso",
"Pixso"
```

- [ ] **Step 4：commit**

```bash
git add docs/architecture.md README.md cspell.json
git commit -m "docs: register /prototype workflow in architecture.md and README"
```

---

## 验收标准（Validation Contract）

| ID | 类型 | 断言 | 阻断 |
|----|------|------|------|
| VC-P01 | docs | `templates/zh/.agent/workflows/prototype.md` 存在，包含 REQUIREMENTS/ROUTE/CONTRACT 四个状态 | ✅ |
| VC-P02 | docs | `templates/en/.agent/workflows/prototype.md` 存在，英文翻译完整 | ✅ |
| VC-P03 | docs | `docs/architecture/prototype-workflow-design.md` 存在，包含双路径设计和任务拆解 | ✅ |
| VC-P04 | docs | `README.md` 文档索引包含 prototype-workflow-design.md | ✅ |
| VC-P05 | manual | Document 路径产物结构（flow.md + prototype.html + contract.json）与 Task 2 设计一致 | ✅ |
| VC-P06 | manual | UI 路径中 Pixso MCP 调用约定（pixso-frames.json 结构）清晰可被 AI 执行 | ✅ |
| VC-P07 | docs | `cspell.json` 包含 `pixso`、`Pixso` | ❌（非阻断） |

---

## 风险说明

| 风险 | 缓解 |
|------|------|
| Pixso MCP API 不稳定或文档不全 | UI 路径仅规范调用约定（输入/输出 JSON 格式），不绑定具体 API 细节；用户可按实际 MCP 工具参数调整 |
| HTML 原型生成质量参差 | 基于 coordinator-dispatch.html 作为固定模板，映射逻辑固定，减少 AI 自由发挥 |
| 工作流太重，轻量需求用不上 | `--fidelity low` 模式只产 flow.md，跳过 HTML 和 MCP 调用 |
