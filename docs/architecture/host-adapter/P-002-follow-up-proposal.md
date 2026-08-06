---
status: draft
title: T-CAB-001 P-002 follow-up - host-adapter 后续工作提案
created_at: 2026-08-06
topic: host-adapter
owner: cortex-agent
predecessor: T-CAB-001 P0/P1 (1ce7a95 + dc8615e → ce8f5b8)
decision_ref: pending
waitpoint_ref: pending
related:
  - .agent/plans/proposals/host-adapter/source-command-agent-truth-bootstrap-proposal.md
  - lib/setup.js
  - lib/commands.js
  - templates/en/.agent/rules/core-principles.md
  - templates/zh/.agent/rules/core-principles.md
---

# T-CAB-001 P-002 follow-up — host-adapter 后续工作提案

> **状态**：draft  
> **作者**：cortex-agent（Mavis coder agent）  
> **创建时间**：2026-08-06  
> **前置**：T-CAB-001 P0/P1 已通过 `ce8f5b8` 合并到 main（`1ce7a95` + `dc8615e`）  
> **决策参考**：D-CAB-001（host-adapter proposal, approved — 由 P0/P1 merge 引用）  
> **本提案范围**：P0/P1 之后下一阶段的候选方向（不直接进入实施，待评审）

---

## 1. Goal

P0/P1 阶段已经完成**最小可行**的真源回归保护——它把 `## Compatibility Adapter Bootstrap` 受管块写进了 `AGENTS.md`，
并通过 `principle 11` 把"先读 `.agent/workflows/<command>.md` 再执行"这条铁律固化进 `core-principles.md`。
这相当于给 host-adapter 装上了**第一道安全锁**：当 `.agents/skills/source-command-*` 适配器指向一个不存在的真源时，
宿主必须**显式报告并停止**，不能再静默回退到适配器副本。

P-002 的目标是把这条铁律**从"AGENTS.md 受管块"扩展成"host × command 维度的运行时合约"**：

1. 把同一套保护从 P-1 适配器铺到 P-2 / P-3 框架（如果存在或即将存在）；
2. 把 Claude Code、Codex、Gemini 三个具体宿主的命令路径与真源路径**显式对齐**，
   让"加载 `.agent/workflows/<command>.md`"不是一个抽象口号，而是一张可对照的表；
3. 引入**可重复的测试矩阵**，对每对 `(host, command)` 验证回退路径在 `update` 前后都符合预期；
4. 把 `doctor` 自检接入 compatibility adapter，让"适配器与真源不一致"成为可机器诊断的状态；
5. 跨 host 工作流同步（`.agent/workflows/` 在所有 host 上是同一份，而不是被某宿主隐式重写）；
6. 拿 SamHMI 真项目做端到端验证（`cortex-agent update` 后 `adapter-vs-truth` 走通、CI 绿、harness 可接手）。

> 本提案**不**实施任何代码；它只把候选方向列清楚、给出验收标准，并提议下一步的 3-4 个 MS 拆解。
> 等评审通过后，再把 P-002 拆成若干独立小提案（每个对应 1 个 MS），分别走 `/arch-design` → `/plan` → `/start-task`。

---

## 2. P0/P1 recap（已完成）

合并进 main（`ce8f5b8`）的 9 个文件 + 1 个受管块 + 1 条核心原则：

### 2.1 代码改动（4 个文件）

| 文件 | 关键导出 / 改动 | 作用 |
| --- | --- | --- |
| `lib/setup.js` | `compatibilityAdapterBootstrapSection` / `mergeCompatibilityAdapterBootstrap` / `needsCompatibilityAdapterBootstrapMerge` / `ensureCompatibilityAdapterBootstrapEntry` | 受管块的生产、合并、检测、落地 |
| `lib/setup.js`（`ensureAgentEntryFile` 内） | 在 init 阶段把受管块写进**新建**的 `AGENTS.md` | 一次性种子 |
| `lib/commands.js` | `init` / `upgrade` 路径调用 `ensureCompatibilityAdapterBootstrapEntry`；`ctx.command === 'update'` 守卫；`fullUpdate` 闸门 | 受管块随 `init` / `update` 一起落地 |
| `lib/commands.js` | `collectSemanticMergeCandidates` 新增 `entry_compatibility_adapter_bootstrap_stale` 原因 | dry-run 报告能告诉用户这块要刷新 |

