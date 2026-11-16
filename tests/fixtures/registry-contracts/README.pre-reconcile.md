# `.agent/agents/` — 项目级 agent registry

> **Schema**: [`agent.schema.json`](./agent.schema.json) · **Sample**: [`sample.json`](./sample.json)

## 受管注册与启停 / Managed registration and activation

`agent register/enable/disable` 管理本目录中的静态能力记录。它们不创建或接管
Task、Session、fileOwnership、Lease，不启动 Agent 或 Runtime。生产源码写入仍需
单独核对已分配 Task、匹配的真实 Session、精确文件范围和有效 fencing Lease。
Registry Maintainer 是项目 Owner 显式授权的维护者；不是任意 coordinator，
GitHub Issue 的创建、指派、评论和动态 check-in 也不产生静态权限。

These commands manage static capability records only. They never start a host
or write Task/Session/Lease state. Static eligibility does not authorize a source
write: the assigned Task, real Session, exact file ownership and current fenced
Lease remain separate checks. Issue assignment and runtime check-in confer no
Registry authority.

### Owner 引导 / Owner provisioning

Owner 先在**物理项目根目录**独立审定并创建 `.agent/config/agent-registry.json`。
本命令不创建或修改策略，不会让首个调用者自动成为 Owner。缺少策略时拒绝操作。
POSIX 下文件必须归当前 OS 用户所有，且不可被 group/world 写入（建议 `0600`）。
`local_user` 必须等于 `require("node:os").userInfo().username` 的实际结果。
策略、`.agent`、`config`、`agents` 和已有目标文件不能是符号链接；使用 worktree
共享 `.agent` 时，请对其真实项目根目录操作，而不是绕过链接校验。

The owner separately provisions and reviews this local policy. The public writer
never edits it or bootstraps itself. This is **local_same_user** trust: OS account
ownership is the authority; actor/session arguments are policy-checked audit
selectors, not authenticated remote identities. It cannot defend against malicious
processes under the same OS account or prove independent review by itself. A
copied username or a self-reported model is not provider authentication.

示例为说明结构的占位值；先从宿主取得真实 subject/session，再由 Owner 验证并填写。
`identity.subject` 是真实 provider/adapter 宿主身份（可用真实原生会话标识），不接受
Task/Lease/check-in 标识替代。实现者与审查者应使用不同真实宿主身份和 Session，
不能给同一 subject 换 role 来制造独立审查者。角色、模型和能力由策略授予，不从
注册请求采信；`projects` 单独只是订阅字段，不能产生授权。

```json
{
  "schema_version": 1,
  "owner_id": "project-owner",
  "local_user": "actual-local-os-user",
  "project_id": "example",
  "maintainers": [
    { "actor_id": "owner-maintainer", "session_id": "verified-maintainer-session", "projects": ["example"] }
  ],
  "grants": [
    {
      "identity": { "provider": "openai", "adapter_type": "codex", "subject": "verified-native-implementer-session" },
      "role": "implementer", "model": "owner-verified-model",
      "capabilities": ["code_generation", "test_writing"],
      "projects": ["example"], "owned_files": ["src/example.js", "tests/example.test.js"]
    },
    {
      "identity": { "provider": "openai", "adapter_type": "codex", "subject": "verified-independent-review-session" },
      "role": "reviewer", "model": "owner-verified-model",
      "capabilities": ["code_review"],
      "projects": ["example"], "owned_files": ["src/example.js", "tests/example.test.js"]
    }
  ]
}
```

All grant projects must be authorized for the maintainer, and each grant must
include the policy's project. `owned_files` contains exact repository-relative
files, not globs. For a reviewer these are review scope, not write permission.
Implementers require `code_generation` and `test_writing`; reviewers require
`code_review`. Coordinators cannot claim those implementation/review capabilities.
The provider identity and model are owner-verified metadata; this command does
not contact a provider or attest an online session. Never put credentials in policy.

### 命令 / Commands

```bash
cortex-agent agent register --project . \
  --identity-json '{"provider":"openai","adapter_type":"codex","subject":"verified-native-implementer-session"}' \
  --actor owner-maintainer --session verified-maintainer-session --json

# 使用 register 返回的 agent_id；无需编造 ID。
cortex-agent agent enable <returned-agent-id> --project . \
  --actor owner-maintainer --session verified-maintainer-session --json
cortex-agent agent discover --project . --managed-only --role implementer --json
cortex-agent agent disable <returned-agent-id> --project . \
  --actor owner-maintainer --session verified-maintainer-session --json
cortex-agent agent discover --project . --managed-only --include-disabled --json
```

The ID is the full SHA-256 of the canonical `[provider, adapter_type, subject]`
tuple, prefixed with `agent-`. Role/model/project changes do not generate a second
identity. Registration starts disabled; duplicate registration never replaces an
existing record. Enable validates the current owner grant against the stored
profile; changing that grant requires explicit owner migration rather than a
silent role/scope update. `projects set` refuses managed profiles. Disable remains
available after removing a grant, provided the maintainer still owns the record's
project scope. Changing `owner_id` requires an explicit migration.

