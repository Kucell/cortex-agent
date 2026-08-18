---
name: evolution-pipeline
description: OpenViking-style async self-evolution pipeline. After a session archive, worker classifies observations and writes them to `.agent/memory/{feedback,project,experiences}/`. v1 = deterministic, zero tokens.
area: agent-tuning
summary: OpenViking-style async self-evolution pipeline. After a session archive, worker classifies observations and writes them to `.agent/memory/{feedback,project,experiences}/`. v1 = deterministic, zero tok
---

# Self-Evolution Pipeline (Phase 2.2)

## Goal

Port OpenViking's `session.commit()` async memory extraction to cortex-agent:

- Auto-create evolution task after each `runtime-continuity` archive
- `evolve.js --worker` processes tasks in the background
- Supports retry, dead-letter queue, and idempotency
- v1 = deterministic rule-based classification (zero token cost)

## Architecture

```
runtime-continuity/archive
         ↓ (manual or --auto)
evolve.js --enqueue-from-latest
         ↓
.agent/tasks/evolution/EVO-YYYY-MM-DD-NNN.json
         ↓ (poll loop)
evolve.js --worker --loop --interval 30
         ↓
.classifyArchive() → {user, feedback, project, experiences} routes
         ↓
writeMemoryItem() → .agent/memory/{scope}/{name}.md
         ↓
updateMemoryIndex() → .agent/memory/MEMORY.md
```

## Commands

```bash
# Enqueue (manual)
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue-from-latest
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue-from-latest --max 5
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue --archive RC-20260724_053807_983

# Worker
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --once
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --loop --interval 30

# Management
node .agent/skills/evolution-pipeline/scripts/evolve.js --status
node .agent/skills/evolution-pipeline/scripts/evolve.js --list --status failed
node .agent/skills/evolution-pipeline/scripts/evolve.js --replay EVO-2026-07-24-001
node .agent/skills/evolution-pipeline/scripts/evolve.js --dead-letter
```

## Classification Rules (v1 = deterministic)

| Category | Trigger | Target |
|---|---|---|
| feedback | state.blockers[] + state.in_progress | memory/feedback/ |
| project fact | state.done[] (non-lesson) + state.next[] | memory/project/ |
| experience | state.done[] + keywords: lesson/trap/regression/root cause | experiences/ |
| user | (v2) preference keyword extraction | memory/user/ |
| dropped | no match or duplicate | - |

## Boundaries

- **vs runtime-continuity**: no changes to guard/archive logic; only downstream consumption
- **vs memory-protocol.md**: 100% compatible frontmatter format + MEMORY.md index convention
- **vs experience-recall**: writes lessons directly to `experiences/` for recall
- **vs LLM extraction**: swap classifyArchive() only, enqueue/worker unchanged
- **vs skill-selector**: v1 does NOT extract skills explicitly (OpenViking's skill/ dir vs cortex-agent's already exists)

## Idempotency

- Same archive → same content hash → same filename
- Overwrite file only; append semantics live in MANIFEST.json
- Task status: pending → running → completed/failed → dead
- After max_retries, task moves to `_dead/`

## Acceptance

- Enqueue: `--enqueue-from-latest` creates a task file
- Execute: `--worker --once` progresses status to `completed` and writes memory/ files
- Index update: MEMORY.md gets new entries
- Retry: bug fix + `--replay` reruns successfully
- Dead letter: too many retries moves to `_dead/`
