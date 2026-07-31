# cortex-agent `agent-runtime-continuity` — 跨 Agent 上下文续接

> **状态**: published (P-001 收口,2026-07-31)
> **作者**: Mavis (cortex-agent 主架构师助理) + Eric
> **生效版本**: cortex-agent v1.10.0 起
> **取代**: 旧 `agent-runtime-continuity` 提案(2026-07-21 结案,执行载体为幽灵 commit)
> **相关 RFC**: `docs/architecture/general-mode-design.md` §6.4.1(跨 agent 续接协议)、§15(前置依赖)

## 1. 概览

`agent-runtime-continuity` 是 cortex-agent v1.10.0 起的**第一类公民能力**:把"AI 会话 5 小时时长限制 + 跨 host 切换"这两个最常见的痛点,从 markdown 文档升级为可调用的 CLI 工具集。

设计目标:
- **续接协议层**:`session-manager` sub-agent 定义的 5 模式协议(`assess` / `archive` / `restore` / `status` / `warm`)仍然是行为规范,本提案只补完**执行层**;
- **跨 host 切换总线**:`host-switch` + `resume-bundle` 两个新模式把"Claude Code → Codex → Cursor"切换时上下文失踪的痛点,通过写入 `~/.agent/contexts/<project>/` 长期档 + `latest.md` symlink + `runs/<id>.json#events[]` 审计事件,把切换过程变成可观测、可回放、可恢复的事务;
- **零依赖、平台无关**:所有命令由 `templates/_shared/.agent/skills/runtime-continuity/scripts/index.js`(1089 行)单文件实现,纯 Node.js stdlib,无 npm 依赖;
- **audit-friendly**:每次 `archive` / `restore` / `status` / `host-switch` 都会写一条 `session_*` 事件到 `runs/<active-run>.json#events[]`,audit-trail 提案(已 ship)可以直接消费。

## 2. 5 模式协议(来自 session-manager sub-agent)

权威定义见 `.agent/sub-agents/session-manager.md`(本提案不重写)。这里复述便于阅读:

### 2.1 模式 A:任务启动评估 (`assess`)

输入:用户描述的任务内容。  
输出:乐观/悲观工时区间、风险等级、按 ≤3 小时切分的阶段计划、检查点标记。

CLI 入口:
```bash
cortex-agent session assess \
  --task-description "..." --gate user
```

返回 JSON 形如:
```json
{
  "ok": true,
  "action": "assess",
  "task_words": 6,
  "optimistic": 2, "pessimistic": 5, "avg": 3.5,
  "risk": "high",
  "phases": 2
}
```

### 2.2 模式 B:立即存档 (`archive`)

输入:项目名 + `--gate user` 强制门控 + 可选 `--note-json` 摘要。  
输出:`~/.agent/contexts/<project>/ctx_<YYYYmmdd_HHMMSS>.md` 全文 + `latest.md` symlink + `.agent/runtime-continuity/archives/RC-*.json` 结构化 + `runs/<id>.json#events[]` 一条 `session_archived` 事件。

```bash
cortex-agent session archive \
  --project <name> --gate user \
  --note-json '{"done":["X"],"in_progress":"Y","next":["Z"]}'
```

### 2.3 模式 C:会话恢复 (`restore`)

输入:项目名 + `--list` / `--auto` / 默认(load latest 全文)。  
输出:存档列表 / 全文 / 路径信息。

```bash
cortex-agent session restore --project <name> --list
cortex-agent session restore --project <name> --auto
```

### 2.4 模式 D:时间状态查询 (`status`)

输入:项目名。  
输出:最近 archive 距今小时数 + stale_recommendation(`ok` / `archive_now`,>2h 触发)。

```bash
cortex-agent session status --project <name>
```

### 2.5 模式 E:会话预热 (`warm`)

输入:无。  
输出:5 小时滚动窗口提示文本,host 把它贴到对话中即可启动计时。

```bash
cortex-agent session warm
```

`warm --auto` 是 SessionStart 钩子专用入口,需要 `CORTEX_SESSION_START=1` capability 环境变量。

## 3. Runtime Continuity v2 — 5 模式之外的新增能力

P-001 把 SKILL.md 中的 **10 模式**全部交付。除上述 5 个,新增 5 个模式:

### 3.1 `log` — transferable work log

把 done / in_progress / next / blockers / refs 写为 transferable JSON,落到 `.agent/runtime-continuity/events/<stamp>-event.json`,并 append `runtime_log` 事件到 `runs/<id>.json#events[]`。  
设计动机:不是每次都需要完整 `archive`,但需要"做过什么 / 下一步是什么"的可机器消费结构。

### 3.2 `checkpoint` — phase boundary

结构与 `log` 一致,但事件类型为 `checkpoint`,在 `runs/<id>.json#events[]` 中被映射为 `runtime_checkpoint`。  
phase 字段用于 `/handoff` 与 `resume-bundle` 时的快速过滤。

