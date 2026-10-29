# 审查能力对标：cortex-agent 相对 PR-Agent / Qodo 的缺失能力清单

> 状态：分析（analysis），非提案
> 日期：2026-10-23
> 基准：`origin/main` = `d24892f5`（v1.15.6）
> 对标对象：PR-Agent 的现继任者 **Qodo v2**（2026-02-04 发布）及 Qodo 2.2 的 PR history indexing
> 前置：[`docs/architecture/harness-review-and-runtime-evidence-design.md`](./harness-review-and-runtime-evidence-design.md) §4（既有「不对接 PR-Agent」评估）
> 执行计划：[`docs/exec-plans/active/harness-phase9-review-and-runtime-evidence.md`](../exec-plans/active/harness-phase9-review-and-runtime-evidence.md)

---

## 1. 摘要

**结论先行：既有 §4 的「不把 PR-Agent 作为 core 依赖或 required check」结论今天依然成立，但它的第 4 条论据「能力上无增量」已经失效。** PR-Agent 已更名为 Qodo，v2 的能力面比仓库里评估时的 v1 大出一个量级——多 agent 并行审查、judge 聚合、Context Engine、Rule Miner、blast radius、跨仓审查、PR Triage、finding 生命周期——这些 cortex 一项都没有。

因此本清单回答的不是「要不要集成 Qodo」，而是**「哪些能力 cortex 该自建、自建的最小切口是什么」**。

三条核心判断：

1. **cortex 的强项在「判定」而非「发现」**。schema 契约、finding↔changeset 归属校验、幻觉路径拦截、14 种机械断言、双候选区分度硬约束——这套「让审查结果可机械判定」的机制 Qodo 没有对等物（Qodo 的 finding 是给人看的 markdown/portal 对象）。
2. **cortex 的硬缺口在「闭环」**。finding 产出了，但**没有出口**：无法回写到 PR、无法标记 resolved/dismissed、无法跟踪「修了没」、无法衡量「团队会不会采纳」。
3. **最小切口是单点的**：给 `vcs-pr` 补 PR review 回写与 diff 读取（`vcs-pr/scripts/backends/github.js` 当前只有 create/status/merge/list 四个后端操作）。这一个缺口同时卡住 Qodo 侧的 finding 呈现、finding 生命周期、相关性分级和审查采纳率统计——四条能力链的共同上游。

---

## 2. 证据来源与口径

| 侧 | 来源 | 口径 |
|---|---|---|
| Qodo | `docs.qodo.ai/llms.txt` 官方索引 + 逐页 `.md` 端点（2026-10-23 取） | 以官方文档原文为准；标注 Beta / Research Preview 状态 |
| cortex | 本仓代码实读（`origin/main` @ `d24892f5`） | 每条结论带文件路径；`.agent` 为 gitlink，内部文件用 `git -C .agent show HEAD:<path>` 读取 |

**术语校正**：仓库既有 §4 评估的是 PR-Agent（Qodo v1 / Qodo Merge）。PR-Agent 文档现已并入 Qodo 文档站，v1 命令被 sunset。本清单以 **Qodo v2** 为对标基准。

---

## 3. Qodo v2 能力全景（对标基准）

来源：`docs.qodo.ai/core-concepts/qodo-platform-core-capabilities`、`/code-review/overview`、`/governance/rule-enforcement/rule-miner`、`/code-review/assess-risk-with-blast-radius`、`/governance/pr-triage`、`/governance/cross-repo-code-review`、`/agentic-toolbox/qodo-tools-reference`、`/code-review/track-resolved-findings`、`/code-review/dismiss-a-finding`、`/code-review/pr-summary`、`/code-review/relevance`、`/code-review/comment-anatomy`。

