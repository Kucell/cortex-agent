# Harness Phase 9：审查契约、应用验证证据与 Skill 可发现性

> 状态：进行中（待提案批准）
> 开始日期：2026-10-22
> 设计提案：[`docs/architecture/harness-review-and-runtime-evidence-design.md`](../../architecture/harness-review-and-runtime-evidence-design.md)
> 前置阶段：[`docs/exec-plans/active/harness-phase8-application-legibility.md`](./harness-phase8-application-legibility.md)（Phase 8，文档层已完成，能力层空缺）

---

## 目标

补齐 Phase 8 留下的能力层缺口：让**应用验证**、**异构审查**、**Skill 分发**三条链路各自具备「可执行判定 + 可发现说明 + 生产到判定的机械通路」，并把三者收敛到同一套可复用的机械门禁机制上。

Phase 8 把应用可理解性的**文档层**做完了（6/6 任务已完成），但生产端是空的：`.agent/metrics/verification-summary.json` 恒为 `not_run`，`/ship` CLEAN 的阻断能力实际为空。本阶段补上生产端。

M4 补的是另一类「看起来绿、实际不对」：M1 修好了 L1 的**文件集**，但没管**文件内容** —— 下游可能拿到一份几个月前的实现。本阶段把内容对等也变成机械门禁。

---

## 范围

- **P-003**（M1）：修 L1 分发完整性——补齐 15 个缺失的 skill `SKILL.md`、5 处缺失的实现文件、清理分发垃圾，并新增三条机械门禁（manifest 完整性 / 文件集对等性 / 链接有效性）
- **P-002**（M2）：定义 runtime-evidence 数据集格式，落地第一个真实 API 层验证数据集，把结果接入 `verification-summary.json` 与 `/ship` CLEAN
- **P-001**（M3）：定义 `guided-review` finding schema，落地 builtin reviewer backend，把 finding 纳入 benchmark 机械判定
- **P-003 续**（M4）：补上 L1/L3 **内容**对等门禁 —— M1 管的是「L1 缺不缺文件」，M4 管的是「L1 的文件是不是旧的」

**统一机制**：全部复用 S6 已交付的 `scripts/agent-review-benchmark-runner.cjs` 与现有 11 种断言，不重造 harness。

---

## 非目标

- 不把任何外部 LLM 审查器（PR-Agent 等）设为 required check 或引入 core 依赖
- 不在 core 引入 Python 或任何非 Node 运行时依赖
- 不实现 UI 层浏览器驱动（M4 另行立项，依赖宿主浏览器能力）
- 不重写 `agent-review-benchmark` 已交付的 harness、断言集与 skill 契约
- 不改 `templates/_shared` 之外的分发内容

---

## 任务拆解

### T-H24 [已完成] M1 · L1 分发完整性修复（manifest + 实现 + 垃圾）

**T-H24a 补齐 15 个 L1 skill 的 SKILL.md**
- 目标 skill：`agent-visibility`、`architecture-guard`、`doc-gardening`、`graphify`、`knowledge-lint`、`mission-progress`、`runtime-continuity`、`runtime-evidence`、`runtime-state-integration`、`runtime-state-mcp`、`secrets`、`session-triage`、`sync-global`、`vcs-pr`、`weekly-report`
- 来源：L3 `.agent/skills/<name>/SKILL.md`
- **已实证**：这 15 个文件既无 `scope: L3` 标记，也不引用任何 L3-only 规则，同步**不需要逐个重写**
- 同步后需修正下游必然失效的引用：已知 `runtime-evidence/SKILL.md` 指向 `../../../docs/reliability/verification-templates.md`，而 L1 模板不发布 `docs/`（`templates/_shared/` 下只有 `integrations/`）

