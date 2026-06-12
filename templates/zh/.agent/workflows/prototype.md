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

> **--mode both 失败处理**：DOC_PROTOTYPE 失败时记录错误并继续执行 UI_PROTOTYPE；最终在 DONE 阶段汇报失败路径。

### --fidelity 保真度说明

| fidelity | 产物 |
|----------|------|
| low      | flow.md（Mermaid 图，仅文字可读） |
| mid      | flow.md + 基础原型（Anime.js HTML 简化节点 / Pixso 核心帧，覆盖 Happy Path） |
| high     | flow.md + 完整原型（Anime.js HTML 全交互时间轴 / Pixso 全状态帧，覆盖所有分支） |

默认：`--fidelity low`（快速产出，仅 flow.md）

## Phase 3a: DOC_PROTOTYPE

### Step 1：Mermaid 交互流程图

生成 `.agent/prototypes/<task-id>/flow.md`，包含：
- 用户操作序列图（sequenceDiagram）
- 页面/状态流转图（stateDiagram-v2）

### Step 2：Anime.js HTML 原型

生成 `.agent/prototypes/<task-id>/prototype.html`：
- 基于 `docs/assets/coordinator-dispatch.html` 的结构和风格
- 将需求中的步骤映射为 Anime.js timeline 节点
- 深色终端风格，Play / Reset 控件
- 通过 CDN 加载 animejs（https://unpkg.com/animejs@latest/lib/anime.min.js），无构建步骤

节点结构（每个需求步骤对应一个 .node）：

```html
<div class="node" id="step-N">
  <div class="label">Step N</div>
  <div class="name">[动作]</div>
  <div class="status">[状态]</div>
</div>
```

跳过条件：`--fidelity low` 时不生成此文件。

## Phase 3b: UI_PROTOTYPE

### Step 1：调用 Pixso MCP

调用 pixso MCP 工具，传入需求描述和用户流程，生成设计帧。

记录输出到 `.agent/prototypes/<task-id>/pixso-frames.json`：

```json
{
  "file_id": "<pixso-file-id>",
  "frames": [
    { "name": "Step N - [页面名]", "url": "<pixso-frame-url>" }
  ],
  "export_hint": "在 Pixso 中选中所有帧 → 导出为 PNG/SVG → 放入 docs/assets/prototypes/<task-id>/"
}
```

跳过条件：`--fidelity low` 时不调用 Pixso MCP，不生成此文件。

## Phase 4: CONTRACT

调用 `.agent/skills/validation-contract/` skill（CREATE 模式），根据原型产物生成验收契约。

contract 中必须包含的 assertion 类型：
- `type: "manual"` — 原型与需求描述是否对齐（人工确认）
- `type: "docs"`   — flow.md Mermaid 图是否覆盖所有用户流程
- `type: "runtime"`（UI 路径）— Pixso 帧链接是否可访问

> **注意（--fidelity low）**：UI 路径的 `runtime` 断言仅在 `pixso-frames.json` 存在时生成；`--fidelity low` 时该断言自动跳过。

输出到 `.agent/prototypes/<task-id>/validation-contract.json`。

## Phase 5: DONE

输出摘要：

```
🎨 /prototype 完成：<task-id>

  📐 模式：<doc|ui|both>
  📄 流程图：.agent/prototypes/<task-id>/flow.md
  🌐 HTML 原型：.agent/prototypes/<task-id>/prototype.html（doc 路径，low fidelity 时跳过）
  🖼  Pixso 帧：.agent/prototypes/<task-id>/pixso-frames.json（ui 路径，low fidelity 时跳过）
  ✅ 验收契约：.agent/prototypes/<task-id>/validation-contract.json

  推荐下一步：/arch-design（如需架构设计）| /ship <task-id>（如直接实现）
```

## 产物目录结构

```
.agent/prototypes/<task-id>/
├── flow.md                    # Mermaid 交互流程图（必有）
├── prototype.html             # Anime.js HTML 原型（doc 路径，--fidelity mid|high）
├── pixso-frames.json          # Pixso 帧链接（ui 路径，--fidelity mid|high）
└── validation-contract.json   # 验收契约（必有）
```