| # | 能力 | 机制要点 | 状态 |
|---|---|---|---|
| Q1 | **多 agent 并行审查** | 4 类专职 agent 并行（逻辑正确性/缺陷、标准符合性/可维护性、架构与系统级推理、跨变更风险评估），各带独立 context | GA |
| Q2 | **judge agent 聚合** | 合并 findings、去重、解冲突、按置信度与相关性过滤；只有可执行的高信号反馈到达用户 | GA |
| Q3 | **Context Engine 深度代码库上下文** | 索引并推理整个代码库而非孤立 diff：跨模块缺陷、架构模式与依赖、跨服务风险 | GA |
| Q4 | **PR history indexing + 持续学习** | 索引仓库完整 PR 历史；Finding Recommendation Agent 对每个候选 finding 评估「历史上是否提过、reviewer 怎么回应、代码是否真改、哪些引发讨论哪些被忽略」 | Beta（GitHub/GitLab） |
| Q5 | **Review Standards（规则系统）** | 组织标准从代码库、PR 历史、需求定义三处汇聚为单一事实源，随时间演化；每个 PR 的审查 agent 都在该规则系统上下文中工作 | GA |
| Q6 | **Rule Miner（从历史挖规则）** | 扫描 PR 讨论找复发模式生成规则。信号：reviewer 代码归属权重、评论复现频次、模式聚类到路径范围、被驳回建议自动衰减规则信号。首轮 ≤10 条/仓，后续每两周 ≤5 条 | Beta |
| Q7 | **Relevance（相关性分级）** | 每条 finding 按历史处理方式分 ⭐⭐⭐/⭐⭐/⭐（曾被接受 / 混合 / 历史上被忽略） | Beta |
| Q8 | **blast radius（爆炸半径）** | 按变更在代码库中的范围与敏感性分类为 Large/Medium/Small 三级，发布为 PR 原生 label；后 commit 抬高风险则 label 随之更新 | GA |
| Q9 | **结构化可行动 finding** | 含问题说明与影响、代码片段与上下文、语义质量标签（reliability/maintainability）、证据与推理、修复建议 | GA |
| Q10 | **finding 生命周期** | 三态：✓ Resolved（后续 commit 修复）/ ✗ Dismissed（未修但主动关闭）/ ⊖ Outdated（所指代码被删改）。每次新 commit 对所有未决 finding 重新评估 | GA |
| Q11 | **dismiss 带理由** | 4 种理由（False positive / Intentional / Fix later / Not specified）+ 可选说明；dismiss 不可撤销 | GA |
| Q12 | **PR summary + walkthrough** | AI 生成意图摘要、标签（Bug fix/Tests/Enhancement/Documentation/Configuration）、评审耗时预估、变更分解（描述 + 架构图 + 高层评估）、按类分组的文件变更概览 | GA |
| Q13 | **跨仓审查** | 关系自动识别并分类（Code/Service/Data/Pipeline/Docs），双向追影响（依赖方 + 冲突方），产出 `Cross-repo` 冲突 finding 并链到受影响行 | Beta |
| Q14 | **PR Triage 队列** | 跨 GitHub/GitLab/Bitbucket/Azure DevOps 的统一开放 PR 队列，按 SLA / Priority / Inactivity 策略排序，Next action 建议 | Research Preview |
| Q15 | **审查分析** | 采纳率、被行动与被接受的 findings、高严重度结果、按仓库与作者维度 | GA |
| Q16 | **Agentic Toolbox** | 以 CLI / MCP 暴露给编码 agent：代码库工具（find/ls/read/grep/blame/list-commits/list-prs…）、跨仓工具、PR 工具（findings/mark-implemented/dismiss）、Skills 工具、Rules 工具 | GA |
| Q17 | **多 Git provider** | GitHub / GitLab / Bitbucket / Azure DevOps / Gerrit，多租户 / 单租户 / 本地化部署 | GA |

---

## 4. cortex 现有审查能力（代码级实读）

### 4.1 强项：判定链完整

| 能力 | 证据 | 说明 |
|---|---|---|
| 产出与判定分离 | `.agent/skills/agent-review-benchmark/scripts/reviewer-backend.js`（模块头注释 9-18 行） | reviewer 只提议 finding；schema/changeset/文件存在性三关校验不可绕过 |
| finding↔changeset 归属校验 | 同上 `acceptFindings()` | 越界文件即丢（`file_not_in_changeset`）；幻觉路径即丢（`file_not_found`） |
| 丢弃不静默 | 同上 rejected 收集 + diagnostics 落盘 | 单条坏 finding 不拖垮整场审查，且拒绝原因可查 |
| 零依赖 JSON Schema 子集校验器 | `.agent/skills/agent-review-benchmark/scripts/lib/json-schema.js` | 未实现 keyword 直接报错，不默默忽略 |
| 14 种机械断言 | `scripts/agent-review-benchmark-runner.cjs:234-305` | `file_exists` / `file_absent` / `file_contains` / `file_not_contains` / `file_equals` / `no_absolute_symlink` / `json_field_equals` / `output_contains` / `output_not_contains` / `output_json_field_equals` / `command_exit` / `finding_present` / `finding_absent` / `artifact_schema_valid` |
| 双候选区分度硬约束 | `scripts/agent-review-benchmark-runner.cjs`（阈值判定段） | reference 必须满分、noop 必须低于区分力阈值——防止门禁沦为同义反复 |
| 确定性可复现 | `reviewer-backend.js`（`generated_at` 取自输入而非墙钟） | 同输入同字节 |
| L1 分发完整性三门禁 | `scripts/check-l1-distribution.js`、`check-l3-boundary.js`、`check-template-parity.js` | manifest 完整性 / 文件集与内容按层对等 / 死链 / L3 边界 |

