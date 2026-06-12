# Artifact Bus

Artifact Bus stores compact, structured coordination artifacts for Multi-Agent Coordinator.

It is not a source archive. Store references, summaries, JSON payloads, paths, and commit refs. Do not store full source files, long diffs, PRDs, or long command logs.

## Layout

```text
.agent/artifacts/
├── artifact-schema.json
├── state-schema.json
├── scripts/
│   └── artifact-bus.js
└── T-xxx/
    ├── 001-plan.json
    ├── 002-execution.json
    ├── 003-review.json
    └── state.json
```

## Commands

```bash
node .agent/artifacts/scripts/artifact-bus.js append \
  --task-id T-C04 \
  --agent-id coordinator \
  --kind plan \
  --summary "Plan created" \
  --payload-json '{"steps":[]}' \
  --refs .agent/plans/task-progress.md,docs/architecture/multi-agent-coordinator.md

node .agent/artifacts/scripts/artifact-bus.js list --task-id T-C04
node .agent/artifacts/scripts/artifact-bus.js read --task-id T-C04 --seq 1
node .agent/artifacts/scripts/artifact-bus.js state --task-id T-C04
node .agent/artifacts/scripts/artifact-bus.js validate --task-id T-C04
```

## Rules

- Artifact files are append-only and named by sequence.
- `state.json` is a compact window for resume decisions.
- `refs` should point to existing docs, logs, commits, or files when possible.
- Payloads should remain compact and machine-readable.
