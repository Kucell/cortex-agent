---
name: retrieval-trajectory
description: Record and replay retrieval trajectories (inspired by OpenViking's observable retrieval). After every context-budget / knowledge-retrieval / skill-selector execution, writes `.agent/runtime-evidence/trajectory/{task-id}_{ts}.jsonl`. Supports replay, URI resolution verification, and fixture export.
area: agent-tuning
summary: Record and replay retrieval trajectories (inspired by OpenViking's observable retrieval). After every context-budget / knowledge-retrieval / skill-selector execution, writes `.agent/runtime-evidence/t
---

# Retrieval Trajectory

## Goal

Turn retrieval from a black box into observable data. cortex-agent adopts OpenViking's directory-browsing trajectory model:

1. **Record**: `context-budget/scripts/select.js` writes to `trajectory/{task-id}_{ts}.jsonl` during scoring and greedy fill.
2. **Replay**: `replay.js` reconstructs each decision step.
3. **Verify**: `--verify-resolve` resolves every `cortex://` URI back to a path, catching "URI stale, path stale" mismatches.
4. **Fixture**: `--as-fixture` exports a deterministic JSON for e2e tests.

## Location

```text
.agent/runtime-evidence/trajectory/
└── {task-id}_{iso-timestamp}.jsonl
```

Each line is a JSON event with type:
- `header` — task metadata (task_id / task / scoring_strategy / l0_l1_available)
- `step` — one decision (scan / tokenize / score / promote / l0_only / load / skip / error)
- `summary` — closing summary (step_count / promoted_count / total_tokens)

Full schema in `trajectory.schema.json`.

## Usage

### 1. Auto-written by context-budget

`context-budget/scripts/select.js` already writes trajectories in the main path. No extra setup.

### 2. Manual append (custom retrieval scripts)

```bash
node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 \
  --step 1 --action scan --candidates 42

node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 \
  --step 3 --action promote --tier tier1 \
  --uri "cortex://skills/context-budget" \
  --tokens 1200 --reason "score=9"

node .agent/skills/retrieval-trajectory/scripts/record.js \
  --task-id T-DEMO-001 --summary
```

### 3. Replay last task

```bash
node .agent/skills/retrieval-trajectory/scripts/replay.js --task-id T-DEMO-001

# Also verify URI resolution
node .agent/skills/retrieval-trajectory/scripts/replay.js \
  --task-id T-DEMO-001 --verify-resolve

# Export as test fixture
node .agent/skills/retrieval-trajectory/scripts/replay.js \
  --task-id T-DEMO-001 --as-fixture
```

## Boundaries

- **Does not record** actual L2 content (avoids leakage + log bloat).
- **Not streaming** — line-by-line append, last line may be lost on crash.
- **No auto-archive** of trajectories > 30 days (future entropy-scanner).
- **Not mandatory** — scripts just log `error` action on failure.

## Acceptance

- Write rate: 100% of context-budget calls produce ≥ 3 lines (header + scan + score).
- Replay pass: same task-id, unchanged context-index.json → `--verify-resolve` 100% pass.
- Fixture reuse: e2e test reads fixture → reruns task → compares `expected_promoted` set.