### 2.2 模板改动（2 个文件）

| 文件 | 关键改动 | 作用 |
| --- | --- | --- |
| `templates/en/.agent/rules/core-principles.md` | 新增 **principle 11**（host-adapter truth-source regression + missing-truth stop policy） | 跨 host 共享的硬约束 |
| `templates/zh/.agent/rules/core-principles.md` | 同 principle 11 中文版 | 跨语言一致性 |

### 2.3 文档改动（2 个文件）

| 文件 | 关键改动 | 作用 |
| --- | --- | --- |
| `docs/platform-integration.md` | 新增 "运行期回归" 段 + 适配器与真源不一致的诊断示例（`[adapter-vs-truth mismatch]` 输出） | 让宿主知道要打印什么、要怎么停 |
| `docs/getting-started.md` | 新增 1 段说明 | 让新项目用户一眼看到这条约束 |

### 2.4 测试改动（3 个文件）

| 文件 | 覆盖场景 |
| --- | --- |
| `tests/setup-semantic-merge.test.js` | 种子写入、merge 入已有 AGENTS.md、marker 替换、幂等、zh/en 共享 marker |
| `tests/update-semantic-merge.test.js` | dry-run 报告带新 reason；`update` 把块注入旧 AGENTS.md；连续两次 `update` 幂等 |
| `tests/upgrade-dry-run.test.js` | `fix(host-adapter): preserve upgrade additive-only boundary`（`dc8615e`）—— 升级保持 additive-only，不破坏现有受管块 |

### 2.5 受管块本身

`## Compatibility Adapter Bootstrap`（含 `<!-- cortex-agent:compatibility-adapter-bootstrap:start/end -->` 标记），
核心三句话：

1. `.agents/skills/source-command-*` 只是**命令发现**用的兼容适配层，**不定义行为**。
2. 宿主用适配器识别出命令 `<command>` 后，**任何任务动作之前必须**加载 `.agent/workflows/<command>.md`。
3. 真源缺失时**必须显式报告并停止**，**不得回退到适配器副本**。

### 2.6 没做的事（明确排除）

- **P2 doctor consistency checker** —— 在 1ce7a95 的 commit message 里被明确 **deferred**。
  这正好是 P-002.4 的起点。
- **跨 host 适配** —— P0/P1 只保证 host **读到**这块；没有覆盖"Codex / Claude Code / Gemini 各自怎么读、路径是什么、谁的 SOI 是什么"。
- **P-2 / P-3 框架适配** —— 受管块只针对 P-1 source-command-* 适配器，没有面向更上层的"AI 框架"。

---

## 3. P-002 候选方向

下列 6 个子方向是评审时的候选清单。本提案**不**承诺全部做；评审通过后挑 3-5 个进入正式拆解。

### 3.1 P-002.1 — P-2 / P-3 适配器扩展

**问题**：当前受管块只针对 P-1 适配器（`.agents/skills/source-command-*`）。如果存在 P-2 / P-3 框架（待确认），
它们对"真源在哪里、什么算 missing"可能有不同约定，而 P-002 受管块并没有覆盖。

**候选动作**：

- 盘点所有现存 P-2 / P-3 适配器（grep `.agents/skills/`、`/skills/`，分类 P-1 / P-2 / P-3）；
- 对每类适配器，在受管块里**追加**一段 truth-source regression 声明（不替换 P-1 段，保证 marker 幂等）；
- 在 `principle 11` 之后追加 **principle 12**，专门约束 P-2 / P-3 真源规则；
- `lib/setup.js` 增加 `compatibilityAdapterBootstrapSectionP2P3` helper（默认空，模板按需启用）。

**验收标准**：

- 受管块在 P-1 / P-2 / P-3 三类适配器下都有显式 truth-source 声明；
- marker 替换 / 幂等 / 升级 additive-only 测试各加 1 个 case；
- `lib/setup.js` 单元测试覆盖空 / 启用 / 旧版本三种状态。

---

### 3.2 P-002.2 — Claude Code 路径补全

**问题**：P0/P1 在 `docs/platform-integration.md` 里加了"运行期回归"段，但是**没有**列出
"Claude Code 怎么读、`.claude/settings.json` 怎么配、`/mavis` 怎么接、SOI 边界在哪"。
Codex / Gemini 的同主题段在 `docs/` 里**完全没有**。

