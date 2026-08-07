# 上下文优化 v2 架构沉淀（M-019）

> Mission: M-019 · 提案: `cortex-agent-context-optimization-v2-proposal.md` · 状态: COMPLETE
> 工作树: `feat/context-optimization-v2` @ `CONTEXT-OPT-V2` · 基于最新 `origin/main`

## 1. 背景与问题空间

`context-budget`(L0/L1/L2 三级摘要)已落地,但 10B/月 token 消耗的真实大头在三类「跨调用 / 跨轮 / 跨 agent」的固定成本:

| 编号 | 问题 | 量级(提案 §4.4) | 归属 |
| :--- | :--- | :--- | :--- |
| A | 跨轮历史回放(每个新请求重发全部旧对话) | -7.6% | P2 / 会话压实 |
| B | Prompt Cache 命中率偏低(稳定前缀未显式隔离) | +3.3% | P1 / 前缀缓存 |
| C | fan-out 重复(多 agent 各自重投 system+rules+refs 固定前缀) | -12% | C2 / 共享上下文 |
| C1 | 跨模块引用去重(core-principles 与 v2 重复注入) | 消除 ~554t | P3 / 引用去重 |
| B5 | 规则分级注入(把 `fixed=3000+5000` 改为 L0 常驻 + 其余降 L1/L2) | 轻量增强 | P1 / 规则分级 |

v2 的全部增量**纯加法**:不重写 context-budget 预算模型,不改动 select.js / build-l0l1.js 已验证逻辑,仅「新增脚本供其调用」。

## 2. 组件总览

```
.agts/skills/context-budget/scripts/
├── prefix-builder.js    # P1 稳定前缀区块构造（从 select.js 抽取）
├── cache-break.js       # P1 cache epoch 内容哈希漂移检测
├── cache-config.yml     # P1 稳定前缀组成 + epoch 配置
├── rule-tier.js         # P1 规则稳定性分级（L0/L1）
├── compact.js           # P2/§10.2 会话历史压缩
├── compact.schema.json  # P2 compact 产物 schema
├── dedup-refs.js        # C1 引用级精确哈希去重
├── select.js            # 改造：调用 prefix-builder / rule-tier / dedup-refs
└── build-l0l1.js        # 改造：调用 compact(§10.2) / dedup-refs(--dedup)

.agent/handoffs/
├── handoff.schema.json        # 扩展 optional shared_context_ref（C2）
└── scripts/handoff-protocol.js# shared_context_ref 路径校验（C2）

.agent/sub-agents/
├── shared-context.schema.json       # C2 共享上下文 schema
└── scripts/gen-shared-context.js    # C2 生成并发布共享上下文到 Artifact Bus

.agent/references/agent-config.md    # B4 改造：core-principles 改引用式（依赖 canonical block）
```

## 3. 设计要点

### 3.1 P1 前缀缓存（prefix-builder + cache-break + rule-tier）

- `select.js` 在 `buildManifest` 内调用 `buildPrefix`:把命中 `cache-config.yml` 的 `pinned_prefix` + `stable_prefix` 条目聚成 `prefix_region`(稳定、可缓存),其余任务相关 token 串留作 `suffix_token_string`。
- `cache-break.js` 对 `prefix_region` 排序后的 URI 集合做 SHA-256,与上一轮持久化哈希比对;内容变化 / `cache_version` bump 时输出 `cache_break:true`,提示 host 丢弃旧 KV 缓存。
- `rule-tier.js` 为每条引用算 `stability_score` 分级 L0(常驻前缀)/ L1(按需),驱动 `fixed` 区从「3000+5000 全常驻」改为「core-principles 等 L0 小体积常驻 + 大体积降 L1/L2」。

> 仅做「观测 + 显式分隔」,不假定 host 支持 prompt caching——host 可用可不用,不破坏既有注入。

### 3.2 P2/§10.2 会话历史压实（compact.js + history.jsonl）

- `history.jsonl` 写入范式(append-only,原子 rename):每行 `{ts, role, kind, text}`,`kind ∈ {message, tool_call, tool_result, decision, error}`。
- `build-l0l1.js --history <file>` 在每轮 build 后追加 `tool_result` 事件并生成 `compact.json`(结构化摘要:保留 `decisions` / `open_threads` / 近 8 轮原文,超阈值旧轮压成摘要)。
- 不假设能改写 host 原始 transcript——压实对象为 agent 自管可复用上下文(§10.2 倒置原则)。

### 3.3 C1 引用去重（dedup-refs.js）

- 对候选引用正文(优先 l1,回退 l2→l0)做精确 SHA-256;相同 hash 只注入一次(canonical block),其余处用 `(see #ref-<hash8>)` 引用。
- 仅精确去重,**不做模糊合并**(避免误并 core-principles 与 v2 这类语义相近但应保留的条目)。
- 实测:`context-index.json` 中 `core-principles` == `core-principles-v2` 精确命中,合并为 1 canonical,节省 **546t**(与提案 §4.5 验收一致)。

### 3.4 C2 多 agent 共享上下文（shared_context_ref + Artifact Bus）

- `gen-shared-context.js`(main agent 调用)生成 read-only 共享上下文(system + rules 分级 + L0 + L1 + 选中 L2),经 **Artifact Bus** 落到 `.agent/artifacts/<task-id>/shared-context.json`。
- handoff `shared_context_ref` 指向该文件;sub-agent 经引用复用稳定前缀,不再各自重投,节省 `(N-1) × ~8–15k t`。
- `handoff-protocol.js` 强制校验 `shared_context_ref` 须落在 `.agent/artifacts/` 下(防路径穿越),且**不动**数值型 `context_budget_hint`(二者语义并存)。

## 4. 集成缝合点（提案 §10）

| 缝合点 | 机制 | 降级 |
| :--- | :--- | :--- |
| §10.1 前缀标记 | `select.js` 输出 `prefix_caching` 字段 | host 不用 cache 也不破坏注入 |
| §10.2 历史压缩 | `build-l0l1.js --history` 写 `compact.json` | agent 自读 history.jsonl,hook 仅加速 |
| C2 共享 | gen-shared-context + handoff.shared_context_ref | sub-agent 缺引用时回退独立注入 |

## 5. 验证结果（自举 + 对照跑分）

见 `M-019/mission-plan.md` 的 *Bootstrap Validation* 与 *对照跑分* 两节。关键实测:

- C1 去重:546t 实测节省(L0 级)
- 全链路脚本零依赖、仅 Node 内置模块,可在本工作树直接运行
- C2 共享上下文经 Artifact Bus 发布成功,handoff 校验生效

## 6. 后续 / 不在范围

- host 端 prompt caching 真实命中率需 host 侧配合观测(本 mission 仅产出可观测结构)
- token-usage 采集管线、Artifact Bus / Handoff 既有 schema 均未改写
- 合并目标为 `origin/main`,需用户授权后 `/commit` + PR
