# Agent Registry

Agent Registry records which agents are active, which task or mission they own, their model/session identity, owned files, pending artifacts, and recent coordination events.

This directory is part of Multi-Agent Coordinator. It stores runtime coordination state under `.agent/` and must not be used as a source-code or diff archive.

## Files

| File | Role |
|---|---|
| `agents.json` | Current registry state plus append-only event log |
| `agent-registry.schema.json` | JSON schema for registry shape |
| `scripts/agent-registry.js` | Zero-dependency helper for check-in, heartbeat, check-out, active listing, conflict detection, and stale marking |

## Commands

```bash
node .agent/registry/scripts/agent-registry.js check-in \
  --agent-id implementer-001 \
  --role implementer \
  --model codex \
  --task-id T-C03 \
  --session-id s-001 \
  --owned-files src/a.ts,src/b.ts

node .agent/registry/scripts/agent-registry.js heartbeat --agent-id implementer-001
node .agent/registry/scripts/agent-registry.js check-out --agent-id implementer-001 --status completed
node .agent/registry/scripts/agent-registry.js list-active --task-id T-C03
node .agent/registry/scripts/agent-registry.js get-conflicts --task-id T-C03 --owned-files src/a.ts
node .agent/registry/scripts/agent-registry.js mark-stale --ttl-seconds 300
```

## Rules

- Store paths, status, timestamps, and artifact references only.
- Do not store source code, full diffs, PRDs, or long command output.
- Treat `running` and `paused` as active statuses.
- A stale active agent may be marked `failed`; handoff recovery is handled by Coordinator.