> 注：`code-review` workflow 与 `agent-review-benchmark` skill 只在 L1 的 `_shared` 层（`templates/_shared/.agent/`），zh/en 层为 0——符合「共享层打底 + 语言层覆盖」模型，非缺口。

### 4.2 弱项：判断层靠 LLM，机械判定层覆盖不到质量面

| 能力 | 证据 | 现状 |
|---|---|---|
| `security-scan` | `.agent/skills/security-scan/SKILL.md` | 危险 API 清单 + `npm audit`/`pip-audit`/`govulncheck` 提示词；**判定由 LLM 完成，无脚本，不可机械复现** |
| `code-evaluation` | `.agent/skills/code-evaluation/SKILL.md` | 三维度评价清单，**纯 prompt，无脚本** |
| `validation-contract` | `.agent/skills/validation-contract/SKILL.md` | 9 种 assertion type，**全为散文契约，无实现** |
| `architecture-guard` | `.agent/skills/architecture-guard/scripts/index.js` | 脚本注释自承「we just confirm the file is readable and use hardcoded rules below」——只查 `controllers/` 是否 import `db`，**是样例不是规则引擎** |
| `dependency-analysis` | `.agent/skills/dependency-analysis/SKILL.md` | 4 项分析全是**并行任务冲突**（文件冲突/接口缺口/blocker 链/重复工作），**不是变更影响面** |
| `knowledge-lint` | `.agent/skills/knowledge-lint/scripts/index.js` | **唯一真确定性知识检查**：断链/失效锚点/缺 README/plan 生命周期/架构引用失配/frontmatter 违规 |

### 4.3 闭环缺口（本清单的核心）

| 缺口 | 证据 |
|---|---|
| **PR 回写通道不存在** | `.agent/skills/vcs-pr/SKILL.md` 的 Non-Goals 显式排除 review/assign/label；`vcs-pr/scripts/index.js` 命令面仅 `create\|update\|status\|delivery-status\|pipeline-jobs\|job-trace\|merge\|list`；`scripts/backends/github.js` 后端仅 4 个操作（createPR/getStatus/merge/list）。全仓 grep 无 `pulls/*/reviews`、`issues/*/comments`、`merge_requests/*/notes` 调用 |
| **finding 无生命周期状态机** | `guided-review-finding.schema.json` 无 status/resolved/dismissed 字段；全仓 grep `dismiss\|resolved_finding\|outdated\|mark_implemented\|finding_lifecycle` 在 agent-review-benchmark 与 runner 内**零命中** |
| **finding 无行级锚定** | `guided-review-finding.schema.json` 的 `files` 是文件级数组，无 line/hunk/anchor 字段——归属校验只到文件级 |
| **无变更影响面 / blast radius** | 全仓无「改动 → 受影响文件/依赖爆炸半径」计算；最接近的 `skills/context-budget/scripts/context-traverse.js` 是模块级（当前 10 module）、服务于规划期上下文预算，**不在 review 路径上** |
| **无 PR 历史作为上下文** | `code-reviewer.md` 只允许「Previous Review Reports（若是重试）」；全仓无 PR/评审历史挖掘机制 |
| **无仓库自产索引/图谱** | `skills/graphify/SKILL.md` 需外部 `graphify-out/graph.json`；`.agent/context-index.json`（10 个模块级条目）由 `/scan-project` 生成，`code-review` workflow 不引用 |
| **CI 无 LLM 审查接线** | `.github/workflows/full-test.yml:112-171` 只跑 `benchmark:agent-review` / `benchmark:guided-review`（含 noop 对照）；全仓 CI 与 scripts 无任何 LLM provider 调用 |
| **finding 语义标签体系不同** | cortex 的 `category` 枚举 7 值 + `risk` 4 值；Qodo 是「语义质量标签（reliability/maintainability 等）+ severity + 置信度过滤 + relevance 三星」三轴。cortex 无置信度维度、无 relevance |

