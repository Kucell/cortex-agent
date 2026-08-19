# P-001：Token Metering and Ledger

> **状态**: `approved`（shadow measurement，仅由 `D-TCP-003` + `D-TCP-004` 授权；DSH 作为第三个 governed Host 由 D-TCP-004 批准接入）  
> **目标**: 把“估算选择量”和“Host 实际用量”分开，建立可审计 Token 账本。

## 1. 当前问题

现有 `runs tokens` 能接收 input/output/cache usage，但当前仓库非测试 Run 没有 `token_usage`；context trajectory 的 Host usage 仍为 `unknown`。因此 Dashboard 具备展示代码，却没有生产闭环。

## 2. 数据契约

新增版本化 `token-attempt`，作为 Run/Session/Operation 的 evidence，不成为新状态 owner：

```jsonc
{
  "schema_version": "1.0",
  "attempt_id": "TA-...",
  "correlation": { "task_id": "T-...", "run_id": "R-...", "session_id": "S-...", "operation_id": "OP-..." },
  "host": { "profile_ref": "HOST-...", "adapter_version": "...", "model": "..." },
  "plan": { "policy_revision": "sha256:...", "estimated_selected_tokens": 1200 },
  "render": { "status": "confirmed|unavailable|unknown", "digest": "sha256:..." },
  "usage": {
    "status": "confirmed|partial|unknown",
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "reasoning_tokens": "unknown",
    "cost_reported": null,
    "source": "host-receipt"
  },
  "privacy": { "contains_prompt": false, "contains_source": false }
}
```

## 3. 账本语义

- append-only event；按 `attempt_id + receipt_id` 幂等。
- `estimated_*` 与 `host_reported_*` 永不合并为一个字段。
- 支持 `reserve -> commit | release | expire`，为 P-004 防并发超卖提供基础。
- 聚合维度：project/task/run/session/host/agent/model/policy revision。
- 大明细按日分段，Management API 提供 focused projection，Dashboard 不扫全量正文。

## 4. API

```text
runs tokens receipt --attempt-id ... --source ... --payload-json ...
query token-usage --task-id ... --from ... --to ... --group-by host|model|policy
query token-attempts --run-id ... --status unknown|partial|confirmed
```

旧 `runs tokens` 保持兼容，内部规范化为 receipt；Phase 1 不迁移历史数据。

## 5. 隐私与边界

- 不保存 prompt、输出、tool 参数、文件正文、密钥和私有绝对路径。
- 仅存 URI、digest、计数、状态和短 reason code。
- Host 不提供字段时为 `unknown`，不从私有 transcript 反爬。
- 成本优先使用 Host 自报；价格表推算必须标记 `estimated_cost`。

## 6. 验收

- 两个 Host 各至少 100 个非测试 receipt，幂等重放不重复计费。
- selected/rendered/consumed/measured 查询结果不混用。
- 缺字段、乱序、重复、重试、超大数、脏字符串和时钟偏移测试通过。
- 全部 receipt 默认不含 prompt/source/secret。
