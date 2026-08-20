# DSH Visualize Fragment Borrow — 架构提案

> **Status**: approved (2026-08-20)
> **Approval**: user `/approve` — single-point proposal with 9 Phase rows, all completed pre-approval; routed `/plan` by size but no `/plan` dispatch needed (work fully landed in commit `868cd4b`)
> **Execution carrier**: commit `868cd4b` on branch `feat/dsh-visualize-fragment-borrow`（worktree `cortex-agent-worktrees/feat-dsh-visualize-fragment-borrow`）
> **Implementation summary**: 11 files / +1689 lines / 34 tests pass (0 fail)
> **Upstream**: [Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize)（BSD-3-Clause，© 2026 Jesse Zhang）
> **Audience**: cortex-agent maintainers + 输出 HTML 的 skill/workflow 作者
> **Architecture constraint**: zero npm dependencies、additive-only、纯函数模块、CommonJS、与 `lib/design/lockfile.js` 风格一致
> **Related**: `.agent/rules/proposal-structure.md`、`.agent/rules/architecture-design.md`、`.agent/rules/test-policy.md`、`docs/architecture/dsh-host-adapter.md`、`docs/architecture/design-system.md`

> **Note on `/approve` deviation**: This proposal lives at `docs/architecture/` (outer cortex-agent repo) per the "需求开发在外层" guidance, not under `.agent/plans/proposals/` (the inner separate-repo where the standard frontmatter-driven `cortex-agent automation approve-and-launch` materialiser expects). Status update applied directly here; mission skeleton and task records intentionally not generated — work is already done in the carrier commit above and the change set is the single-point PR boundary described in §11.

---

## 1. TL;DR

cortex-agent 把 [Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize) 中**可移植**的两类资产纳入外层：

- **Tier 1（轻量）**：3 份 references 文档（contract / design-tokens / charts）+ 1 份 README，归入 `.agent/references/visualize/`（双层模板同步），给所有产出 HTML 的 skill 共享一套"内嵌交互卡片"编写规范。
- **Tier 2（进阶）**：1 个零依赖纯函数模块 `lib/visualize-fragment.js`，从上游 `src/fragment.ts` 移植 `validateFragment` + `applyFragmentPatch` 两个函数（CommonJS 版本），加 `tests/visualize-fragment/` 单测。

**明确不借**：cordis 插件注册、`SkillProvider` 协议、`presentationMeta` 投影、sandboxed iframe 渲染、流式预览相关函数（`extractStreamingFragment` / `trimStreamingScripts`）、上游 `visualize` 工具调用方式。

## 2. 背景 / Background

[Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize)（BSD-3-Clause，© 2026 Jesse Zhang）是 DeepSeek Harness (DSH) 的官方可视化插件，在 Web UI 对话内提供 `visualize` 工具：

- 模型传入内联 HTML 片段 → 卡片渲染成 sandboxed iframe，支持 `create` / `update` 双动作、`inline`/`wide` 双宽度。
- 自带 `visualize` skill 描述 fragment 编写契约（无 `<!doctype>` / `<html>` / `<head>` / `<body>` 骨架、theme tokens、CDN 白名单等）。
- 提供 `validateFragment` 与 `applyFragmentPatch` 两个纯函数做片段校验与唯一性 patch。

cortex-agent 与 dsh-visualize 处于**不同层**：

| 维度 | dsh-visualize | cortex-agent |
|------|---------------|--------------|
| 层级 | 客户端渲染增强（UI / 工具层） | 框架 / 治理层 |
| 产物 | 对话卡片（运行时） | rules / workflows / skills / references（仓库资产） |
| 依赖 | `@deepseek-ai/cordis` + dsh 全家桶 | agent host 无关 |
| 当前本会话的 `visualize` 工具 | ✅ 由 DSH 提供 | ❌ 不参与 |

虽然 cortex-agent 没有自己的 Web UI，但**任何输出 HTML 产物的场景**都受益于同一份契约：