---

## 5. 缺失能力清单（按处置方式分级）

### A 类 · 应自建（cortex 架构内可做，无外部依赖）

| ID | 能力 | 对标 | 缺失证据 | 自建成本 | 备注 |
|---|---|---|---|---|---|
| **A1** | **PR review 回写 + diff 读取** | Q9/Q12/Q16 | `vcs-pr` backends/github.js 仅 4 操作；Non-Goals 排除 review | 中（需新增 GitHub review/comment API 调用 + diff 获取） | **最小切口**。四条能力链的共同上游 |
| **A2** | **finding 生命周期状态机** | Q10/Q11 | schema 无 status 字段；零 grep 命中 | 中（schema 加状态 + 三态判定 + 诊断） | 依赖 A1 才能落库到 PR，但 schema 可先行 |
| **A3** | **finding 行级锚定** | Q9 | schema 的 `files` 仅文件级 | 低（schema 加行号/hunk 字段 + 归属校验扩展到行级） | 与 A2 同批改 schema 成本最低 |
| **A4** | **变更影响面 / blast radius** | Q8 | 全仓无计算能力 | 中高（需依赖图 + 敏感度分级 + 三档阈值） | 可先做「受影响文件集合」机械计算，风险分档留给 LLM |
| **A5** | **置信度 + relevance 字段** | Q7/Q9 | schema 无 confidence/relevance 维度 | 低（schema 加两个枚举 + benchmark 加断言） | relevance 需历史数据，可先只做 confidence |
| **A6** | **PR 摘要 / 变更概览** | Q12 | 无对应产出 | 中（依赖 A1 回写） | 可复用既有 finding groups 聚合 |
| **A7** | **多 reviewer 并行 + judge 聚合** | Q1/Q2 | 单一 `code-reviewer`；无聚合层 | 中（并行调度 + 去重/冲突仲裁规则） | cortex 已有 `/parallel` 与 `agent-team` 编排可复用 |
| **A8** | **规则从历史挖掘** | Q5/Q6 | 规则全为静态文本；learning-harvest 只抽本地结构化源 | 高（需 PR 历史索引基建） | 见 B4 的前置依赖 |
| **A9** | **审查采纳率统计** | Q15 | 无任何 finding 处置数据 | 中（依赖 A1+A2 积累数据） | 长期价值最高，但需先有闭环 |

### B 类 · 部分自建 / 部分依赖外部

| ID | 能力 | 对标 | 说明 |
|---|---|---|---|
| **B1** | **跨仓审查** | Q13 | cortex 有跨项目协调（`cross-project-coordination`）与 `coordination` skill，但那是「跨项目协作」非「跨仓破坏性变更检测」。需要仓库关系图 + 双向影响追踪，成本高；本仓单仓场景短期无收益 |
| **B2** | **PR 队列 / Triage / SLA** | Q14 | cortex 有 `mission-progress` 与任务状态，但语义是「内部任务治理」非「外部 PR 积压队列」。需要外部 PR 清单聚合 + SLA 策略模型 |
| **B3** | **多 Git provider** | Q17 | cortex 已有 gitea/github/gitlab 三后端，同一 interface。Bitbucket/Azure DevOps/Gerrit 是增量工作，非能力缺失 |
| **B4** | **PR 历史索引** | Q4/Q6/Q7 | 这是 Qodo 侧学习闭环的**前置基建**（Rule Miner、Relevance、Finding Recommendation 三者都依赖它）。cortex 若自建 A8，必须先建它。可选路径：GitHub API 拉取历史 PR + 评论，成本高；或走 Qodo adapter（P-001 已留接口） |

### C 类 · 不追（cortex 定位不同，硬约束冲突）