**候选动作**：

- 写 `docs/host-claude-code-integration.md`（与 `docs/platform-integration.md` 同体量）；
  - §1 路径映射表（`.claude/settings.json` ↔ `.agent/hooks/hooks.json`、`CLAUDE.md` ↔ `AGENTS.md`）；
  - §2 truth-source regression 在 Claude Code 下的具体执行（"先 `Read` `.agent/workflows/<cmd>.md`，再调用 tool"）；
  - §3 `[adapter-vs-truth mismatch]` 在 Claude Code 输出里长什么样；
  - §4 错误恢复（如何从 stop 状态恢复到正常 dispatch）。
- 在 `docs/host-codex-integration.md`、`docs/host-gemini-integration.md` 各加同样骨架（哪怕先空架子 + TODO）；
- 在 `AGENTS.md` 受管块**之前**加 1 段"host-specific supplement"指引，指向上述 3 个 host 文档。

**验收标准**：

- 3 份 host 文档存在且互相 cross-link；
- 每份都有"路径映射表 + truth-source 步骤 + mismatch 输出 + 恢复路径"四节；
- `docs/_sidebar.md`（或同等入口文件）收录这 3 份新文档。

---

### 3.3 P-002.3 — Compatibility Adapter 测试矩阵

**问题**：现有测试只覆盖了"块在 / 不在 / 内容变 / 内容不变 / 中英文"五个维度的 `lib/setup.js` 行为。
**没有**覆盖"具体每个 host × 每个 command"在 `update` 前后是否能跑通 truth-source regression。

**候选动作**：

- 列出 host × command 二维矩阵：
  - 行 = host：`codex` / `claude-code` / `gemini`（未来加 `cursor` / `aider` / `devin`）；
  - 列 = command：`/start-task` / `/mission` / `/arch-design` / `/plan` / `/review` / `/commit` / `/sync-plans` / ...（10+ 个）；
- 写 `tests/host-adapter-truth-matrix.test.js`，对每个 `(host, command)`：
  1. mock 该 host 的"读取 `.agents/skills/source-command-*`"动作；
  2. 验证宿主**会**去读 `.agent/workflows/<command>.md`（或返回 mismatch）；
  3. 模拟"真源缺失"，验证宿主**不会**执行适配器副本；
  4. 模拟"真源被 stale block 污染"，验证 block 被替换、用户内容保留。
- 把矩阵结果写到 `docs/architecture/host-adapter/truth-matrix-snapshot.md`（快照，CI 跑一次更新一次）。

**验收标准**：

- 矩阵覆盖至少 3 host × 10 command = 30 组合；
- 30 组合中失败的 ≤ 0；
- 快照文件随测试自动更新，且 diff 只反映新加的 host/command（不允许 row 数量减少）。

---

### 3.4 P-002.4 — bootstrap 块自检 / 修复 CLI

**问题**：P0/P1 commit message 自己说了 "P2 doctor consistency checker is deferred"。
现在 host 只能在 `update` 跑过之后才能知道"bootstrap 块是不是还在 / 是不是 stale"。
没有 `cortex-agent doctor --check-compat-adapter` 这种轻量命令。

**候选动作**：

- 在 `lib/doctor.js`（待确认位置）新增 `checkCompatibilityAdapterBootstrap(ctx)`：
  - 读取项目根 `AGENTS.md`；
  - 检测 marker 是否存在、内容是否与 `compatibilityAdapterBootstrapSection` 当前输出完全一致；
  - 检测 `principle 11` 是否在两个 `templates/*/.agent/rules/core-principles.md` 里都存在；
  - 检测 `.agent/workflows/` 下每个 `<command>.md` 都能被某个 `source-command-*` 适配器覆盖到（覆盖率）。
- 加 CLI：`cortex-agent doctor --check-compat-adapter`（默认无副作用，只报告）；
- 加可选 fix 模式：`cortex-agent doctor --check-compat-adapter --fix`（调用 `ensureCompatibilityAdapterBootstrapEntry`，需要 `--yes` 闸门）；
- 把 `[adapter-vs-truth mismatch]` 诊断文案从 `docs/platform-integration.md` **抽取**到 `lib/diagnostics.js` 单一来源，
  文档里只引用，不重复字符串。

**验收标准**：