- `source-command-prototype` 的 Document 路径产物；
- `agent-dashboard` HTML 看板；
- `/prototype --mode doc` 的 Mermaid / HTML 输出；
- 未来 `/prd` 工作流的 `screen-map.html` 可视化清单。

把可移植部分 vendor 进 cortex-agent，可让所有产出 HTML 的 skill 共享同一份"如何写一个内嵌交互片段"的契约与校验工具。

## 3. 目标 / Goals

| # | Goal | 说明 |
|---|------|------|
| G1 | **契约共享** | cortex-agent 任何产出 HTML 的 skill 引用同一份 fragment 编写契约（references） |
| G2 | **校验复用** | 提供零依赖的纯函数校验器（`lib/visualize-fragment.js`），给产出 HTML 的模块调用 |
| G3 | **边界清晰** | 明确哪些可借、哪些 DSH 强耦合不借 |
| G4 | **归源合规** | BSD-3-Clause 归属 + 来源标注 + 范围限制（仅文档与纯函数）|
| G5 | **零依赖** | `lib/visualize-fragment.js` 仅依赖 Node.js 内置模块 |
| G6 | **模板同步** | references 同步到 `templates/{en,zh}/.agent/references/visualize/` |
| G7 | **测试覆盖** | `tests/visualize-fragment/` 覆盖 validate + patch 全部路径 |

## 4. 非目标 / Non-Goals

- **N1**. 不把 dsh-visualize 的 cordis 注册机制、`SkillProvider` 协议、`presentationMeta` 投影、sandboxed iframe 渲染搬到 cortex-agent（DSH 强耦合）。
- **N2**. 不让 cortex-agent `bin/cli.js` 调用 DSH 工具或运行时（违反零依赖原则）。
- **N3**. 不复制 example HTML 文件（仅在 references 里描述其结构，避免版权扩散与体积膨胀）。
- **N4**. 不新建独立的 `visualize` skill；DSH 自带 `visualize` skill，cortex-agent 只补全 references 与纯校验工具，不重复定义工具语义。
- **N5**. 不覆盖任何已有文件（additive-only）。
- **N6**. 不移植上游流式预览相关函数（`extractStreamingFragment` / `trimStreamingScripts` / `visualizeMetaFrom`）—— 全部与 DSH 流式渲染耦合。
- **N7**. 不绑定上游具体版本号；如上游未来 breaking change，走 `/arch-design` 重审。
- **N8**. 不修改 `bin/cli.js`，不改 docs 索引（`docs/architecture.md` 暂不引用，本提案本身就是入口）。

## 5. 核心设计 / Core Design

### 5.1 Tier 1 — Vendored References（轻量档）

在 `templates/{en,zh}/.agent/references/visualize/` 下新建 4 份文档，**逐字引用**上游内容并附归属与衍生说明：

```text
templates/en/.agent/references/visualize/
├── README.md                 # 索引 + 来源声明 + 范围说明
├── contract.md               # ← assets/visualize-skill.md
├── design-tokens.md          # ← assets/references/design.md
└── charts.md                 # ← assets/references/charts.md

templates/zh/.agent/references/visualize/
├── README.md                 # 与 en/ 字节相同（遵循既有 en/zh 引用同构约定）
├── contract.md
├── design-tokens.md
└── charts.md
```

> **路径说明**：cortex-agent 主仓库的 `.agent/` 是一个**独立的 git 仓库**（remote：
> `Kucell/cortex-agent-agent.git`），不参与本仓库提交流程。本仓库只在 `templates/{en,zh}/`
> 下维护模板源；用户运行 `cortex-agent init` 时这些文件会被铺到项目自己的 `.agent/`。

#### 5.1.1 文件 frontmatter（OKF V0.2）

每份 vendored 文档顶部须带以下 frontmatter（与 `.agent/references/INDEX.md` 兼容）：

