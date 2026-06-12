# Artifact Bus

Artifact Bus 为 Multi-Agent Coordinator 保存紧凑的结构化协调产物。

它不是源码归档。这里只保存引用、摘要、JSON payload、路径和 commit ref。不要保存完整源码、长 diff、PRD 或长命令日志。

## 目录结构

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

## 命令

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

## 规则

- Artifact 文件 append-only，并按序号命名。
- `state.json` 是 resume 决策用的紧凑窗口。
- `refs` 应尽量指向已有文档、日志、commit 或文件。
- Payload 应保持紧凑且机器可读。