- `cortex-agent doctor --check-compat-adapter` 在 3 个真实项目（cortex-agent 自身 + hmi-platform + SamHMI）上都跑通；
- `--fix` 模式幂等，重复 3 次输出相同；
- `lib/diagnostics.js` 单一来源后，`docs/platform-integration.md` 里只剩引用、无字符串重复。

---

### 3.5 P-002.5 — 跨 host 真源工作流同步

**问题**：`.agent/workflows/<command>.md` 是真源，但是：

- 不同 host 对它的"加载时机 / 缓存 / 重读策略"不同；
- `update` 升级时如果有 host 已经在内存里读了旧版工作流，`update` 完成后可能不会重读；
- cross-host 切换（Codex 切到 Claude Code）时，harness 是否还认 `.agent/`？这块没有契约。

**候选动作**：

- 在 `lib/setup.js` 的 `ensureAgentEntryFile` / `ensureCompatibilityAdapterBootstrapEntry` 旁边新增 `workflowSyncManifest(ctx)`：
  - 列出 `.agent/workflows/` 下所有 `<command>.md` 的 sha256；
  - 写到 `.agent/.workflow-sync-manifest.json`；
- 写 `templates/en/.agent/hooks/hooks.json` 增加 `PostUpdate` hook 步骤：跑 `node .agent/scripts/refresh-workflow-cache.js`（新增脚本）；
- 写 `tests/workflow-sync-manifest.test.js`：升级 + 跨 host 切换不丢工作流；
- `docs/platform-integration.md` 加 1 节 "Cross-host workflow sync contract"。

**验收标准**：

- `.workflow-sync-manifest.json` 在 init / update 之后都存在；
- PostUpdate hook 跑通且失败不阻塞 update 主流程（warn + continue）；
- 跨 host 切换（Codex → Claude Code）后，第一个真源工作流加载**不**出现 stale 内容。

---

### 3.6 P-002.6 — SamHMI 实战验证

**问题**：P0/P1 全程在 cortex-agent 自身 + hmi-platform 仓库上跑测试，**没有在 SamHMI 上跑过端到端**。
SamHMI 是 Windows WPF 端，harness 跟 Mac 端不同（feishu/lark MCP、GitKraken GUI 等），是真源回归最容易出问题的地方。

**候选动作**：

- 在 SamHMI 仓库上跑：
  1. `cortex-agent update --dry-run`，看 `entry_compatibility_adapter_bootstrap_stale` 是否被报出；
  2. `cortex-agent update`，验证 `AGENTS.md` 出现 bootstrap 块且不影响 `SamHMI/Dependencies/hmi-platform` 子模块；
  3. `cortex-agent doctor --check-compat-adapter`（P-002.4 交付后），看 clean；
  4. Windows 端 `dotnet build`，确认没有任何新增兼容性破坏。
- 把"端到端真值矩阵"写进 `docs/architecture/host-adapter/samhmi-validation-report.md`，
  列明：跑的版本、命令序列、结果、回归点、Screenshots（如有）。

**验收标准**：

- SamHMI 端 4 步全绿；
- 报告里有"在 SamHMI 上跑过"的明确日期、commit、build 输出（红 / 绿）；
- 报告里列出 ≥ 1 条 SamHMI 特有的"host-adapter 注意点"（如：AGENTS.md 在 SamHMI 仓库的 git 忽略策略、feishu MCP 的 SOI 等）。

---

## 4. Non-Goals

P-002 阶段**不**做：

1. **不**重写 `lib/setup.js` 的现有 helper；P0/P1 的 4 个 helper（`compatibilityAdapterBootstrapSection` /
   `mergeCompatibilityAdapterBootstrap` / `needsCompatibilityAdapterBootstrapMerge` /
   `ensureCompatibilityAdapterBootstrapEntry`）保持原签名、保持 additive-only。
2. **不**改 `.agents/skills/source-command-*` 下任何适配器副本。这些副本是"被发现的目标"，不是"被维护的源"。
3. **不**碰 SamHMI / hmi-platform 主仓的代码；SamHMI 实战验证只跑 `cortex-agent update` + `doctor`，
   不动 `SamHMI.sln` / `SamHMI/Dependencies/`。
4. **不**引入新的跨 host 协议；P-002 阶段沿用 `core-principles.md` 的 principle 11，必要时追加 principle 12，
   但**不**新写"framework"或"protocol"。