### 3.3 `resume-bundle` — 新 agent 默认入口

新 agent 加入项目时,第一行命令应该是:
```bash
cortex-agent session resume-bundle --project <name>
```

返回的 JSON 包含:
- `latest_archive`:`.agent/runtime-continuity/archives/latest.json` 路径
- `latest_markdown_archive`:`~/.agent/contexts/<name>/latest.md` 路径
- `archive`:完整 archive JSON(包含 state / refs / restore)
- `runtime_events`:最近 12 条 runtime event
- `runs` / `sessions` / `handoffs` / `artifact_states`:相关 runtime state 引用
- `git`:`branch` / `head` / `status_short`(必须在 git repo 内)
- `read_first`:`AGENTS.md` / `.agent/rules/*` / archive 列表
- `next_action`:archive 中的 `restore.next_action`
- `recommended_commands`:基于现有 handoff / artifact 自动生成的推荐命令

### 3.4 `host-switch` — 跨 host 迁移总线(Phase 2 核心)

跨 host(Claude Code / Codex / Cursor / Codey)切换时,旧 host 退出前必须调用:

```bash
cortex-agent session host-switch \
  --project <name> \
  --from-host claude-code --to-host codex \
  --reason "user wants codex" \
  --gate user \
  --note-json '{"done":["phase1"],"in_progress":"phase2","next":["phase3"]}'
```

执行流程:
1. 写入 `~/.agent/contexts/<name>/ctx_<stamp>.md` + `latest.md` symlink(Markdown 全文,人类可读)
2. 写入 `.agent/runtime-continuity/archives/RC-<stamp>.json` + `latest.json`(结构化 + 跨 host 字段 `source_host` / `target_host` / `reason`)
3. 更新 `sessions/<S>.json#last_host` + `last_switch_at`(host trace,幂等)
4. 追加 `host_switch_initiated` 事件到 `runs/<id>.json#events[]`
5. 输出 `next_steps_for_new_host` 4 步操作提示(新 host 的入场剧本)

返回 JSON 中的 `archive.archive` 字段已经包含完整状态,新 host 接到 payload 后执行:
```bash
cortex-agent session restore --project <name> --auto
```
即可恢复全部上下文。

### 3.5 `list-contexts` — 跨项目 aggregation(read-only)

无需 `--gate`,无需 `--project`。列出 `~/.agent/contexts/` 下所有项目的 archive 数量 + 最近 mtime,支持 `--since 2026-07-01` 过滤与 `--format json|table` 切换。

```bash
cortex-agent session list-contexts --format table
```

## 4. CLI 门面: `bin/cli.js session`

### 4.1 架构

`cortex-agent session <subcmd>` 是一个**纯 thin wrapper**,30-50 行实现,把请求委托给 `templates/_shared/.agent/skills/runtime-continuity/scripts/index.js`:

```text
cortex-agent session <subcmd> [args]
  └─ bin/cli.js session 解析 subcmd
      └─ spawn: node templates/_shared/.agent/skills/runtime-continuity/scripts/index.js <subcmd> [args]
          └─ 业务逻辑(纯 stdlib + 已有 events writer)
```

为什么不直接 `node .agent/skills/runtime-continuity/scripts/index.js`?因为:
1. 跨 host(Claude Code / Cursor / Codex)第一次接触 cortex-agent 时,需要的是 `cortex-agent session ...` 风格入口;
2. 跟 `cortex-agent task / event / lease` 等其他子命令风格统一;
3. 未来若需要 pre-处理(参数标准化、auth 校验、pre-flight 检查),可以在 facade 层加,业务层不动。

### 4.2 不通过 `lib/commands` 中转

按 plan §3 决策,facade 选择**直接 spawn 模板脚本**,不通过 `lib/commands` 中转。理由:
- `lib/commands` 路径在当前 repo 中**引用不正确**(plan §6.3 标记为 P-002 范围)
- 直接 spawn 是 5 行的最简实现,符合"最小化修改"硬约束
- 未来若 `lib/commands` 路径修好,可以平滑迁移(facade 内部 5 行换法)

### 4.3 已知 facade 行为

- `cortex-agent session` 或 `cortex-agent session --help` → 输出 10 个子命令清单 + 示例
- `cortex-agent session <unknown>` → 退出码 2 + 提示 run --help
- spawn 失败(脚本缺失) → 退出码 3 + 提示 reinstall
- spawn 错误(stdio pipe break) → 退出码 4

子进程 exit code 原样透传,所以下游 agent 把 `session archive --project <p> --gate user` 的 exit code 视为 success/fail 直接判断。

## 5. 与其他子系统的关系

### 5.1 与 `agent-collaboration-runtime` 的关系

