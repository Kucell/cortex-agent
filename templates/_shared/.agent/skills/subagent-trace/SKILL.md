---
name: subagent-trace
description: Receiver for sub-agent fan-out lifecycle events.  Hosts (Claude Code / Cursor / Codex) push spawned / progress / completed / cancelled via `emit`; this skill appends to runs/<id>.json#subagent_fanout[] AND #events[].  Use `list` / `tree` to reconstruct the fan-out tree.
---

# subagent-trace (L1 — fan-out 接收器)

> Hosts (Claude Code / Cursor / Codex) that fan out sub-agents in
> response to "fan out subagents" / "分发子任务" / "并行 3 个 agent"
> should call this skill to record each sub-agent's lifecycle.
> Framework is **passive**: it only receives events, never spawns.

> Source of truth: `templates/{zh,en}/.agent/agent-protocols/subagent-fanout.md`
> and `../scripts/match-trigger.js` (the helper that decides whether a
> user prompt is even a fan-out).  This file is the CLI / SKILL
> surface; do NOT redefine the protocol here.

## When to Use

- After the parent agent decides to fan out, **immediately** call
  `emit --event subagent_spawned` for each sub-agent with role + task.
- During the sub-agent's life, optionally emit `--event subagent_progress`
  to update the dashboard percent.
- When the sub-agent finishes, **immediately** emit
  `--event subagent_completed --status success|partial|failed`.
  `--status failed` with `--notify-on-fail` will also write an inbox
  message to the parent run so the parent agent knows.
- If the user cancels mid-task, emit `--event subagent_cancelled --reason ...`.

## Commands

```bash
# 1. Mark a new sub-agent as spawned (parent_run_id is auto-discovered
#    from .agent/runs/ if not passed).
node .agent/skills/subagent-trace/scripts/index.js emit \
  --event subagent_spawned \
  --subagent-id sub-exp-001 --subagent-role explore \
  --task-description "find usages of normalize-token-usage across L1" \
  --gate agent

# 2. Heartbeat (optional)
node .agent/skills/subagent-trace/scripts/index.js emit \
  --event subagent_progress \
  --subagent-id sub-exp-001 --percent 40 \
  --current-step "scanning templates/en/.agent/skills/" \
  --gate agent

# 3. Done — success / partial / failed
node .agent/skills/subagent-trace/scripts/index.js emit \
  --event subagent_completed \
  --subagent-id sub-exp-001 --status success \
  --output-summary "5 skills depend on normalize-token-usage" \
  --output-artifact-refs ".agent/skills/..." \
  --duration-actual-seconds 90 \
  --gate agent

# 4. Cancelled
node .agent/skills/subagent-trace/scripts/index.js emit \
  --event subagent_cancelled \
  --subagent-id sub-exp-001 --reason "user stopped fan-out" \
  --gate agent

# 5. Read side
node .agent/skills/subagent-trace/scripts/index.js list \
  [--parent-run-id R-20260722-x]
node .agent/skills/subagent-trace/scripts/index.js tree \
  [--parent-run-id R-20260722-x]
```

## Guarantees

- **Zero dependency**: pure stdlib + `node:fs`.  No npm install.
- **Double-write audit trail**: every `emit` writes both to
  `runs/<id>.json#events[]` (Phase 1 audit-trail flat stream, 200 cap)
  AND `runs/<id>.json#subagent_fanout[]` (per-sub-agent aggregated).
- **Bilingual labels** (zh first): status / role labels in
  `agent-protocols/subagent-fanout.md` use zh as default; EN is the
  fallback for hosts that don't push zh context.
- **Optional host integration**: any host that doesn't push still
  works; framework just doesn't know about sub-agents.

## Non-Goals

- Does NOT spawn sub-agents.
- Does NOT crawl host private sub-agent state.
- Does NOT enforce the protocol — hosts may push partial events; the
  receiver is best-effort and idempotent.

## Source of Truth

- `agent-protocols/subagent-fanout.md` (zh + en) — event schema, trigger
  keywords, status / role labels.
- `scripts/match-trigger.js` — keyword-matching pure helper.
- This `SKILL.md` — how to invoke the receiver as a CLI.

For return-shape / edge cases, read `scripts/index.js` — it is
single-file and well-commented.
