---
name: mission-progress
description: Read Mission Lite milestone status, dependencies, and runnable work without changing project state.
aliases: [progress-plan, briefing-progress, mission-status, check-progress]
---

# Mission Progress

Use this skill to inspect Mission progress, dependency chains, blocked milestones, or independently runnable work. It reads only the current project's standard `.agent/missions/` layout: it does not write files, call network services, or advance Mission state.

```bash
node .agent/skills/mission-progress/scripts/report.js
node .agent/skills/mission-progress/scripts/report.js M-001 --parallel
node .agent/skills/mission-progress/scripts/report.js --blocked
node .agent/skills/mission-progress/scripts/report.js --graph-only
node .agent/skills/mission-progress/scripts/report.js --format json
```

Supported arguments: `<mission-id>...`, `--cwd <project-root>`, `--parallel`, `--blocked`, `--graph-only`, and `--format md|json`.

Boundary: input must use the standard `/mission` layout and `milestones/MS-XXX.md` convention. For cross-project comparison, explicitly collect each project; this skill never discovers neighbouring repositories automatically.
