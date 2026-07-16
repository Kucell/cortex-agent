# Runs

Run records describe concrete agent or workflow executions: planning, implementation, validation, merge, handoff, dashboard serving, or publishing.

Workflows should update run records through:

```bash
node .agent/skills/management-api/scripts/index.js runs upsert --run-id R-T005 --task-id T-005 --kind implement --status running --phase decomposing --activity "正在拆分任务"
node .agent/skills/management-api/scripts/index.js runs event --run-id R-T005 --type validation_started --phase validating --message "开始运行测试"
```

`status` is the lifecycle state. `phase`, `activity`, `events`, and `last_event` provide precise live progress for dashboards and future CLI queries.
