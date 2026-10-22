# Harness Phase 9：审查契约、应用验证证据与 Skill 可发现性

> 状态：进行中（待提案批准）
> 开始日期：2026-10-22
> 设计提案：[`docs/architecture/harness-review-and-runtime-evidence-design.md`](../../architecture/harness-review-and-runtime-evidence-design.md)
> 前置阶段：[`docs/exec-plans/active/harness-phase8-application-legibility.md`](./harness-phase8-application-legibility.md)（Phase 8，文档层已完成，能力层空缺）

---

## 目标

补齐 Phase 8 留下的能力层缺口：让**应用验证**、**异构审查**、**Skill 分发**三条链路各自具备「可执行判定 + 可发现说明 + 生产到判定的机械通路」，并把三者收敛到同一套可复用的机械门禁机制上。

Phase 8 把应用可理解性的**文档层**做完了（6/6 任务已完成），但生产端是空的：`.agent/metrics/verification-summary.json` 恒为 `not_run`，`/ship` CLEAN 的阻断能力实际为空。本阶段补上生产端。

---

## 范围

- **P-003**（M1）：修 L1 分发完整性——补齐 15 个缺失的 skill `SKILL.md`、5 处缺失的实现文件、清理分发垃圾，并新增三条机械门禁（manifest 完整性 / 文件集对等性 / 链接有效性）
- **P-002**（M2）：定义 runtime-evidence 数据集格式，落地第一个真实 API 层验证数据集，把结果接入 `verification-summary.json` 与 `/ship` CLEAN
- **P-001**（M3）：定义 `guided-review` finding schema，落地 builtin reviewer backend，把 finding 纳入 benchmark 机械判定

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

### T-H26 [待办] M2 · 定义 runtime-evidence 数据集格式

- 在 `benchmarks/runtime-evidence/<app>/dataset.json` 落地数据集格式，语义与 S6 的 `benchmarks/agent-review/` 对齐
- 复用现有 11 种断言；候选 = 真实启动命令 / 健康检查 / 端点探测
- 明确**覆盖边界**：API 层只覆盖可机械断言的运行行为，不覆盖渲染/交互断言

### T-H27 [待办] M2 · 落地第一个真实 API 层验证数据集

- 选一个真实可启动的本仓或下游目标
- reference 候选必须 10000 bp；noop 候选必须 < 5000 bp（区分力强制要求）
- 每条断言必须被真实评估，不允许恒真断言

### T-H28 [待办] M2 · 接入 verification-summary.json 与 /ship CLEAN

- 验证执行后写入 `.agent/metrics/verification-summary.json`，`overall_status` 能取到 `pass` / `fail` / `partial`
- `/ship` CLEAN：`fail` 阻断；`not_run` 给出明确告警，不再静默通过
- 沿用 Phase 8 已有的 `docs/reliability/verification-templates.md` 与 `runtime-evidence-integration.md` 作为设计依据

### T-H29 [待办] M3 · 定义 guided-review finding schema

- 发布 finding 的结构化 schema，字段与 `agent-review-benchmark` 的 `guided-review.schema.json` 保持一致
- 不改 `agent-review-benchmark` skill 的「默认不用外部 LLM judge」契约

### T-H30 [待办] M3 · builtin reviewer backend

- backend 形态：把 `/code-review` workflow + `code-reviewer` 子代理的产出收束成合规 finding
- 预留 external backend 接口但不进 core：外部审查器作为可选 adapter 存在，不引入依赖、不进分发

### T-H31 [待办] M3 · finding 纳入 benchmark 机械判定

- builtin backend 产出的 finding 集作为 dataset 参与判定
- 强制区分力：noop finding 集得分显著低于 reference
- 判定结果进入 CI summary

### T-H32 [待办] M4 · UI 层（不排期）

- 依赖宿主浏览器能力；cortex 只定义 `browser-verification.json` 的产出格式与校验
- 宿主能力成熟后单独立项，本阶段不承诺时间

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
- 2026-10-22：M1 验证期间发现并行负载下 fork/exec 会被拒（EAGAIN/ENOMEM），子进程根本没启动的失败形态与产品缺陷无法区分。抽取公共 `tests/helpers/spawn-retry.js`，只在「进程从未启动」这一类失败上做有界重试，跑起来并非零退出的结果一律不重试