`identity`, `enabled` and `registration` are additive schema-v1 fields, required
together for managed records. Each lifecycle change appends an audit event with
actor, session, time and policy digest to the same atomically published record.
Repeated enable/disable of the current state is a no-op. Discovery includes the
exact identity, enabled state, model, scope, capabilities and audit journal;
disabled records require `--include-disabled`. Invoke, dispatch-execute and
dispatch-batch reject disabled managed records through their shared reader.
Legacy records retain their original eight-field discover projection and old
invoke behavior; the new managed fields are absent. They are not evidence of
an owner-authorized managed grant.
Use `--managed-only` when checking the new gate; `sample.json` is only a sample.

Audit capacity reserves the final disable event. At the capacity boundary a new
enable is refused with `ERR_REGISTRY_AUDIT_CAPACITY`, while an already saturated
10,000-event enabled record may append one recovery disable (10,001 total).
Repeated disable remains a no-op. No history is truncated; the owner must archive
and migrate explicitly before further enable operations.

The writer rejects existing symlinks and serializes cooperating writes with
`.registry-write.lock`. Atomic no-replace creation protects duplicate IDs; atomic
replacement preserves complete records during enable/disable. Validation/auth
failures publish no profile. A post-publication readback failure returns
`ERR_REGISTRY_READBACK` with `committed:true`: inspect the exact file before
retrying. Cleanup errors preserve the original error and publication state,
and include `cleanup` plus `remaining_artifacts`; an ambiguous lock close retains
the lock for owner recovery. A crashed writer leaves a fail-closed lock; the owner must verify its
PID is no longer active and preserve evidence before removing that lock. No
automatic stale-lock recovery or runtime Lease takeover occurs.

First deployment is deliberately separate from framework source repair: install
the reviewed package, let the owner provision the real project policy, register
and independently verify implementer/reviewer, then use the existing coordination
workflow to bind Task/Session/exact fileOwnership and fenced file Leases. Rebind
only refreshes existing same-owner/same-scope references. No downstream Runtime
activation is implied by successful registration.

## 用途

项目级 agent registry。**所有 agent 都要登记**,code 模式(local agent registry)和 general 模式(external adapters 入口)共用。

参考 RFC `general-mode-design.md` §6.4 + §6.7(automatic mode 推断):

```text
.agent/agents/
├── registry.yaml              # 项目级 agent 注册表(主入口)
├── capabilities/              # 每个 agent 的能力声明
│   └── {agent_id}.yaml
├── external/                  # 外部 agent adapter(v1.11 新增)
│   ├── claude-code.yaml
│   ├── cortex.yaml
│   ├── codex.yaml
│   └── codey.yaml
└── credentials/               # 凭证代理(接 secrets skill)
    └── {credential_ref}.yaml
```

> MS-001 阶段只发布 schema(单个 agent 形状)+ sample;`registry.yaml` 的合集由 MS-002/003 落(自动 mode 推断 + register CLI)。

## 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `schema_version` | int (=1) | ✓ | |
| `agent_id` | string | ✓ | 稳定 id |
| `role` | enum | ✓ | `implementer` / `coordinator` / `reviewer` / `researcher` / `documenter` / `memory-curator` / `conversation-curator` / `user` / `external` |
| `model` | string | ✓ | 模型标识 |
| `task_id` | string | | 当前任务 |
| `mission_id` | string | | 当前 mission |
| `session_id` | string | | 当前 session |
| `started_at` | date-time | ✓ | |
| `last_heartbeat` | date-time | | |
| `status` | enum | ✓ | `running` / `paused` / `completed` / `failed` / `handed_off` / `stale` / `expired` |
| `owned_files` | string[] | | worktree ownership |
| `pending_artifacts` | string[] | | 未提交产物 |
| `capabilities` | string[] | | self-declared 能力 |
| `external.adapter_type` | enum | | `claude-code` / `cortex` / `codex` / `codey` / `pi` / `custom` |
| `external.config_ref` | string | | 外部 adapter 配置文件 ref |
| `external.credential_ref` | string | | 凭证代理 ref(接 secrets skill) |

## external/ 段使用(v1.11+)

```yaml
# .agent/agents/external/claude-code.yaml
agent_id: claude-code-user
adapter_type: claude-code
config_ref: .agent/agents/external/claude-code.config.yaml
credential_ref: ~/.cortex/credentials/claude-code
```

## 与其他目录关系

- agent 上线 → 关联 `sessions/S-*.json`
- agent 跑任务 → 关联 `runs/R-*.json`
- agent 跨续接 → 关联 `handoffs/H-*.json`
- agent 完成 → 写 `agents/registry.yaml` 的 event_log(check_out)

## Sample

见 [`sample.json`](./sample.json) —— 真实 `Worker-A-MS001`(MS-001 implementer)。
