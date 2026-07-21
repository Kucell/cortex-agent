# Token Usage: 统一上报 + Dashboard 可视化

> **状态**: 设计完成(Phase 1)
> **版本**: 1.0.0
> **最后更新**: 2026-07-21
> **提案**: `.agent/plans/proposals/token-usage/cortex-agent-token-usage-proposal.md`(draft → done)

---

## 1. 核心结论(一句话)

cortex-agent 框架**不**主动爬任何 agent host(Claude Code / Cursor / Codex / ...)的私有数据。框架只暴露一个 CLI 契约 `runs tokens` + 一份 dashboard 面板;**每个 host 在自己的 hook / lifecycle 回调里**,把 token 用量推上来。

---

## 2. 设计动机

### 2.1 反直觉的"主动爬"陷阱

直觉做法是让框架读 `~/.claude/projects/<slug>/*.jsonl` 拿 Claude Code 的 transcript、再去爬 Cursor / Codex 的私有存储。问题:

| 反模式 | 后果 |
|---|---|
| 框架读 host 私有存储 | host 改文件路径/格式时框架同步崩;框架承担 N 套 host 数据格式的兼容责任 |
| 用 npm 装 host SDK | 破坏 `bin/cli.js` 零依赖底线;依赖链变深 |
| hook payload 期望拿 token 数据 | **不可行**——Claude Code 的 `Stop` / `SessionEnd` hook payload 不携带 token,这是官方排除项 |
| host 等框架爬 | host 集成就绪时间不可控 |

### 2.2 倒置:framework defines contract, agents push

| 角色 | 责任 |
|---|---|
| 框架 | 定义契约(标准化 schema + 单一 CLI + dashboard);**接收、规范化、聚合、显示** |
| host(Claude Code / Cursor / Codex / ...) | 在自有 hook / lifecycle 回调里调 CLI 把 token push 上来 |
| 用户 | 写一段 10-20 行 hook shell + jq 集成一次,所有 host 都生效 |

**结果**:一个 CLI 入口,所有 host 共用;host 接入是 host 自己的事;框架零 host 适配代码;零依赖守住。

---

## 3. 契约

### 3.1 CLI(单一入口)

```bash
node .agent/skills/management-api/scripts/index.js runs tokens \
  --gate agent | user | mission          # 必填,沿用写门禁
  --source claude-code | cursor | codex  # 必填
  --run-id <id>                          # Phase 1 必填(无全局 token log 兜底)
  --input <N> --output <N>
  --cache-create <N> --cache-read <N>    # 必填,会被 normalize
  [--model <str>] [--cost-usd <N>]
  [--session-id <id>] [--task-id <id>]
```

### 3.2 落点:在 run 文件上挂 `token_usage`

写入 `.agent/runs/<run_id>.json#token_usage`(借助 `run.schema.json` 的 `additionalProperties: true`,**不改 schema**):

```jsonc
{
  "run_id": "...",
  "kind": "implement",
  "status": "running",
  "token_usage": {
    "by_source": {
      "claude-code": {
        "input_tokens": 13,
        "output_tokens": 593,
        "cache_creation_input_tokens": 20099,
        "cache_read_input_tokens": 11893,
        "samples": 2,
        "last_reported_at": "2026-07-21T07:13:25.246Z",
        "last_run_id": "R-..."
      },
      "cursor": { /* 同形态 */ }
    },
    "totals": { /* by_source 的逐项求和 */ },
    "updated_at": "2026-07-21T07:13:25.294Z"
  },
  "relations": {
    "session_ids": ["S-1"],
    "task_ids": ["T-..."]
  }
}
```

每次 push 还**追加一条 `token_usage_reported` 事件**到 `events[]`,让 `eventTimeline` 面板也能看到 token 信号(注释式约定,不收紧 schema enum)。

### 3.3 协议边界规范化(`normalize-token-usage`)

按 `.agent/rules/normalize-input-value.md`,host 上报的字段形态不可控(`3` / `"3"` / `"1,234"` / `"7,29000000"` / `null` / 数组 / 嵌套对象都可能)。所有数值必须先经过单一职责纯函数:

- ✅ 数字原样通过(NaN / Infinity → 0;负数 → 0)
- ✅ 字符串数字:`"42"` → 42
- ✅ 千分位:`"1,234"` → 1234(只接受 `^\d{1,3}(,\d{3})+$` 严格分组)
- ❌ **拒绝** `"7,29000000"`、`"true,false"`、`"1,2,3"`(防御 host `toString()` 拼字符串事故 —— 参见 incident 2026-07-07)
- ✅ boolean:`true` → 1;`false` → 0
- ✅ 数组 / 对象 → 取首个非零递归解释
- ✅ 全部缺失 → 全 0;samples=1

**反模式禁令**(同 `.agent/rules/normalize-input-value.md` §2):`Number(v) || 0`、`Number.isNaN(+v) ? 0 : +v`、`parseInt(v) || 0`、`+v | 0` —— 全部禁止。sink 唯一规范化点。