5. **不**把 P-002 一次性做完；本提案只到"评审通过 + 拆 MS"为止，每个 MS 单独走 `/arch-design`。

---

## 5. Success criteria

P-002 整体（包含最终选中的 N 个 MS）完成时，必须满足：

| # | 验收项 | 衡量方式 |
| --- | --- | --- |
| SC-1 | bootstrap 块在 P-1 / P-2 / P-3 三类适配器下都有显式 truth-source 声明 | `tests/setup-semantic-merge.test.js` 全绿 + 人工 spot check `templates/{en,zh}/.agent/rules/core-principles.md` |
| SC-2 | 3 份 host 文档（Claude Code / Codex / Gemini）存在且四节齐备 | `docs/host-{claude-code,codex,gemini}-integration.md` + 文件存在性测试 |
| SC-3 | 兼容性测试矩阵覆盖 ≥ 3 host × 10 command = 30 组合且失败率 = 0 | `tests/host-adapter-truth-matrix.test.js` |
| SC-4 | `cortex-agent doctor --check-compat-adapter` 在 3 个真实项目上 clean | CI 跑通 + 报告 |
| SC-5 | `.workflow-sync-manifest.json` 在 init / update 后存在，PostUpdate hook 跑通 | 文件存在性测试 + hook 单测 |
| SC-6 | SamHMI 端到端 4 步全绿，报告落档 | `docs/architecture/host-adapter/samhmi-validation-report.md` |

---

## 6. Milestones

> 评审通过后，下列 4 个 MS 是建议拆解。**不**承诺按此顺序；评审可以调优先级。

### MS-1 — 适配器扩展 + 路径补全（P-002.1 + P-002.2）

- 完成 P-002.1（适配器扩展）与 P-002.2（Claude Code / Codex / Gemini 三份 host 文档）。
- 产出：新增 2 个原则段（principle 11 增强 / 12 新增）+ 3 份 host 文档 + `lib/setup.js` P-2/P-3 helper + 对应测试。
- 预计 diff 规模：中（约 400-600 行新增、0 行删除）。

### MS-2 — 测试矩阵（P-002.3）

- 完成 P-002.3，覆盖 3 host × 10 command = 30 组合。
- 产出：`tests/host-adapter-truth-matrix.test.js` + `docs/architecture/host-adapter/truth-matrix-snapshot.md`。
- 预计 diff 规模：中（约 300-500 行新增测试 + 一份快照文档）。

### MS-3 — doctor 自检 + 跨 host 同步（P-002.4 + P-002.5）

- 完成 P-002.4 与 P-002.5。
- 产出：`lib/doctor.js` 扩展 + `cortex-agent doctor --check-compat-adapter` 命令 +
  `lib/diagnostics.js` 单一来源 + `.workflow-sync-manifest.json` + PostUpdate hook 脚本。
- 预计 diff 规模：大（约 800-1200 行新增，包括测试与脚本）。

### MS-4 — SamHMI 实战验证（P-002.6）

- 完成 P-002.6，跑通 SamHMI 端 4 步。
- 产出：`docs/architecture/host-adapter/samhmi-validation-report.md`。
- 预计 diff 规模：小（约 100-200 行报告新增、0 行代码变更）。

---

## 7. Risks

| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R-1 | P-2 / P-3 框架盘点后才发现"它们各自有不同的真源约定"，导致 P-002.1 的 helper 越来越胖 | 中 | 中 | 在 MS-1 启动前先开 1 个 spike（≤ 1 天），只盘点不实现 |
| R-2 | Claude Code 集成依赖未公开的 `CLAUDE.md` 行为细节，文档可能迅速过时 | 中 | 低 | 在文档头声明"基于 Claude Code X.Y 版本验证" + 写 1 个 smoke test 验证关键不变量 |
| R-3 | 测试矩阵 30 组合中可能有几个 host 的 API 暂未稳定，case 写不出来 | 中 | 中 | 矩阵先按"command × host"枚举，不稳定 host 暂时标 `skip`，但不允许 `skip` 出现在主分支 |
| R-4 | `doctor` 命令与现有 `update` 流程重复，状态语义模糊 | 中 | 中 | 在 `lib/doctor.js` 顶部明确"doctor 是 read-only 默认；`--fix` 是 write，需要 `--yes`"；CLI 互不调用 |
| R-5 | SamHMI 端 Windows-only 工具链导致某些 macOS 端测试无法复现 | 高 | 低 | MS-4 不要求复现，只要求跑通 + 落报告；不通过的步骤在报告里写"已知 deferred" |
| R-6 | `.workflow-sync-manifest.json` 引入新文件破坏 additive-only 原则 | 低 | 高 | manifest 写到 `.agent/` 下而非 `AGENTS.md` 周围；`update` 必须**先**检查存在再决定写；测试覆盖"已有 manifest 不被覆盖" |
| R-7 | P-002 拆太多 MS，每个 MS 各自走 `/arch-design` 流程拖慢交付 | 中 | 中 | 4 个 MS 之内；超 4 个要重新评审；优先级 P-002.4 + P-002.6 > P-002.1 > P-002.3 > P-002.2 > P-002.5 |