**T-H24b 补齐 5 处缺失的实现文件**（最高优先级：前两项让 skill 从不可用变为可用）
- `vcs-pr/scripts/index.js` — PR 编排器，承担密钥解析（经 secrets skill 取 `token_ref`）、backend 调用、`vcs_pr_opened/merged/closed` 事件发射。L1 缺它则 3 个 backend 无人调用，而 L1 的 `config/vcs.yml.example` 正在教用户使用该 skill
- `maturity-tracker/scripts/index.js` — L1 有 SKILL.md 但缺实现，manifest 指向不存在的脚本，最难发现的一类
- `runtime-evidence/scripts/generate-summary.js` — SKILL.md 声明的核心功能
- `secrets/scripts/generate.js`
- `runtime-state-integration/agents/openai.yaml`、`runtime-state-mcp/agents/openai.yaml`

**T-H24c 清理分发垃圾**
- 移除 `templates/_shared/.agent/skills/runtime-evidence/.DS_Store`
- 同步时排除 L3 侧的 `.bak` / `.bak.prev` / `.new` / `.DS_Store` / `*.test.js`
- 不同步 L3 侧两处路径事故产生的嵌套重复目录：`secrets/secrets/scripts/*`、`vcs-pr/vcs-pr/scripts/backends/*`（L3 侧本身也需另行清理，不在本任务范围）

- 验收：`templates/_shared/.agent/skills/*/SKILL.md` 覆盖全部 33 个 skill；5 处实现补齐；`node scripts/check-l3-boundary.js` 零违规；无未分发路径的链接

### T-H25 [已完成] M1 · L1 分发完整性机械门禁

三条只读、hermetic 的检查：

| 检查 | 判据 |
|---|---|
| manifest 完整性 | L1 每个 skill 目录必须有 `SKILL.md`，frontmatter 必填字段合规 |
| 文件集对等性 | L1 相对 L3 不得缺实现文件（按 T-H24c 的排除清单过滤） |
| 链接有效性 | manifest 内的文档链接必须指向 L1 实际分发的路径 |

- 接入 `.github/workflows/full-test.yml`，作为独立步骤
- 反向验证（三个都必须失败）：人为删除一个 `SKILL.md`；人为删除一个实现文件；写入一条指向 `docs/` 的死链
- **文件集对等性这条不能省**：只查 manifest 会漏掉 `maturity-tracker` 这类「manifest 在、实现缺」的情况
- 门禁自身必须 hermetic（只读，不写 `.agent/`）

### T-H26 [已完成] M2 · 定义 runtime-evidence 数据集格式

- 在 `benchmarks/runtime-evidence/<app>/dataset.json` 落地数据集格式，语义与 S6 的 `benchmarks/agent-review/` 对齐
- 复用现有 11 种断言；候选 = 真实启动命令 / 健康检查 / 端点探测
- 明确**覆盖边界**：API 层只覆盖可机械断言的运行行为，不覆盖渲染/交互断言

### T-H27 [已完成] M2 · 落地第一个真实 API 层验证数据集

- 选一个真实可启动的本仓或下游目标
- reference 候选必须 10000 bp；noop 候选必须 < 5000 bp（区分力强制要求）
- 每条断言必须被真实评估，不允许恒真断言

### T-H28 [已完成] M2 · 接入 verification-summary.json 与 /ship CLEAN

- 验证执行后写入 `.agent/metrics/verification-summary.json`，`overall_status` 能取到 `pass` / `fail` / `partial`
- `/ship` CLEAN：`fail` 阻断；`not_run` 给出明确告警，不再静默通过
- 沿用 Phase 8 已有的 `docs/reliability/verification-templates.md` 与 `runtime-evidence-integration.md` 作为设计依据

### T-H29 [已完成] M3 · 定义 guided-review finding schema

- 发布 finding 的结构化 schema，字段与 `agent-review-benchmark` 的 `guided-review.schema.json` 保持一致
- 不改 `agent-review-benchmark` skill 的「默认不用外部 LLM judge」契约

**实施要点**

