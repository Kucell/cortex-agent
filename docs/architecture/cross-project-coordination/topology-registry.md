# Project Topology Registry (P-001)

> 状态: active — 实施分支 `feat/cross-project-topology-registry`
> 提案: `.agent/plans/proposals/projects/cross-project-coordination/proposals/P-001-cross-project-topology-registry-proposal.md`

## 1. 目标

`.agent/topology/projects.json` 是 cortex-agent 与外部 project 之间身份、能力与可达关系的唯一注册表。

设计约束：

- **不假设固定仓数**：注册表不得假设固定双仓或固定五仓；peers 是开放列表。
- **不承载业务依赖 DAG**：业务依赖属于 Composite Workspace 实例；Topology Registry 只负责解析稳定 `project_id` / `topology_ref`。
- **role 不是唯一身份**：相同 role 可由多个项目声明，禁止用 role 定位项目。

## 2. Schema

```json
{
  "schema_version": "1.0",
  "self": {
    "project_id": "cortex-agent",
    "host_root": "/path/to/cortex-agent",
    "primary_branch": "main"
  },
  "peers": [
    {
      "project_id": "SamHMI",
      "host_root": "/path/to/SamHMI",
      "primary_branch": "main",
      "roles": ["desktop", "consumer"],
      "capabilities": ["coordination", "bridge-consumer"],
      "topology_ref": "SamHMI@main",
      "bridge_subscriptions": ["task.state_changed", "decision.resolved"]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `project_id` | ✅ | 稳定唯一身份；peers 内禁止重复 |
| `host_root` | ✅ | peer 项目在本机的绝对路径 |
| `primary_branch` | ❌ | peer 主干分支名 |
| `roles` | ❌ | 角色标签（非唯一身份） |
| `capabilities` | ❌ | 能力声明（如 `bridge-consumer`） |
| `topology_ref` | ❌ | `<project_id>@<branch>` 形式的引用别名 |
| `bridge_subscriptions` | ❌ | 建议订阅的事件类型（信息性） |

## 3. 模块 API (`lib/topology/`)

| 函数 | 说明 |
|------|------|
| `topologyPath(root)` | 注册表绝对路径 |
| `readTopology(root)` | 读取；文件缺失时返回默认 self + 空 peers |
| `writeTopology(root, data)` | 校验后原子写入 |
| `registerPeer(root, peer)` | 追加 peer（校验 + 查重） |
| `deregisterPeer(root, id)` | 按 project_id 移除 |
| `findPeer(topology, id)` | 精确匹配 project_id |
| `resolveTopologyRef(topology, ref)` | 解析 `Project@branch` 或裸 project_id |
| `validateTopology(data)` / `validatePeer(peer)` | 结构校验，返回 `{ ok, errors[] }` |
| `initSelf(root, opts)` | (P-001A) 声明 self 身份；若 projects.json 已存在且 self.project_id 与新 id 不同且无 `--force`，返回 errors。已存在且 id 相同视为幂等刷新 |

写入采用 `tmp + rename` 原子语义；目录不存在时自动创建。

## 4. CLI

```text
cortex-agent topology init <project_id> [--host-root <path>] [--branch <name>] [--force] [--json]
cortex-agent topology list [--json]
cortex-agent topology show <project_id> [--json]
cortex-agent topology register <project_id> --host-root <path>
    [--branch <b>] [--role <r>] [--capability <c>] [--topology-ref <ref>] [--json]
cortex-agent topology deregister <project_id> [--json]
cortex-agent topology help
```

退出码：`0` 成功，`2` 参数/校验错误，`3` 运行时错误。

### 4.1 `init` — 声明自我身份 (P-001A)

需在项目根执行。 `host_root` 与 `branch` 可省略，默认取 `cwd` 与 `git rev-parse --abbrev-ref HEAD`，git 不可用时回退到 `main`。 已存在 self 且 id 不一致但未传 `--force` 时返回 exit 2 且不落盘。

## 5. 与 Event Bridge 的集成 (P-003)

`bridge` CLI 支持用 `--topology-ref` 替代手工传 `--source` / `--source-root`：

```bash
# subscribe: 从注册表解析 peer 的 project_id 作为订阅源
cortex-agent bridge subscribe --topology-ref SamHMI@main --types task.state_changed

# sync: 从注册表解析 peer 的 host_root 作为源 outbox 根目录
cortex-agent bridge sync --topology-ref SamHMI@main
```

解析规则：

- `--topology-ref Project@branch` 按 `@` 前缀取 project_id 精确匹配 peers。
- `--topology-ref Project`（无 `@`）等价于裸 project_id 匹配。
- 未注册的 ref → exit 2 `INVALID_USAGE`。
- `subscribe` 同时给出 `--source` 且与解析结果冲突 → exit 2。

P-002/P-003 在 handoff / bridge event 中仅透传 `topology_ref` 字符串，不依赖本注册表的解析能力（弱依赖）；P-004/P-005 需要注册表先到位（强依赖）。

## 6. 测试

| 文件 | 覆盖 |
|------|------|
| `tests/topology/topology-registry.test.js` | 读/写/校验/注册/注销/解析（20 cases） |
| `tests/topology/bridge-topology-integration.test.js` | `bridge subscribe/sync --topology-ref` 集成（6 cases） |

运行：

```bash
node --test tests/topology/*.test.js
```
