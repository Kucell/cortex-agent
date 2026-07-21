# Claude Code Token Reporting Hook

> 把 Claude Code 的 token 用量推到 cortex-agent dashboard。
> **框架不读 Claude Code 私有数据**(违反依赖倒置);Claude Code 在 hook 里调我们暴露的 CLI,框架接收、聚合、显示。

## 契约入口

```bash
node .agent/skills/management-api/scripts/index.js runs tokens \
  --gate agent \
  --source claude-code \
  --run-id <id> \
  --session-id <id> \
  --task-id <id> \
  --model <model_name> \
  --input <input_tokens> \
  --output <output_tokens> \
  --cache-create <cache_creation_input_tokens> \
  --cache-read <cache_read_input_tokens> \
  [--cost-usd <host_self_reported_usd>]
```

`--gate agent` 必填(沿用 `management-api` 写门禁)。
`--run-id` 当前 Phase 1 必填(全局 token log 留 Phase 2)。
所有数值字段会被 `normalize-token-usage.js` 强制规范化为非负整数,见 `lib/rules/normalize-input-value.md`。

## 为什么需要 hook

Claude Code 的 `Stop` / `SessionEnd` hook payload **不附带 token 用量字段**。canonical 数据源是 transcript JSONL(`~/.claude/projects/<slug>/<uuid>.jsonl`,每条 assistant 消息的 `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`)。所以 hook 需要:

1. 从 `transcript_path` 读最后一条 assistant 消息
2. 提取四个 token 字段
3. 替换占位符调我们的 CLI

## 安装

把下面的脚本写到 `~/.claude/hooks/claude-code-token-reporter.sh`(chmod +x),再在 `~/.claude/settings.json` 注册 `Stop` hook。**框架不下发 hook 配置**——host 适配是 host 自己的事。

### 1) reporter shell 脚本

```bash
#!/usr/bin/env bash
# ~/.claude/hooks/claude-code-token-reporter.sh
# Read the latest assistant token usage from the transcript JSONL and push
# it to the framework. Skips silent when input is empty (no assistant
# message yet — Claude Code invokes Stop even on tool-only turns).
set -euo pipefail

PAYLOAD="${1:-}"
if [ -z "$PAYLOAD" ]; then exit 0; fi

TRANSCRIPT=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // ""')
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // ""')

# Last assistant message usage (input/output/cache_*) — jq slurps + emits
# empty object when missing so the CLI sees a clean "no data" run.
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0
USAGE=$(jq -c '
  [inputs
    | select(.type == "assistant")
    | select(.message.usage)
    | .message.usage]
  | if length > 0 then .[-1] else {} end
' "$TRANSCRIPT")

[ "$(printf '%s' "$USAGE" | jq 'length')" -gt 0 ] || exit 0

cd "$CWD"

# Pick the most recent run that this session is associated with. Phase 1
# requires --run-id; if none is known, we skip silently. Agents that want
# robust mapping should use the bash to call the management-api and look up
# session.current_run_id before invoking runs tokens.
RUN_ID="${CLAUDE_TOKEN_RUN_ID:-}"
[ -n "$RUN_ID" ] || exit 0

node .agent/skills/management-api/scripts/index.js runs tokens \
  --gate agent \
  --source claude-code \
  --run-id "$RUN_ID" \
  --session-id "$SESSION_ID" \
  --model "${CLAUDE_MODEL:-sonnet}" \
  --input           "$(printf '%s' "$USAGE" | jq -r '.input_tokens // 0')" \
  --output          "$(printf '%s' "$USAGE" | jq -r '.output_tokens // 0')" \
  --cache-create    "$(printf '%s' "$USAGE" | jq -r '.cache_creation_input_tokens // 0')" \
  --cache-read      "$(printf '%s' "$USAGE" | jq -r '.cache_read_input_tokens // 0')" \
  >/dev/null
```

### 2) 注册 Stop hook(~/.claude/settings.json)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/claude-code-token-reporter.sh"
          }
        ]
      }
    ]
  }
}
```

Claude Code 会把 hook payload(`包含 transcript_path / cwd / session_id`)作为 stdin 喂给脚本。

### 3) 设置 run-id

`CLAUDE_TOKEN_RUN_ID` 是 host 适配层的细节。**最简单**:在每次启动 Claude Code session 之前由 orchestration 层(例如 `runs upsert`)先把 run_id 写到 env。如果不设置,reporter 静默跳过(不会破坏 session)。

## 验证

完成 1-3 步后:

```bash
# 在 Claude Code 会话里做任意操作触发 Stop hook
# 之后:
node .agent/skills/agent-dashboard/scripts/generate.js
open .agent/metrics/agent-dashboard.html  # → Token 用量面板可见
```

或直接 CLI 检查:

```bash
cat .agent/runs/<run_id>.json | jq '.token_usage.by_source["claude-code"]'
```

## 其他 host(Cursor / Codex / ...)

- **Cursor**:在 Cursor 的 lifecycle callback / agent termination hook 里调同一 CLI 即可;Cursor SDK 通常提供 `child_process.spawn` 或等价的 shell out。
- **Codex**:同 Cursor,调同一 CLI。
- **任何 host**:只要能 spawn 子进程 + 解析 transcript(或自报 token),都能用。**框架这边不需要任何适配**——这就是依赖倒置的价值。

## 关联文档

- 提案:`.agent/plans/proposals/token-usage/cortex-agent-token-usage-proposal.md`
- normalize helper:`.agent/skills/management-api/scripts/normalize-token-usage.js`
- 协议边界规范:`.agent/rules/normalize-input-value.md`
