# Privacy-Preserving Friction-Assisted Learning（P-003）

> **状态**: shipped（2026-09-11 批准 D-TKR-003；M-003A 合并 99d502b，M-003B 合并 6e9b7ba）
> **版本**: v1.0
> **关联**: [P-003 提案](../../.agent/plans/proposals/projects/team-knowledge-recall/proposals/P-003-friction-share-learnings-proposal.md) · [M-038 MS-001](../../.agent/missions/M-038/milestones/MS-001.md)
> **位置**: `lib/friction/signal.js` · `lib/runtime-adapters/capability-contract.js` · `templates/_shared/.agent/skills/friction/`

---

## 1. 背景与动机

沉淀团队经验（share-learnings）之前，需要一个 host-aware、脱敏、可审计的摩擦信号
（friction signals）来辅助人类判断。P-003 不假设 runtime-continuity 拥有用户消息、
工具拒绝或 PostToolUse 全量事件：缺失能力必须保守降级为 `not_observed`，
绝不根据缺少数据推断“无摩擦”。

## 2. 设计（两阶段）

### M-003A — Friction Signal Contract（已合并 99d502b）

1. `HostCapabilityDescriptor` 扩展三个可选字段（闭集、fail-loud、缺失即合法）：
   - `friction_signals`：6 个信号 → observability（`observed|derived|not_observed|not_supported`）
   - `friction_lifecycle_events`：宿主声明的生命周期事件名（上限 32）
   - `redaction_level`：`aggregate_only|full`
2. 规范脱敏信号事件（closed schema，`additionalProperties:false`）：
   `{schema_version, signal_id: FS-<uuid>, session_id, host, type, observability, count, occurred_at, evidence_ref, redaction}`
   - 任何 prompt / 用户消息 / 命令参数 / 工具输出 / 凭据 / 文件内容 / 自由文本纠错都禁止进入事件。
   - 通过自有 runtime writer 以 append-only JSONL 写入 `.agent/runtime-evidence/friction/signals.jsonl`；
     不解析宿主终端输出，不发明私有 events.jsonl。
3. 宿主矩阵（冻结）：DSH（tool_failed/retried/lifecycle_stop=derived，其余 not_observed）；
   Pi absent（全 not_supported）。缺信号的 adapter 不产出事件。

### M-003B — Score and Human-Gated Draft（已合并 6e9b7ba）

仅在 M-003A 有两宿主证据后实现：

1. `friction-score` 读取规范脱敏事件，输出**非持久**评估 `{score, coverage, signals, recommendation}`；
   coverage 必须显式，缺失/不支持的信号绝不等于零摩擦。
2. recommendation 永不自动创建草稿；`/share-learnings` 需显式用户确认，
   仅确认后写 `/tmp/exp-<session-id>-draft.md` 并展示 diff。
3. FrictionAssessment 状态机 `observed → assessed → suggested → user_approved|dismissed|expired`，
   终态保留，append-only journal 带 actor + 脱敏 evidence_ref。
4. 本提案不含自动 upvote 或自动 promote（独立未来决策）。

## 3. 隐私边界（硬规则）

- aggregate-only 模式：事件/评估/journal 只含计数、类型、时间戳、不透明 evidence_ref、稳定 id。
- 脱敏由 closed schema 强制：任何自由文本字段都不存在，适配器必须在调用校验器之前剥离自由文本。

## 4. 验证

- MS-001：7/7 断言 PASS（闭集校验、redaction fixture、append-only 写入、宿主矩阵、零回归、skill 文档、drift）；
  119/119 测试；全量 runtime-adapters 回归对比 main 零新增失败。
- MS-002：VC-008..VC-012 + VC-DRIFT-002（见 [validation-contract-ms002.json](../../.agent/missions/M-038/validation-contract-ms002.json)）。

## 5. 范围边界

- 不做：votes / auto-upvote / auto-promotion / dashboard / digest / 跨仓库聚合。
- 不做：自动草稿、自动提交。
- 不修 runtime-continuity 不存在的 telemetry；事件只来自自有 writer。