| ID | 能力 | 不追的理由 |
|---|---|---|
| **C1** | Qodo Portal / 企业治理后台 | cortex 是本地零依赖 CLI + 模板分发，不是 SaaS。SSO/RBAC/API key/计费不在定位内 |
| **C2** | Qodo 商业托管与多租户 | 同上 |
| **C3** | Qodo 本地化/私有部署 | cortex 已是纯本地 Node stdlib |
| **C4** | 把 Qodo 设为 required check | 违反零依赖原则 + 纯 Node stdlib 硬约束（`.agent/rules/architecture-design.md`）；且既有 exec-plan 明文保留该非目标 |

---

## 6. 既有 §4 评估的重新裁决

`docs/architecture/harness-review-and-runtime-evidence-design.md:182-193` 的四条论据，今天的成立性：

| 原文论据 | 今日裁决 |
|---|---|
| ① **分发污染**：集成 = 每个下游装 Python + LiteLLM + 配 LLM key，与「零依赖 + 纯 Node stdlib」冲突 | **仍成立**。`package.json` 的 dependencies 与 devDependencies 均为空；零依赖原则未松动 |
| ② **输出格式不匹配**：PR-Agent 出 markdown comment，适配需抽取层 | **已缓解**。`guided-review.schema.json` + `external` backend 的 adapter 接口已就位——接 Qodo 现在是写一个 adapter 而非改 core，原文的「保留接入口」承诺已兑现 |
| ③ **自研成本显著更低**：自研 ≈ 1–2 个 PR | **已兑现且成本已付**。M1–M5 全部落地；新增验证的边际成本已降到「写一个 dataset case」 |
| ④ **能力上无增量**：判断 cortex 已有、diff 解析不缺、GitHub 集成对本仓价值低 | **部分失效**。「判断能力已有」成立（LLM 判断 + schema 校验）；但 **「无增量」不再成立**——Qodo v2 相对评估时的 v1 新增了多 agent/judge、Context Engine、Rule Miner、blast radius、跨仓审查、Triage、finding 生命周期。**且该论据的隐含前提「审查结果进不了 PR 也不要紧」今天不成立**：仓库已有真实 required check 与 14 个开放 PR，缺的正是从「finding 产出」到「PR 上可见可处置」的通路 |

**裁决结论**：不改「不集成进 core」的决策，但把第 ④ 条替换为「**Qodo v2 的能力面比 v1 大一个量级，其中与 cortex 定位相容的部分应自建，且最小切口是 PR 回写**」。

---

## 7. 建议的推进顺序

```
第一梯队（闭环必需）
  A1 PR review 回写 + diff 读取   ← 唯一硬缺口，解锁四条能力链
  A2 finding 生命周期状态机
  A3 finding 行级锚定            ← 与 A2 同批改 schema
  A5 confidence / relevance 字段

第二梯队（判断质量）
  A7 多 reviewer 并行 + judge 聚合
  A4 变更影响面 / blast radius
  A6 PR 摘要 / 变更概览

第三梯队（长期学习）
  B4 PR 历史索引  →  A8 规则挖掘  →  A9 采纳率统计
```

**先做 A1 的理由**：它是唯一同时被 Q10（生命周期）、Q12（摘要）、Q15（分析）、Q16（toolbox）依赖的上游。缺它，A2/A6/A9 三条链无处落地；而 A2/A3/A5 可以在 A1 之前先改 schema 与断言（改动面小、可独立验证），不会浪费。

---

## 8. 证据边界

**已实读核实**：cortex 侧全部结论均来自本仓代码实读（`origin/main` @ `d24892f5`），带文件路径。断言类型数（14）由 `scripts/agent-review-benchmark-runner.cjs:234-305` 逐 case 核对。

**外部文档核实**：Qodo 侧结论来自 `docs.qodo.ai` 官方索引与 12 个 `.md` 端点原文（2026-10-23 取）。Q4/Q6/Q7/Q13 标注 Beta，Q14 标注 Research Preview——**能力成熟度不等同于 GA**，对标时不应把 Beta 能力当作既成差距。

**未验证 / 待确认**：
- `npm view` 走本机 npmmirror 镜像会看到滞后版本；上游 `registry.npmjs.org` 已确认 1.15.6 已发布（2026-10-23T02:47:27Z）。
- 未实测 `knowledge-lint` / `architecture-guard` 的真实运行输出。
- Qodo 的 Beta 能力在真实仓库上的实际效果未经第三方验证，仅采信官方文档口径。