- 新增 `references/guided-review-finding.schema.json`：一条 finding = 一个被审查出来的问题，字段与 artifact 的 group 定义**逐字段一致**（测试逐字段比对，防止漂移）
- **修掉一个真 bug**：既有 `guided-review.schema.json` 的 `summary` 子对象写了 `additionalProperties:false` 却没有 `properties`，于是所有属性都被禁止；而 `required` 又要求那 5 个字段必须存在。两句话放在一起的结果是**任何文档都过不了校验**，包括 skill 自己产出的那一份。也就是说这份「已发布 schema」从来没有真正约束过任何东西。修好后既有的真实历史产物（`009-ms002-guided-review.json`）能通过校验——反向验证证明旧定义确实不可满足
- 仓库零 npm 依赖，`ajv` 不可用。新增 `scripts/lib/json-schema.js`：零依赖 JSON Schema 子集校验器。**它遇到自己没有实现的 keyword 会报错而不是默默忽略**——默默忽略的 keyword 会让一份坏 schema 看起来像好 schema
- group 增加可选 `category` 字段（`architecture`/`quality`/`test`/`validation`/`security`/`performance`/`docs`），对齐 `code-reviewer` 子代理的 7 个审查维度；既有产物保持有效

### T-H30 [已完成] M3 · builtin reviewer backend

- backend 形态：把 `/code-review` workflow + `code-reviewer` 子代理的产出收束成合规 finding
- 预留 external backend 接口但不进 core：外部审查器作为可选 adapter 存在，不引入依赖、不进分发

**实施要点**

- 新增 `scripts/reviewer-backend.js`。核心不变式是**产出与判定分离**：谁产出都行，但**校验不外泄**——每条 finding 在进入 artifact 之前都要过校验，artifact 在写出之前还要再过一次
- 一条 finding 被接受需要同时满足三条：符合 finding schema（`schema_invalid`）、只引用本次 changeset 里的文件（`file_not_in_changeset`）、引用的文件在工作区真实存在（`file_not_found`）。第二条把 `code-reviewer` 的「输入隔离」原则变成机械约束，第三条挡住幻觉路径
- 一条不合格 finding **不连累其余 finding**：被丢弃的 finding 与原因写进 `<output>.diagnostics.json`，丢弃从不静默
- `external` backend 预留 adapter 接口（`module.exports = { review(context) → { findings } }`），**不提供实现、不引入依赖**。adapter 只提议 finding，无法绕过任何一条校验
- `code-reviewer` 子代理与 `/code-review` 工作流的输出契约同步更新：Part 2 JSON 增加 `changed_files` 与 `findings`，并给出后端调用方式

### T-H31 [已完成] M3 · finding 纳入 benchmark 机械判定

- builtin backend 产出的 finding 集作为 dataset 参与判定
- 强制区分力：noop finding 集得分显著低于 reference
- 判定结果进入 CI summary

**实施要点**

- S6 引擎新增 3 种断言：`finding_present`（finding 存在且满足全部约束）、`finding_absent`（artifact 存在且不含该 finding）、`artifact_schema_valid`（artifact 符合已发布 schema）。**缺 artifact 时全部失败**——「后端拒绝了这条 finding」和「后端根本没跑」是两回事，只有前者算通过，否则什么都不做的候选会白拿 absent 断言的分
- 数据集 `benchmarks/guided-review/cortex-agent-review/`：2 个 case，全部来自本仓真实历史缺陷（`test-runner.cjs` 的 `NODE_TEST_CONTEXT` 假绿与「独占重跑通过」文案 bug；`runtime-evidence/SKILL.md` 指向未分发 `docs/` 的死链），权重 3 + 2
- 三个候选形成区分度梯度：**reference = 10000 bp（11/11）**、**lenient = 5172 bp**、**noop = 0 bp**。`lenient` 候选（拿到什么写什么、完全不校验）证明 `finding_absent` 断言有牙齿：它能通过全部 `finding_present`，却必须因为没丢弃该丢的 finding 而失分
- 判定结果通过 `scripts/append-ci-summary.cjs` 进入 GitHub job summary（门禁只写 JSON 文件的话，读 CI 的人看不见）
- 复用 S6 引擎，不重造 harness；数据集 fixture 支持直接写 JSON 值，避免在 dataset 里手工转义嵌套 JSON

### T-H32 [待办] M5 · UI 层（不排期）

