# `.agent/agents/` — 项目级 agent registry

> **Schema**: [`agent.schema.json`](./agent.schema.json) · **Sample**: [`sample.json`](./sample.json)

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