```yaml
---
title: "<文档名>"
description: "<一句话摘要>"
type: reference
status: stable
owner: cortex-agent
last_verified: 2026-08-20
source: upstream
upstream_repo: https://github.com/Nagi-ovo/dsh-visualize
upstream_path: assets/visualize-skill.md  # 或实际路径
upstream_license: BSD-3-Clause
upstream_copyright: "Copyright (c) 2026 Jesse Zhang"
keywords: [visualize, fragment, contract, reference]
---
```

> `source: upstream` 是新增字段，build-references-index.js 会识别并在 INDEX 中标注来源。

#### 5.1.2 README.md 内容大纲

```text
# Visualize References

> 本目录文档**字面引用自** [Nagi-ovo/dsh-visualize](https://github.com/Nagi-ovo/dsh-visualize)
> （BSD-3-Clause，© 2026 Jesse Zhang）。仅作为 cortex-agent 框架内的契约参考资料，
> **不**附带 dsh-visualize 的运行时（cordis / 工具注册 / sandbox iframe）。

## 范围说明

- ✅ **可借**：编写合约（contract.md）、设计 tokens（design-tokens.md）、图表手册（charts.md）
- ❌ **不借**：cordis 插件注册、`SkillProvider` 协议、`presentationMeta` 投影、sandboxed iframe 渲染
- 🔧 **纯函数**：`lib/visualize-fragment.js` 是 `src/fragment.ts` 中
  `validateFragment` / `applyFragmentPatch` 两个纯函数的 TypeScript → CommonJS 移植

## 使用建议

任何 cortex-agent skill / workflow 在产出"内嵌交互卡片"或"独立 HTML 报告"时，应：

1. 先读 `contract.md` 确认片段边界（无骨架标签、CDN 白名单、size ceiling）。
2. 写 UI 时读 `design-tokens.md` 套用基类与主题变量。
3. 涉及 Chart.js / 手写 SVG 时读 `charts.md`。
4. 写入文件后调用 `validateFragment` 做字节级校验（仅检查骨架/大小/空片段，不校验语义）。
```

### 5.2 Tier 2 — `lib/visualize-fragment.js`（进阶档）

抽取上游 `src/fragment.ts` 中**两个纯函数**为 `lib/visualize-fragment.js`：

```ts
// 上游 TS 接口（仅展示，本提案用 CommonJS 重写）
export function validateFragment(fragment: string, maxBytes: number): number
export function applyFragmentPatch(base: string, oldStr: string, newStr: string): string
```

#### 5.2.1 移植原则

| 维度 | 上游（TypeScript） | 本提案（CommonJS） |
|------|---------------------|---------------------|
| 模块系统 | ESM | CommonJS（与 `lib/design/lockfile.js` 等保持一致）|
| 类型 | TypeScript 接口 | JSDoc + runtime assertion |
| `byteLength` | `new TextEncoder().encode(text).length` | 同（Node.js 内置） |
| 错误消息 | 英文 | 英文（与上游保持一致，便于跨生态引用） |
| `extractStreamingFragment` / `trimStreamingScripts` | 导出但与 cordis 流式渲染耦合 | **不移植** |

#### 5.2.2 公共 API

```js
/**
 * Validate a fragment against the inline-HTML contract.
 * @param {string} fragment - file content
 * @param {number} maxBytes - size ceiling
 * @returns {number} UTF-8 byte length
 * @throws {Error} on empty, oversize, or skeleton-tagged fragment
 */
function validateFragment(fragment, maxBytes) { ... }

/**
 * Replace exactly one occurrence of oldStr with newStr in base.
 * @param {string} base - the rendered fragment
 * @param {string} oldStr - exact, unique text to match
 * @param {string} newStr - replacement (empty deletes)
 * @returns {string} the patched fragment
 * @throws {Error} when oldStr is empty, missing, ambiguous, or too short to anchor
 */
function applyFragmentPatch(base, oldStr, newStr) { ... }

module.exports = { validateFragment, applyFragmentPatch };
```