- 依赖宿主浏览器能力；cortex 只定义 `browser-verification.json` 的产出格式与校验
- 宿主能力成熟后单独立项，本阶段不承诺时间

### T-H33 [已完成] M4 · L1/L3 实现文件内容对等门禁

M1 修的是「L1 缺文件」，但没有管「L1 的文件内容是不是旧的」。全量扫描发现 **75 个实现文件里有 10 个内容不一致**，其中包含两个真问题：

- **L1 的 secrets skill 是坏的**：`secrets/scripts/index.js` 引用了 `REDACT_TOKEN`，而 L1 的 `redact.js` 没有导出它 → 运行即 ReferenceError
- **L1 分发面保留着已修掉的安全漏洞**：L3 已移除 `--account` 覆盖（yunxiao-pkg-upload 越权读事故），L1 还在 honoring 它

**改动**

- `check-l1-distribution.js` 新增**检查 4：实现文件内容对等**（L1 ≡ L3，逐字一致）
  - 范围限定为**实现文件**（`skills/*/scripts`、`skills/*/agents`、`hooks/`、`plugins/*/scripts`、`handoffs/scripts/`、`tasks/scripts/`、`artifacts/scripts/`、`scripts/`；扩展名 js/cjs/mjs/sh/yaml/yml）。文档按语言与场景差异化是设计意图，运行时状态在 L1 是模板、在 L3 是活记录 —— 这两类逐字比对只会让门禁喊狼来了
  - 显式豁免清单，每条必须带理由；**豁免失效（两边已一致）会被报出来**，防止清单腐烂成永久盲区
- **按分发层检查**，不只查 `_shared`：`cortex-agent init` 是「共享层打底 + 语言层覆盖，语言层赢」。只查 `_shared` 会漏掉即将被覆盖层发出去的旧副本。检查面从 75 个实现文件扩到 **348 个**
- 同步方向是**双向的**，由证据逐个定，不预设「L3 是真相」：
  - **L3 → L1**：`secrets/scripts/redact.js`（L1 缺 `REDACT_TOKEN` 导出 → L1 的 secrets skill 是坏的）、`secrets/scripts/index.js`（L1 保留着已修掉的 `--account` 越权漏洞）、`knowledge-lint`、`mission-progress`、`handoffs-protocol`、`runtime-continuity`
  - **L1 → L3**：`hooks/claude-code-transcript-link-reporter.sh`（L3 版硬编码 `/Users/xueyq` 机器路径）、`plugins/graphify/scripts/post-commit-update.js`（L3 版是重复的独立实现）、`minimax-cli/SKILL.md`（`/Users/xueyq/.mmx/*` → `~/.mmx/*`，三层都分发）
  - **en → L3**：`vcs-pr/scripts/{index.js,backends/gitlab.js}`（en 层带 labels/reviewers 与 fail-closed run 关联，L3 落后）
  - **L3 → zh**：`management-api/scripts/index.js`（zh 层自己的版本不认识 `task-state` 投影，而投影注册表三层都有 —— zh 层自身就是坏的）
- 修 **L3 自身**的缺口：`runtime-continuity` 缺 `--project` 的 fails-closed 校验（`--project .` 会把上下文写进 contexts 根、`--project ..` 会逃出 `~/.agent`）与 `exists` 契约字段，移植自 zh 层；改后 L3 成为超集，四个副本逐字一致
- 清理 L3 侧垃圾：25 个 `.bak`/`.bak.prev` + 两处路径事故产生的嵌套重复目录（`skills/secrets/secrets/`、`skills/vcs-pr/vcs-pr/`，均确认为旧版残留）；删除 `en` 层误分发的 `gitlab.test.js`
- 反向验证 3 项：内容漂移必失败、豁免失效必失败、豁免条目必须指向真实文件且理由非空

---

## 验收标准