`agent-collaboration-runtime`(T-C07 ~ T-C10)是协调层,提供 `task` / `event` / `lease` / `coordination` 等子命令;`runtime-continuity` 是会话层,提供 `session` 子命令。两者**正交**:
- `task` / `event` 处理**任务协作**(多 agent 协调)
- `session` 处理**会话续接**(单 agent 跨时间 / 跨 host)

`session archive` 会写一条 `session_archived` 到 `runs/<id>.json#events[]`,但 `runs` 是 coordination 子系统管理的 runtime state,所以两者通过 `runs` 自然桥接。

### 5.2 与 `audit-trail` 的关系

`audit-trail` 提案(同 session 维度,本提案是其补完集)消费 `runs/<id>.json#events[]` 的 `session_*` 事件类型作为 project-local audit signal。每次 `archive` / `restore` / `status` / `host-switch` / `log` / `checkpoint` 都至少写一条事件,确保 audit-trail 能:
- 统计"哪些项目最近 7 天有 session_archived"
- 还原 host 切换的完整时间线
- 关联 `runtime_log` 事件做"工作日志流"投影

### 5.3 与 `secrets-vcs` 的关系

`host-switch` 的 next_steps_for_new_host 显式提示:
> "host-only reattach: the archive does NOT carry hook secrets; re-establish Authorization: token ${secret://<ref>} via the secrets skill if needed."

这是**有意的边界**:存档携带的只是公开状态(branch / commit / files / done-list),不携带任何凭证。host 切换后,新 host 需通过 `secrets` skill 重新拉取 `secret://<ref>` 的 token。这是"zero secret leakage"硬约束。

### 5.4 与 `general-mode-design` RFC §6.4.1 的关系

RFC §6.4.1 定义的**跨 agent 续接协议**是 general 模式的核心叙事。它的物理实现就是:
- `~/.agent/contexts/<id>/handoffs/H-NNN.{md,json}` 长期档(由 general 模式的 conversations/ 子系统管理)
- `runs/<id>.json#events[]` 的 `host_switch_initiated` 事件(由 runtime-continuity 写)
- `resume-bundle` 汇总输出(由 runtime-continuity 提供,general 模式 `/handoff` workflow 调)

**v1.10.0 范围**:只交付 framework 层(本提案);host 适配(Claude Code / Codex / Cursor / Codey 如何主动调用 `session host-switch` 触发切换)留给各 host 自行实现,**v1.11.0** 闭环。

## 6. 跨 host 切换总线协议

### 6.1 总线拓扑

```text
┌──────────────────┐  host-switch  ┌──────────────────┐
│  Old host        │ ────────────► │ ~/.agent/contexts/│
│  (Claude Code)   │   writes     │   <project>/      │
│                  │              │   ctx_<ts>.md     │
│  archive() +     │              │   latest.md       │
│  appendRunEvent()│              │   RC-<ts>.json    │
└──────────────────┘              └────────┬─────────┘
                                          │
                                          │ restore --auto
                                          ▼
┌──────────────────┐  resume-bundle ┌──────────────────┐
│  New host        │ ◄───────────── │ runtime-continuity│
│  (Codex)         │  reads         │ scripts/index.js  │
│  reads state +   │                │                  │
│  rebuilds context│                │                  │
└──────────────────┘                └──────────────────┘
```

### 6.2 协议不变量

`host-switch` 与 `restore` 必须保证:

1. **状态原子性**:`archive` 写 `ctx_<ts>.md` + `RC-<ts>.json` + `latest.md` symlink 全部成功才视为切换成功;任一失败,`session_archived` 事件**不**写入,旧 host 可重试。
2. **路径不变性**:`~/.agent/contexts/<project>/` 是单一真理来源,新 host 只需 read latest.md 即可获得完整上下文,不需要任何 import / migrate 步骤。
3. **审计完整性**:`host_switch_initiated` 事件必须 append 到 `runs/<active-run>.json#events[]`,否则视为协议违规。
4. **零 secret**:`host-switch` 输出**不包含**任何 token / cookie / 凭证;凭证由 `secrets` skill 通过 `secret://<ref>` 间接传递。
5. **幂等性**:`markSessionLastHost` 在 sessions/<S>.json 上是幂等更新;多次 host-switch 不会创建多条 S-*.json。

### 6.3 已知边界

- **host 必须显式调用**:`host-switch` 不会自动触发,必须由旧 host 在退出前显式执行(v1.10.0 不强制;v1.11.0 计划加 `SessionEnd` 钩子强制 archive-on-leave)。
- **single-writer**:同一时刻只有一个 host 在写 `~/.agent/contexts/<project>/`;并发切换由 host 自身锁保证(runtime-continuity 不强制,文档建议)。
- **不携带业务状态**:仅携带 plan / branch / done-list / handoff refs;具体代码修改、test results、build artifacts 通过 `artifacts/` + `runs/` 引用,**不**进 archive 全文。

