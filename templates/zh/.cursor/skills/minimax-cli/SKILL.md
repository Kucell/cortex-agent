---
name: minimax-cli
description: MiniMax CLI (`mmx`) 受治理工具适配。在 Claude Code 插件路径下注册；与 .agent/skills/minimax-cli 共享同一 frozen schema / 3 类 probe 白名单 / auth_state=unknown / fail-closed 网关。仅 mmx --version、mmx --help、mmx <resource> --help 允许；其余 mmx 子命令被禁止。
model: sonnet
tools:
  - Read
  - Bash
  - Grep
  - Glob
area: swe
summary: MiniMax CLI (`mmx`) 受治理工具适配。在 Claude Code 插件路径下注册；与 .agent/skills/minimax-cli 共享同一 frozen schema / 3 类 probe 白名单 / auth_state=unknown / fail-closed 网关。仅 mmx --version、mmx --help、mmx <resource> --help 
---

# minimax-cli (Claude Code 插件，ARI P-005 / M-011)

> Frozen proposal: `.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md`
> Frozen SHA-256: `f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d`

Claude Code 插件下的 minimax-cli Skill。**所有运行时行为通过** `templates/_shared/.agent/skills/minimax-cli/SKILL.md` 中描述的 `lib/runtime-adapters/minimax-cli-governed-tool.js` 网关执行；本文件仅负责 Claude Code 侧的插件注册。

## 严格三类 probe 白名单

只允许：
1. `mmx --version`
2. `mmx --help`
3. `mmx <resource> --help`（`<resource>` ∈ `{text, image, video, speech, music, vision, search}`）

其余所有 `mmx` 子命令在执行前必须抛出 `MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED")`。

## Auth posture

`auth_state` 固定 `"unknown"`，`auth_state_reason` 固定 `"auth_probing_disabled"`。

## 禁止项（与 _shared SKILL.md 完全一致）

`mmx auth` / `mmx config` / `mmx quota` / `mmx update` / `mmx install` / `mmx file` / `mmx <resource> chat|generate|search|describe|synthesize|cover|download|task|repl|query|voices` 全部禁止。

## 跳转

- 主 Skill: `.agent/skills/minimax-cli/SKILL.md`
- 实现: `lib/runtime-adapters/minimax-cli-{probe,capability-contract,skill-discovery,governed-tool}.js`
- Mission 证据: `.agent/missions/M-011/evidence/`