### M1
- `templates/_shared/.agent/skills/*/SKILL.md` 覆盖全部 33 个 skill
- 5 处缺失实现补齐，`vcs-pr` 与 `maturity-tracker` 在下游**从不可用变为可用**
- L1 内无 `.DS_Store` / `.bak` / 嵌套重复目录等分发垃圾
- 分发完整性检查接入 CI，三条检查全部覆盖，且三个反向验证（删 manifest / 删实现 / 写死链）均能让检查失败
- `pnpm check:l3` 零违规；`pnpm check:parity` 通过

### M2
- 至少一个 `benchmarks/runtime-evidence/<app>/dataset.json`，reference = 10000 bp、noop < 5000 bp
- 一次真实运行后 `verification-summary.json` 的 `overall_status` 从 `not_run` 变为 `pass` / `fail`
- `/ship` CLEAN 在 `fail` 时阻断、在 `not_run` 时告警

### M3
- finding schema 发布，summary 仍符合已发布 schema
- 至少一个 builtin backend 产出合规 finding
- 判定具备区分力（noop 显著低于 reference）

**M3 实测**

| 项 | 结果 |
|---|---|
| finding schema | `guided-review-finding.schema.json`，与 artifact group 定义逐字段一致（测试守卫） |
| 旧 schema 可满足性 | 修前不可满足（反向验证），修后真实历史产物通过 |
| builtin backend | 接受合规 finding；`schema_invalid` / `file_not_in_changeset` / `file_not_found` 三类拒绝各有原因码 |
| external backend | 接口已预留，无实现、无依赖；adapter 提出的越界 finding 同样被拒 |
| 数据集区分度 | reference 10000 bp（11/11）、lenient 5172 bp、noop 0 bp |
| CI summary | 判定结果进入 GitHub job summary |
| 依赖 | 新增 0 个 npm 依赖；新增代码只用 Node 内置模块 |

### M4
- 实现文件内容对等门禁接入 CI，且能反向失败（内容漂移 / 豁免失效 / 豁免无理由）
- 按分发层（`_shared` + `zh` + `en`）统计，L1 与 L3 内容不一致数为 0（豁免项除外，且豁免带理由）
- L1 分发面不再保留已在上游修掉的安全漏洞与坏文件
- 分发面无机器特定路径（`/Users/xueyq`）残留

### 全量
- CI `full-test` 全绿且零 NON-HERMETIC 漂移
- 不新增 npm 依赖；`bin/cli.js` 仍只用 Node 内置模块
- 每个任务独立 PR，PR 内验证 + CI 绿 + 合并

---

## 风险与依赖

- **R1 数据集同义反复**：数据集沦为「给实现写的测试」。缓解：必须复现历史真实缺陷 + 强制 noop 区分力 + 断言不得恒真
- **R2 覆盖边界被误解**：用户可能以为 P1 已完成。缓解：schema 与 SKILL.md 显式声明边界；UI 层单列 M4
- **R3 L1 体积膨胀**：补 15 个 manifest + 5 个实现文件增大分发体积。缓解：先量化增量，必要时改「索引发现 + 精简 manifest」双轨
- **R4 下游死链**：L1 的 `SKILL.md` 引用本仓 `docs/` 路径，而 L1 不发布 `docs/`。缓解：分发完整性门禁包含链接有效性检查；同步时逐个改写（已实证当前至少 1 处）
- **R5 同步引入 L3 垃圾**：L3 侧有 `.bak` / `.DS_Store` / 路径事故产生的嵌套重复目录。缓解：同步时按排除清单过滤；L3 侧垃圾另行清理
- **R6 机制重复**：与 S6 已有 harness 重复造轮子。缓解：明确复用，只新增数据集格式
- **R7 发现机制选型未定**：manifest vs 索引路线未定。缓解：T-H24/T-H25 只做 manifest（低风险），索引策略单独立项

**依赖**
- T-H26 ~ T-H28 依赖 S6 已交付的 benchmark harness（已在 main）
- T-H30 依赖 T-H29 的 schema
- T-H32 依赖宿主浏览器能力，暂不可排期

---

## 当前进展