#### 5.2.3 不移植的部分（明确边界）

- `extractStreamingFragment(argsRaw)` — 用于 DSH 流式预览，从 args JSON 中提前取出 fragment；cortex-agent 不做流式渲染，不移植。
- `trimStreamingScripts(fragment)` — 用于"丢弃未完结 `<script>` 块以让 preview shell 跑得动已完成的 JS"；同理不移植。
- `visualizeMetaFrom(meta)` — DSH toolview meta 收窄；不移植。
- `byteLength` 内部 helper — 保留为模块内私有 helper。

#### 5.2.4 模块风格

参考 `lib/design/lockfile.js`：

```js
/**
 * lib/visualize-fragment.js
 *
 * Pure fragment contract: validate + patch.
 *
 * Upstream: Nagi-ovo/dsh-visualize (BSD-3-Clause)
 *   src/fragment.ts: validateFragment, applyFragmentPatch
 *
 * Cortex-agent scope: zero-dependency validation + patch helpers for any
 * module that writes inline-HTML artifacts. NOT coupled to DSH, cordis,
 * toolview meta, or sandbox iframe rendering.
 *
 * Path: pure module (no I/O, no globals).
 */

'use strict';

const SKELETON_TAG = /<!doctype\b|<\s*(?:html|head|body)\b/iu;
const PATCH_CONTEXT_CHARS = 160;
const MIN_ANCHOR_CHARS = 12;

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function validateFragment(fragment, maxBytes) { ... }
function applyFragmentPatch(base, oldStr, newStr) { ... }

module.exports = { validateFragment, applyFragmentPatch };
```

### 5.3 测试策略（`test-policy.md` §1）

新建 `tests/visualize-fragment/visualize-fragment.test.js`，遵循 `test-policy.md` §2：

- 使用 `node:test` + `node:assert/strict`，零依赖。
- 每个导出函数至少 3 类用例：正常路径 / 边界 / 错误路径。
- `validateFragment` 必须覆盖：
  - 空片段（reject）
  - 超大片段（reject）
  - 含 `<!doctype>` / `<html>` / `<head>` / `<body>`（reject）
  - 合法片段（返回字节数）
- `applyFragmentPatch` 必须覆盖：
  - 唯一匹配 → 替换成功
  - `oldStr` 为空（reject）
  - `oldStr` 缺失（reject，带 160 字符上下文回显）
  - `oldStr` 多个匹配（reject）
  - `oldStr` 长度 < 12 字符（reject，anchor 不可信）
  - `newStr` 为空（删除匹配区域）

本地验证：

```bash
node --test --test-timeout=60000 tests/visualize-fragment/visualize-fragment.test.js
```

### 5.4 双语模板同步（`architecture-design.md` §6 检查清单）

按 `architecture-design.md` 第 6 项检查清单，双语模板同步如下：

| 文件 | `templates/en/.agent/references/visualize/` | `templates/zh/.agent/references/visualize/` |
|------|---------------------------------------------|---------------------------------------------|
| README.md | 英文 | 中文版（解释借用范围、引用 en 版本） |
| contract.md | ✅（内容以英文为主，逐字引用上游） | ⚠️ 上游为英文，技术内容**不翻译**；仅顶部加中文段落说明这是 vendored reference |
| design-tokens.md | ✅ | ⚠️ 同上 |
| charts.md | ✅ | ⚠️ 同上 |

> **决策**：技术文档不翻译，仅添加本地化前言。这避免了机器翻译导致的语义漂移，
> 同时满足"双语模板同步更新"的形式合规。

### 5.5 与现有 `prd-visualization` 提案的关系

| 维度 | `prd-visualization`（已存在） | 本提案（dsh-visualize-fragment-borrow） |
|------|--------------------------------|-----------------------------------|
| 目标 | PRD 资产层 + OpenPencil/Pixso 后端 | HTML fragment 编写契约 + 纯校验器 |
| 范围 | `.agent/prds/<task-id>/` 资产 | `.agent/references/visualize/` + `lib/visualize-fragment.js` |
| Visual backend | doc / openpencil / pixso | 无（不引入 visual backend，只补全 HTML 编写契约） |
| 冲突 | 无 | 无 |