**测试覆盖**:`tests/normalize-token-usage.test.js` 22 用例(含 incident 2026-07-07 脏字符串防御)。

---

## 4. Dashboard

`agent-dashboard generate.js` 在 `#runtime` 段插入 `Token 用量` 面板(`panel wide`,紧跟 runs 之后):

### 4.1 Status Strip(4 个 metric)

| Metric | 含义 |
|---|---|
| 已上报 Run | 有 token_usage 的 run 数 / 总 run 数 |
| 总输入 Token | `Σ input_tokens` |
| 总输出 Token | `Σ output_tokens` |
| 缓存命中率 | `cache_read / (cache_read + cache_creation)` |

### 4.2 Per-host breakdown 表

| Host | Runs | Samples | Input | Output | Cache Create | Cache Read | Last Reported |

### 4.3 Top runs by effective input

每个 run 一行:run_id + 来源 + input + output + cache_read。

### 4.4 空态降级

无任何 token 上报 → 显示 `暂无 token 上报 — host 未集成 hook(参见 .agent/claude-code/README.md)`,**绝不**自动爬 host 私有数据兜底(反模式)。

---

## 5. Host 接入

框架**不下发**任何 hook 配置(JSON / shell / python 都是 host 自己的事)。`templates/{zh,en}/.agent/claude-code/README.md` 提供完整的 Claude Code 参考(reporter shell + settings.json 注册片段)。

**任何** host 接入都是 5-7 步:

1. 找到 host 的 hook / lifecycle 文档,识别能 spawn 子进程 + 拿到当前 transcript / usage 数据的时机
2. 调同一 CLI:`runs tokens --source <host_slug> --input ... --output ... --cache-create ... --cache-read ...`
3. `--run-id` 由 orchestration 层在 host 启动时分配
4. 框架接收,聚合,dashboard 自动消费

---

## 6. L1/L2/L3 归属

按 `.agent/rules/agent-scope.md` 决策树(Q1:所有用户项目都需要?是 → L1 框架模板):

| 资产 | 位置 | 层级 |
|---|---|---|
| `lib/normalize-token-usage.js`(`management-api scripts/`) | `templates/{zh,en}/.agent/skills/management-api/scripts/` | L1 |
| `runs tokens` CLI 分支 | `templates/{zh,en}/.agent/skills/management-api/scripts/index.js` | L1 |
| `Token 用量` 面板 + I18N | `templates/{zh,en}/.agent/skills/agent-dashboard/scripts/generate.js` | L1 |
| Claude Code 接入 README | `templates/{zh,en}/.agent/claude-code/README.md` | L1 |
| 触发器 build-test parity | 主仓 `tests/management-api-tokens.test.js`(跑 EN 模板副本) | 框架测试 |

主仓镜像 `.agent/` 工作实例可见,**init/upgrade 通过 `script-manifest.js` 白名单自动下发到用户项目**。

---

## 7. 非目标(显式边界)

- ❌ 主动读任何 host 私有存储(违反倒置原则)
- ❌ USD 价格估算(汇率/许可范围多变;host 自报更精确)
- ❌ "质量分析":token-per-task 命中率是后续统计提案的事
- ❌ 改 `runs/run.schema.json` 的 `required`
- ❌ 修改 `memory` / `experiences` / `decisions` 主索引(token 是运行时遥测,与四类记忆互斥)
- ❌ 下发 host 私有 hook 配置(JSON / shell / python);**仅下发文档说明**

---

## 8. Phase 路径

| 阶段 | 范围 | 状态 |
|---|---|---|
| Phase 1 | `runs tokens` + `normalize-token-usage` + dashboard 面板 + Claude Code README | ✅ 已实施(本次) |
| Phase 2 | 全局 `.agent/token-events/<yyyy-mm-dd>.jsonl` + 跨 run 时间序列图 | 🔁 独立后续提案 |
| Phase 3 | 跨 host token 配额 / 告警(越界 → orchestration 层,本设计不管) | 🔁 独立后续提案 |

---

## 9. 关联资产

- 提案:`.agent/plans/proposals/token-usage/cortex-agent-token-usage-proposal.md`
- Claude Code 接入:`.agent/claude-code/README.md`
- normalize helper:`.agent/skills/management-api/scripts/normalize-token-usage.js`
- 协议边界规范:`.agent/rules/normalize-input-value.md`
- 单测:`tests/normalize-token-usage.test.js` 22 用例 + `tests/management-api-tokens.test.js` 6 e2e 用例
- 相关 incident(防御动机):`/Users/workspace/code/specific/2026-07-07` "LineChart 数值规范化 / PieChart 千分位" — "7,29000000" 等 dirty string 形态
- 已有 dashboard runtime 模式:`.agent/skills/agent-dashboard/scripts/generate.js`
- 已有写门禁:`lib/commands.js` 和 management-api `requireGate()`
