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


## 跨 Host 切换 Hook(Phase 2 — runtime-continuity)

当用户需要将工作从一个 host agent(Claude Code / Cursor / Codex)迁移到另一个时,离开的 host 应触发 `runtime-continuity host-switch`,使进入的 host 有最新的 archive 可恢复。

### Stop hook 配置

在 `~/.claude/settings.json`(或其他 host 的 hook 配置)中添加:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/claude-code-host-switch-reporter.sh",
            "if": "$TO_HOST"
          }
        ]
      }
    ]
  }
}
```

`TO_HOST` 是用户在切换前设置的环境变量(例如 `export TO_HOST=codex`)。未设置时 hook 不执行(不会污染状态)。

### Reporter 脚本

`~/.claude/hooks/claude-code-host-switch-reporter.sh`:

```bash
#!/usr/bin/env bash
# 触发 runtime-continuity host-switch,使新 host(codex / cursor)可通过 restore 恢复。
# 从环境变量读取 TO_HOST 和 RUN_ID。
# CLI 框架是唯一事实来源;此脚本仅传递参数。
set -euo pipefail

# 必填: TO_HOST(目标 host),以及活跃 run id(可选——runtime-continuity 可自动查找)
TO_HOST="${TO_HOST:-}"
RUN_ID="${CLAUDE_RUN_ID:-}"
PAYLOAD="${1:-}"
[ -z "$TO_HOST" ] && exit 0

# 项目名 = 当前工作目录的 basename
PROJECT=$(basename "$PWD")

# 交接: archive + session last_host + run event + 4 步恢复指引
node .agent/skills/runtime-continuity/scripts/index.js host-switch \
  --project "$PROJECT" \
  --from-host claude-code --to-host "$TO_HOST" \
  --reason "$STOP_REASON" \
  --run-id "$RUN_ID" \
  --gate user 2>/dev/null || {
  echo "host-switch reporter failed (non-fatal)" >&2
  exit 0
}
```

### 新 Host 恢复方法

当新 host(Cursor / Codex / 等)在同一项目上启动会话时,执行:

```bash
node .agent/skills/runtime-continuity/scripts/index.js restore \
  --project "$PROJECT" --gate user --load latest
```

返回的 body 包含**结构化摘要**供新 agent 使用。详见 `runtime-continuity` SKILL.md 中的 4 步 `next_steps_for_new_host` 协议。
## Transcript Link Hook(Phase 2 — audit-trail)

当 Claude Code 会话结束时,把 transcript 路径引用推入当前 run,使 dashboard
可以深链接到原始 transcript,**而框架从不读取 transcript content**。
复用 token-usage 模式(第 40 行);hook 脚本独立,通过 `~/.claude/settings.json`
的 `Stop` 数组共享。

### Stop hook 配置

在 `~/.claude/settings.json`(或其他 host 的 hook 配置)中添加:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/claude-code-token-reporter.sh" },
          { "type": "command", "command": "~/.claude/hooks/claude-code-transcript-link-reporter.sh" }
        ]
      }
    ]
  }
}
```

### Reporter 脚本(单一事实源)

权威脚本不再内联在本文(会漂移)。从模板安装:

    templates/_shared/.agent/hooks/claude-code-transcript-link-reporter.sh

复制到 host hooks 目录并设为可执行:

    cp templates/_shared/.agent/hooks/claude-code-transcript-link-reporter.sh ~/.claude/hooks/
    chmod +x ~/.claude/hooks/claude-code-transcript-link-reporter.sh

行为契约与隐私不变量见下文;脚本行为以模板文件为唯一事实源,由测试保证与模板字节级一致。


### 行为契约

- transcript 路径不存在 → 静默退出(不中断会话)
- transcript-link CLI 失败 → transcript_refs[] 不写,但 transcript_linked 事件尝试被框架接收;stderr 记录失败,exit 0(不中断会话)
- 同一 source + session_id 重复推送 → 去重替换之前的条目(audit-trail Phase 2 §3.6)

### 隐私不变量

- 框架绝不读 transcript content。hook 只发送路径 + 4 个元数据字段(sha256 / byte_size / turn_count / first/last timestamps)。
- **通过环境变量设置项目根目录**(推荐):启动 Claude Code 前 export `CORTEX_PROJECT_DIR=/path/to/project`。hook 直接读取并 cd,无需路径解码猜测。
- **项目级 opt-out**:创建 `.agent/config/audit-trail.yaml`:
  ```yaml
  transcript_link:
    enabled: false
  ```
  hook grep `enabled: false` 即静默跳过。YAML 匹配为 best-effort(空白宽容)。

### 关联文档

- 提案: .agent/plans/proposals/audit-trail/phase-2/cortex-agent-audit-trail-phase2-proposal.md
- schema: .agent/runs/run.schema.json#properties.transcript_refs
- 实现: .agent/skills/management-api/scripts/index.js runsTranscriptLink()