- 2026-10-22：完成代码级现状核查，产出设计提案 `docs/architecture/harness-review-and-runtime-evidence-design.md`
- 2026-10-22：确认 Phase 8 的 6 个任务全为文档层，生产端为空；确认 L1 有 15 个 skill 缺 `SKILL.md`、L1 无 `skill-index.json`
- 2026-10-22：完成 PR-Agent 形态评估（MIT / $0 软件费 / 可接自有模型），结论为不作为 core 依赖，仅在 P-001 预留 external backend 接口
- 2026-10-22：`architecture-guard` 自动审计通过（2085 个源文件，0 违规）
- 2026-10-22：实证 L3 边界检查为 `scope: L3` 标记驱动，复制本批 15 个 SKILL.md 不触发该门禁；且这 15 个不引用任何 L3-only 规则。据此把 T-H24 的风险从「内容越界需重写」修正为「仅需修 1 处下游死链」
- 2026-10-22：提案成文，待批准后按 M1 → M2 → M3 推进
- 2026-10-22：追加 L1↔L3 文件集对等核查，发现 5 处实现文件缺失——`vcs-pr` 与 `maturity-tracker` 缺入口文件导致 skill 在下游**完全不可用**（而 L1 的 `config/vcs.yml.example` 正在教用户使用 `vcs-pr`）。据此把 P-003 从「补 manifest」升级为「修分发完整性」，门禁从一条扩展为三条（新增文件集对等性），并调整 T-H24/T-H25 拆分为 a/b/c
- 2026-10-22：T-H24 完成——同步 15 个 SKILL.md + 5 处实现文件，清理分发垃圾，修掉 `runtime-evidence` manifest 的 2 处死链（指向未分发的 `docs/` 与 `workflows/`）
- 2026-10-22：T-H25 完成——新增 `scripts/check-l1-distribution.js`（manifest 完整性 / 文件集对等性 / 链接有效性三条检查，分发集以各自 git index 为准），接入 `pnpm check:l1-distribution` 与 CI；反向验证 8 项测试全过
- 2026-10-22：M2 完成——契约统一与生产端补齐。`verification-summary.json` 原有两个生产方且取值空间互斥（init 写 `not_run`、generate-summary 写 `healthy/warning/critical`），下游 telemetry 只认 `pass/fail`，因此**信号从未被消费**。现统一为：`overall_status` 归验证侧（`pass`/`fail`/`partial`/`not_run`），仓库健康度移到 `repo_health_status`/`repo_health_score`，两个生产方各自只写自己拥有的字段、互不覆盖
- 2026-10-22：M2 落地第一个真实 API 层数据集 `benchmarks/runtime-evidence/event-bus/`（event-bus CLI 发布→读回，1 case / 6 断言），reference = 10000 bp、noop = 1666 bp；新增 `scripts/runtime-evidence-runner.cjs` 复用 S6 引擎与 bp 口径，只换输出契约
- 2026-10-22：M2 打通 `/ship` CLEAN 的阻断能力：`phase-gate/scripts/gate.js` 新增 `runtime_verification` 检查——`fail` 阻断、`partial`/`not_run` 明确告警。此前 CLEAN 只判 `self_check_report`（advisory），**从不读** `verification-summary.json`，阻断能力在机械层实际为空
- 2026-10-22：M1 验证期间发现并行负载下 fork/exec 会被拒（EAGAIN/ENOMEM），子进程根本没启动的失败形态与产品缺陷无法区分。抽取公共 `tests/helpers/spawn-retry.js`，只在「进程从未启动」这一类失败上做有界重试，跑起来并非零退出的结果一律不重试
- 2026-10-22：M3 T-H29 —— 发布 `guided-review-finding.schema.json`（与 artifact group 定义逐字段一致）。**修掉一个此前从未被发现的真 bug**：既有 `guided-review.schema.json` 的 `summary` 写了 `additionalProperties:false` 却没写 `properties`，导致**任何文档都无法通过校验**——这份「已发布 schema」从来没有真正约束过任何东西。修好后既有的真实历史产物能通过校验，反向验证证明旧定义确实不可满足
- 2026-10-22：M3 T-H29 —— 仓库零 npm 依赖，`ajv` 不可用。新增零依赖 JSON Schema 子集校验器，且**遇到未实现的 keyword 报错而非忽略**：默默忽略会让一份坏 schema 看起来像好 schema
- 2026-10-22：M3 T-H30 —— 落地 builtin reviewer backend。核心是**产出与判定分离**：finding 谁产出都行，但校验不外泄，每条 finding 进 artifact 前要过 schema、changeset 归属、文件存在性三关。丢弃从不静默，原因写进 diagnostics
- 2026-10-22：M3 T-H30 —— external backend 只预留接口，不提供实现、不引入依赖；adapter 只能提议 finding，无法绕过任何一条校验（已用测试证明：adapter 提出的越界 finding 同样被拒）
- 2026-10-22：M3 T-H31 —— S6 引擎新增 `finding_present` / `finding_absent` / `artifact_schema_valid` 三种断言，落地真实历史缺陷数据集。区分度梯度：reference 10000 bp、lenient 5172 bp、noop 0 bp。`lenient`（不校验的审查器）证明 absent 断言有牙齿
- 2026-10-22：M3 T-H31 —— 判定结果进入 GitHub job summary。门禁只写 JSON 文件的话，读 CI 的人看不见那个数字
- 2026-10-22：M4 T-H33 —— 补上 L1/L3 **内容**对等门禁（M1 只管文件集，不管内容）。全量扫描 75 个实现文件，10 个内容不一致。查出两个真问题：L1 的 secrets skill **是坏的**（index.js 引用 REDACT_TOKEN，L1 的 redact.js 没导出），以及 **L1 分发面保留着已修掉的 `--account` 越权漏洞**
- 2026-10-22：M4 T-H33 —— 漂移是**双向**的：7 个文件 L3→L1 同步，但 `hooks/claude-code-transcript-link-reporter.sh` 的 L3 版硬编码了 `/Users/xueyq` 机器路径、`plugins/graphify/scripts/post-commit-update.js` 的 L3 版是重复的独立实现 —— 这两条要 **L1→L3**。同步方向由证据决定，不由「L3 是真相」的假设决定
- 2026-10-22：M4 T-H33 —— 门禁只对**实现文件**要求逐字一致。文档按语言差异化、运行时状态在 L1 是模板在 L3 是活记录，这两类逐字比对只会让门禁喊狼来了，而一个喊狼来了的门禁会被无视。豁免必须带理由，且豁免失效会被报出来
- 2026-10-22：M4 T-H33 —— 清理 L3 侧垃圾：25 个 `.bak`/`.bak.prev` 与两处路径事故产生的嵌套重复目录（`skills/secrets/secrets/`、`skills/vcs-pr/vcs-pr/`，逐文件比对确认是旧版残留）。M1 当时把这条账留到「另行清理」，现在清掉
- 2026-10-22：M4 T-H33 —— **门禁按分发层扩展后才看清全貌**：`cortex-agent init` 是「共享层打底 + 语言层覆盖，语言层赢」，所以只查 `_shared` 会漏掉即将被覆盖层发出去的旧副本。检查面从 75 个实现文件扩到 348 个，一轮就抓出 20 处 zh/en 层漂移
- 2026-10-22：M4 T-H33 —— **同步方向是双向的，且「L3 是真相」是错的假设**：en 层的 vcs-pr 更新、zh 层的 management-api 反而是坏的（不认识 `task-state` 投影）、L3 自己的 runtime-continuity 缺 `--project` 的 fails-closed 安全校验。每处的方向都由 diff 证据定，不预设
- 2026-10-22：M4 T-H33 —— 修 L3 的 runtime-continuity 缺口（fails-closed + `exists` 契约）后，四个副本逐字一致，37 项 `--project` 解析测试全绿
- 2026-10-22：M4 T-H33 —— 自己的同步一度**越界**：把 L3-only 的 `scripts/` 与 zh 层原本没有的 `secrets/`、`vcs-pr/` 新增进层里，等于改变了分发面结构。已回退为「只同步该层原本就有的文件」，新增文件由文件集对等检查负责

