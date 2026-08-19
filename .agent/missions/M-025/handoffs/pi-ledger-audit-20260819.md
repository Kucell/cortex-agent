# M-025 MS-002 VC-011 Ledger Audit — Pi Receipt 缺席根因

> **Audit date**: 2026-08-19T03:24Z
> **Auditor**: Root independent review (no Pi worker participation)
> **Trigger**: User question "为什么等 7 天" + check on P-005 §5 Measurement Gate state
> **Finding severity**: Medium (governance) / Low (security)

## 1. 问题陈述

P-005 §5 Measurement Gate 要求 "两个 Host、连续 7 天、每 Host ≥100 非测试 receipt"，但截至本审计：

```
$ node query-token-attempts --stats
receipt_count: 21,565 (pre-DSH)
by_host (LLM provider):
  openai: 12,353 (Codex → openai)
  minimax-cn: 6,635 (Pi → minimax-cn)
  volcengine: 1,815 (Pi → volcengine)
  combo: 224 (Codex → combo)
  qianwenai: 126 (Pi → qianwenai)
  deepseek: 401 (Pi → deepseek)
  nvidia: 9 (Pi → nvidia)
  codex: 2 (test-verify fixtures)

attempt_id 前缀:
  ocx-*: 21,563 (Codex agent host)
  test-*: 2 (MS-002 verification fixtures)
  pi-*: 0 (Pi agent host — 完全缺席)
```

注意 `host` 字段是 **LLM provider 名**（openai/minimax-cn/volcengine 等），不是 agent host。但 `attempt_id` 前缀是 agent host 维度的真实指纹。

**关键发现：**
- Codex agent host 贡献 21,563 条真实 receipt（来自 opencodex-usage-sync backfill）
- **Pi agent host 贡献 0 条真实 receipt**（虽然 LLM provider 路由记录显示 Pi 调用了 minimax-cn/volcengine 等，但 agent host 维度没有自己的 receipt 流）

## 2. 根因调查

### 2.1 Pi proxy log 缺失

```
$ ls ~/.opencodex/usage.jsonl    # exists (12.3 MB)
$ ls ~/.openpi/usage.jsonl       # not found
$ find ~ -maxdepth 4 -name "usage.jsonl"  # only opencodex
```

opencodex 代理持续记录 usage.jsonl（包含 Codex agent host 所有 model call 的 provider/requestId/timestamp/usage 详情），而 Pi 代理（如果存在）没有同等日志机制。

### 2.2 MS-002 VC-011 PASS 实际内容

MS-002 milestone 报告原文：

> "VC-011 | PASS | Pi 0.82.1 turn_end 与 Codex 0.146.0 turn.completed 的公开数字 usage envelope 各生成一条 schema/security-valid receipt，并在**临时 MS-001 ledger**中持久化为 2 条"

关键词是"**临时 MS-001 ledger**"。这意味着：

- Pi 的 schema/security 验证成功
- 但**写入了沙盒 ledger，不是项目主 ledger**
- 主 ledger (`/Users/xueyq/myworks/cortex-agent/.agent/token-attempts/`) 因此从未收到过任何 Pi agent host 写入

VC-011 PASS 实际含义：**schema/security 边界正确，**但**不是真实 Pi 生产 receipt 落地**。这是验收口径偏窄——VC-011 标的是"两 Host 都能写"，但只验证了 schema/security 通过，未验证"持续真实流量会持续写入"。

### 2.3 Pi Runtime 是否能写主 ledger？

Pi adapter (`lib/runtime-adapters/pi-adapter.js`) 存在，但：
- `lib/host-adapter/shadow-usage/pi-json-shadow.js` 的 `pi-json` host 已注册到 adapter registry
- **没有任何代码调用 Pi adapter 把 envelope 写入 capture-usage.js → 主 ledger**
- 即使 Pi agent host 运行 governed 任务，它也不会触发主 ledger 写入

这是路径不完整，不是路径存在但坏掉。

## 3. 决策

不修改 MS-002 PASS 历史报告（历史里程碑的 PASS 状态不能 retroactive 降级），但通过以下路径补齐：

1. **DSH 作为第三个 governed Host 立即加入**（见 D-TCP-004 + WP-rsl-dsh-host-shadow-20260819）
2. **Pi 接入路径作为后续 MS-006 工作**，独立 Decision 单独批准（避免把"Pi 接入"和"DSH 接入"打包）
3. **MS-002 PASS 报告追加本审计 handoff** 作为已知事项，让"Pi = 0 主 ledger receipt"成为公开事实

## 4. P-005 §5 当前实际状态

| Gate 条件 | 状态 |
|-----------|------|
| 每 Host ≥100 非测试 receipt | ✅ Codex (21,563) + DSH (832 后置) — 远超满足 |
| 两个 Host | ⚠️ 形式上**满足**（Codex + DSH 都是独立 governed Host），但 Pi 缺席被隐藏 |
| 连续 7 天 | ❌ 当前跨 14 个非空日但有 8 个空缺日，**没有任何7 天连续窗口** |

**结论**：

- 形式上 Codex + DSH 已满足 "两个 Host" 前置条件
- 7 天 consecutive 仍然是真实瓶颈——需要等待连续 7 天的真实流量
- Pi 缺席是 **历史包袱**，不应阻塞 Phase B 进展；按 D-TCP-004 处理

## 5. Pi 接入后续工作（不阻塞当前 DSH 决策）

待未来 Decision 授权：
1. 在 Pi runtime 添加 `turn_end` → `capture-usage.js` 调用桥（参考 opencodex-usage-sync 模式）
2. 验证 Pi 真实 receipt 写入主 ledger
3. 重新跑 MS-002 VC-011 真实流量复测

## 6. 审计 traceability

- **审计发起**: User question "为什么等 7 天" (2026-08-19T03:11Z)
- **数据采集**: `node .agent/skills/management-api/scripts/query-token-attempts.js` 实时查询
- **对照来源**: `.agent/missions/M-025/milestones/MS-002.md` PASS 报告
- **决策 handoff**: `.agent/decisions/D-TCP-004-add-dsh-host.json`
- **Waitpoint 释放**: `.agent/waitpoints/WP-rsl-dsh-host-shadow-20260819.json`
- **DSH readiness**: `.agent/missions/M-025/handoffs/dsh-shadow-host-readiness-20260819.md`