## 7. 失败恢复路径

### 7.1 archive 失败(磁盘满 / 权限 / IO)

症状:`ctx_<ts>.md` 写出但 `RC-<ts>.json` 未写,或两者都失败。  
恢复:重试 `archive`;每次 archive 生成新 `ctx_<ts>.md`,所以重试不会覆盖既有存档(只追加)。

### 7.2 restore 失败(latest.md 损坏 / 缺失)

症状:`restore --auto` 返回 `ok: false, error: no_archive_for_project`。  
恢复:
1. `restore --list` 看历史 archive 列表
2. 选最近一个 `ctx_*.md` 手工读:`cat ~/.agent/contexts/<project>/ctx_<stamp>.md`
3. 或用 `resume-bundle` 拉汇总(即使 markdown 损坏,structured JSON `RC-*.json` 可能幸存)

### 7.3 host-switch 写一半(archive 成功 + run event 失败)

症状:`~/.agent/contexts/<project>/` 有新存档,但 `runs/<id>.json` 没有 `host_switch_initiated` 事件。  
恢复:
1. 新 host 仍可 read latest.md 恢复上下文
2. 但 audit-trail 会显示 "host switched but no event recorded" — 标记为 incomplete
3. 修复:旧 host 重跑 `host-switch`(幂等),会再写一次 archive + 这次确保 run event 成功

### 7.4 脚本缺失(模板损坏)

症状:`bin/cli.js session <cmd>` 退出码 3 + "script not found"。  
恢复:重装 cortex-agent (`pnpm i -g cortex-agent@latest`) 或 git pull 最新模板。

### 7.5 测试 fixture 残留

症状:测试运行后 `~/.agent/contexts/p001-*/` 残留。  
恢复:跑 `mavis-trash ~/.agent/contexts/p001-*`(本提案测试用 unique 名 `p001-*` 隔离)。CI 环境下 fixture 在 tmpdir 内,自动清理。

## 8. 落地与发版

### 8.1 代码位置

| 路径 | 角色 |
| :--- | :--- |
| `templates/_shared/.agent/skills/runtime-continuity/scripts/index.js` | 业务实现(1089 行,zero-dep) |
| `templates/{zh,en}/.agent/skills/runtime-continuity/SKILL.md` | 双语 SKILL 文档(被 `upgrade` 复制到项目内) |
| `bin/cli.js` (line 8, 172, 145-202) | session facade,30-50 行 thin wrapper |
| `tests/runtime-continuity.test.js` | 11 个回归用例(超过 plan §5.1 要求的 7+) |
| `docs/architecture/agent-runtime-continuity.md`(本文档) | 沉淀文档,人类可读 |

### 8.2 执行载体 commit

按 plan §4.4 修复后的真实 commit 列表:
- `1513b27` (Phase 1 — CLI shell for session-manager 5-mode protocol)
- `ddbd107` (mirror Phase 1 — 跨实例同步)
- `33b1baa` (Phase 2 — host-switch + list-contexts + Claude Code hook recipe)
- `543e86d` (mirror Phase 2)
- `e456181` (守护续期)
- `6502837` (structured continuity resume CLI)
- `e2777d4` / `fe497b7` (共享模板层)

历史 ghost commit 引用 `4f51d9f` / `08c2402` 已在所有 P-001 文档中替换为上述真实 commit。

### 8.3 与 v1.10.0 release notes 的对应

RFC v0.2 §7 提到的 v1.10.0 release notes 中:
> - 新增 `bin/cli.js session` 子命令(5 模式:assess / archive / restore / status / warm)

实际落地为 10 模式(plan §2 决策,SKILL.md 已 ship),其余 5 模式(`log` / `checkpoint` / `resume-bundle` / `host-switch` / `list-contexts`)在 v1.10.0 中一并交付。

## 9. 验收对照

RFC v0.2 §15 硬前置 = runtime-continuity-recovery P-001 状态 = done。P-001 验收 15 条全部通过,详见 `.agent/plans/proposals/projects/runtime-continuity-recovery/plan.md` §8 验收对照表。

## 10. 后续 follow-up

- **P-002**:`lib/commands` 路径修复(独立提案,本提案不修)
- **v1.11.0**:`SessionEnd` 钩子强制 archive-on-leave
- **v1.11.0**:5 host adapter(Claude Code / Codex / Cursor / Codey / PI)主动调用 `host-switch` 的 recipe
- **v1.11.0**:`conversations/<id>/handoffs/` 物理实现(general 模式 跨 agent 续接协议 §6.4.1 闭环)
- **v2.0.0**:`cortex-agent migrate` 命令从 v1.x schema 平滑升级到 v2 schema,包含 runtime-continuity 路径兼容