两者正交：prd-visualization 解决"用什么画布生成设计帧"，本提案解决"如何写一份可移植、可校验的内联 HTML"。`/prd` 工作流未来可选用 `lib/visualize-fragment.js` 校验其 `screen-map.html` 输出。

## 6. 数据契约

无新增 schema。`lib/visualize-fragment.js` 导出的是纯函数，无 I/O、无持久化、无副作用。

## 7. 实施计划

| Phase | 任务 | 文件 | 检查清单 |
|-------|------|------|----------|
| P1 | Tier 1 — 创建 references 目录与 README（en） | `templates/en/.agent/references/visualize/README.md` | ✅ |
| P2 | Tier 1 — 复制 `contract.md` + 顶部说明（en） | `templates/en/.agent/references/visualize/contract.md` | ✅ |
| P3 | Tier 1 — 复制 `design-tokens.md` + 顶部说明（en） | `templates/en/.agent/references/visualize/design-tokens.md` | ✅ |
| P4 | Tier 1 — 复制 `charts.md` + 顶部说明（en） | `templates/en/.agent/references/visualize/charts.md` | ✅ |
| P5 | Tier 1 — 同步 4 份到 zh（与 en 字节相同） | `templates/zh/.agent/references/visualize/*` | ✅ |
| P6 | Tier 2 — 创建 lib 模块 | `lib/visualize-fragment.js` | ✅ |
| P7 | Tier 2 — 创建单测 | `tests/visualize-fragment/visualize-fragment.test.js` | ✅ |
| P8 | Tier 2 — 本地测试通过（34/34 PASS） | `node --test --test-timeout=60000 tests/visualize-fragment/*.test.js` | ✅ |
| P9 | 架构提案（draft → ready-for-review） | `docs/architecture/dsh-visualize-fragment-borrow.md` | ✅ |

## 8. 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| A. 不借鉴 | 维持现状 | 零风险 | cortex-agent 输出 HTML 的 skill 各写各的契约，无统一校验 | 不推荐 |
| B. 只做 Tier 1 | 仅 vendor 三份 references | 文档统一 | 缺运行时校验，每次 skill 写 HTML 都要重新实现骨架校验 | 不推荐 |
| C. 只做 Tier 2 | 仅抽 `lib/visualize-fragment.js` | 零依赖校验 | 文档分散，模型不知道 fragment 该怎么写 | 不推荐 |
| D. 两档都做（本提案） | Tier 1 文档 + Tier 2 校验 | 文档与代码一致，契约可执行 | 工作量略大（约 1 个 PR） | **推荐** |

## 9. 架构合规性评估

