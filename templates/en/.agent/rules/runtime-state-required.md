# Active Task Persistence — Rules for SessionStart

> **核心规则**:任何排查 / 调试 / debug 性质超过 3 turn 的会话,
> 必须有 1 个 active mission + persistent run,所有工具调用 + 用户观察
> 进 `runs/events[]` 流。这样下次 agent / 会话切回来,能从 `.agent/`
> 看到"上次正在查什么"。

---

## 触发条件(MANDATORY — 满足任一即触发)

| 信号 | 检测 |
|---|---|
| 关键词 | `/排查\|调试\|debug\|investigate\|探索\|为什么\|怎么回\|看样子/.test(text)` |
| 工具失败累计 | `events.filter(tool_status=failed).length >= 1` |
| 用户提问累计 | `events.filter(source=user && !question_meta).length >= 1` |
| turn 数 | `turns >= 3` |

任一条件满足 → **强制**走 session-triage skill。

---

## 必须做什么

1. 调 `runs upsert --gate user --run-id R-<slug> --status running --phase triage`(新建 run)
2. 调 session-triage 的 `node .agent/skills/session-triage/scripts/index.js open --mission M-NNN --run-id R-...`(新建 mission + plan)
3. 每个工具调用 + 用户 observation 都进 runs.events[] via:
   ```
   node .agent/skills/management-api/scripts/index.js runs event \
     --gate user --run-id R-... --type {human_observation|tool_failure|investigation_step} \
     --message "..."
   ```
4. 每 30 min 自动生成 / 更新 handoff via session-triage

---

## 不强制(NOT triggered)

- < 3 turn 的纯查询
- 纯 read 操作(`.agent/workflows/agent-dashboard --serve` 等)
- 单次 terminal 执行,不打开会话

---

## 失败恢复

- skill 写失败 → 不破坏已有 mission / runs
- `runs event` 失败 → 退化:仍然输出 stdout 让用户看见
- triage 静默退:没触发条件

---

## 不要做

- ❌ 不自动闭合 mission(由 user / owner resolve)
- ❌ 不清理已写 runs(生命比 1 session 长)
- ❌ 不跨项目 multiplex 单 mission
- ❌ 不会自动删除 events