---

## 8. References

### 8.1 内部文档

- **本仓库**：
  - `.agent/plans/proposals/host-adapter/source-command-agent-truth-bootstrap-proposal.md`（P0/P1 顶层提案，运行期维护）
  - `docs/platform-integration.md`（"运行期回归" + 适配器与真源不一致的诊断示例）
  - `docs/getting-started.md`（新增的受管块说明）
  - `docs/architecture/adapter-authoring.md`（已有适配器编写规则，与 P-002.5 强相关）
  - `docs/architecture/one-click-update-design.md`（P0/P1 已是其子任务，P-002 是其后续）

### 8.2 代码定位

- `lib/setup.js:515-605` —— `compatibilityAdapterBootstrapSection` / `mergeCompatibilityAdapterBootstrap` 等 4 个 helper
- `lib/commands.js` —— `init` / `upgrade` 路径中的 `ensureCompatibilityAdapterBootstrapEntry` 调用与
  `entry_compatibility_adapter_bootstrap_stale` 报告
- `templates/{en,zh}/.agent/rules/core-principles.md` —— **principle 11**
- `tests/setup-semantic-merge.test.js` / `tests/update-semantic-merge.test.js` / `tests/upgrade-dry-run.test.js`

### 8.3 关键 commit

- `1ce7a95` feat(host-adapter): AGENTS.md Compatibility Adapter Bootstrap (T-CAB-001 P0/P1)
- `dc8615e` fix(host-adapter): preserve upgrade additive-only boundary
- `ce8f5b8` merge: T-CAB-001 (AGENTS.md Compatibility Adapter Bootstrap + upgrade additive-only boundary)

### 8.4 关联决策

- **D-CAB-001**（host-adapter proposal, approved）—— P0/P1 的源头决策
- **P-004 (host-adapter)** —— 关联顶层 proposal 编号
- **T-CAB-001** —— 本提案的 task 编号
- **M-007** —— 关联 mission 编号（由 `ce8f5b8` 引用）

### 8.5 上游 / 邻接提案

- `docs/architecture/one-click-update-design.md` —— P0/P1 是其"upgrade 语义合并"子任务；P-002 是其"升级后验证"延伸
- `docs/architecture/adapter-authoring.md` —— P-002.5 跨 host 同步需参照
- `docs/architecture/runtime-continuity-v2-design.md` —— SamHMI 实战验证需借助 runtime-continuity archive
- `docs/architecture/multi-agent-coordinator.md` —— 跨 host 切换契约的邻接

---

## 9. 评审 checklist

评审本提案时，请确认以下 5 项；如有任一项被否，本提案回到 draft 状态，**不**进入 MS 拆解：

- [ ] 6 个候选方向（P-002.1 .. P-002.6）中，至少 3 个被选为 P-002 必做。
- [ ] 选中的方向已被重新组织为 3-4 个 MS，**不**超过 4 个。
- [ ] 每个 MS 都标了优先级（p0 / p1 / p2），与 R-7 表一致或给出新理由。
- [ ] Success criteria（SC-1 .. SC-6）全部接受，**或**被改为可测量的新标准。
- [ ] SamHMI 实战验证（P-002.6）被明确安排在 MS-4（最后），**不**与 MS-1 / MS-2 并行。

> 评审通过后，本文件 `status: draft` 改为 `status: approved`，并在 `decision_ref` 字段填入新决策号（如 `D-CAB-002`）。
> 然后把每个 MS 拆成独立小提案，分别走 `/arch-design` → `/plan` → `/start-task`。