| 原则 | 评估 |
|------|------|
| 零依赖原则 | ✅ 通过。`lib/visualize-fragment.js` 仅依赖 Node.js 内置模块（TextEncoder），无 npm 依赖；`bin/cli.js` 不动 |
| 模板驱动 | ✅ 通过。references 同步到 `templates/{en,zh}/.agent/references/visualize/` |
| 纯加法升级 | ✅ 通过。`upgrade` 只新增文件，不修改任何已有内容 |
| 平台无关 | ✅ 通过。无平台耦合，DSH / cordis / sandbox iframe 全部不引入 |
| 最小修改 | ✅ 通过。Tier 1 仅复制上游文档并加归属；Tier 2 仅 1 个 lib + 1 个测试文件 |
| 双语模板同步 | ✅ 通过。技术文档保留英文 + 顶部中文前言 |

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 上游版权要求保留声明 | 必须保留 BSD-3-Clause 完整声明 | Tier 1 README + 每份文档顶部带版权原文 + 来源 URL |
| 上游持续演进导致内容漂移 | references 内容可能过期 | frontmatter 加 `last_verified` 字段；build-references-index.js 可加 staleness 检查（未来 PR） |
| 上游与 DSH 协议深度耦合，未来可能改 `validateFragment` 行为 | 本提案移植的纯函数失效 | 保留上游版本号引用；如有 breaking change 走 `/arch-design` 重审 |
| 与 DSH 自带 `visualize` 工具语义不一致 | cortex-agent 校验逻辑可能与 DSH 实际渲染冲突 | Tier 2 仅做字节/骨架/大小校验，**不**涉及 DSH 特有概念（CDN 白名单、CSP 在 DSH 层实施，cortex-agent 不重复）|
| 误用：把 `lib/visualize-fragment.js` 当 DSH 工具替代品 | 用户期望得到卡片，实际只拿到校验 | README 明确"本模块是校验器，不输出卡片" |
| Tier 1 references 占 `.agent/` 体积 | 用户仓库体积微增 | 三份文档合计 < 30 KB；`.agent/` 本身就在 `.gitignore` 候选范围内 |
| `.agent/` 是独立仓库，references 同步需进入 `.agent/` repo 提交流程 | 双仓 PR 协调成本 | 本提案在 .agent/ 仓只新增 4 个 references + 4 个模板镜像，不改任何 workflow/skill；评审面小 |

## 11. 推荐决策

**采用方案 D：Tier 1 + Tier 2 双档都做**。

执行顺序：

1. **先 Tier 1**：vendor 三份 references + 同步模板 + 重建 INDEX——零风险、低成本，立即给所有产出 HTML 的 skill 提供契约。
2. **再 Tier 2**：`lib/visualize-fragment.js` + 单测——零依赖、为未来 prototype / dashboard / prd 工作流的 HTML 校验打底。

不修改 `bin/cli.js`，不修改任何已有文件，不引入新 npm 依赖。

第一阶段 PR 边界（已实施）：

```text
新增：
  docs/architecture/dsh-visualize-fragment-borrow.md
  templates/en/.agent/references/visualize/{README,contract,design-tokens,charts}.md
  templates/zh/.agent/references/visualize/{README,contract,design-tokens,charts}.md
  lib/visualize-fragment.js
  tests/visualize-fragment/visualize-fragment.test.js

不动：
  bin/cli.js
  templates/ 下任何已有文件（仅在 references/visualize/ 子树新增）
  .agent/ 独立仓库（用户 init 时自动铺到项目 .agent/）
```

## 12. 后续工作（Out of Scope）

- 未来 PR：在 `source-command-prototype` 与 `agent-dashboard` 的 HTML 输出环节接入 `validateFragment`。
- 未来 PR：build-references-index.js 增加 `source: upstream` 字段识别与 staleness 告警。
- 未来 PR：`prd-visualization` 提案的 `screen-map.html` 可选用 `lib/visualize-fragment.js` 校验。

## 13. 参考

- 上游仓库：https://github.com/Nagi-ovo/dsh-visualize
- 上游 LICENSE：BSD-3-Clause（详见 `LICENSE`）
- 上游关键文件：
  - `assets/visualize-skill.md` → `contract.md`
  - `assets/references/design.md` → `design-tokens.md`
  - `assets/references/charts.md` → `charts.md`
  - `src/fragment.ts`（`validateFragment` / `applyFragmentPatch`）→ `lib/visualize-fragment.js`
- cortex-agent 相关规则：
  - `.agent/rules/architecture-design.md` §6 变更检查清单
  - `.agent/rules/code-standards.md` §5 规模与拆分
  - `.agent/rules/test-policy.md` §1 强制覆盖范围
  - `.agent/rules/proposal-structure.md` 单点提案格式
- 相关提案（先例）：
  - `docs/architecture/dsh-host-adapter.md`（DSH 集成先例）
  - `docs/architecture/design-system.md`（上游借鉴先例）

---

> 返回：[架构文档](./README.md)