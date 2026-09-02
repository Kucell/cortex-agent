---
name: mission-progress
description: 查询 Mission Lite 的里程碑状态、依赖关系与可并行工作；全程只读。
aliases: [progress-plan, briefing-progress, mission-status, check-progress]
---

# Mission Progress

当用户要检查 Mission 进度、阻塞链、依赖关系或可并行里程碑时使用。它只读取当前项目的标准 `.agent/missions/` 目录，不写入文件、不调用网络，也不推进任何 Mission 状态。

```bash
node .agent/skills/mission-progress/scripts/report.js
node .agent/skills/mission-progress/scripts/report.js M-001 --parallel
node .agent/skills/mission-progress/scripts/report.js --blocked
node .agent/skills/mission-progress/scripts/report.js --graph-only
node .agent/skills/mission-progress/scripts/report.js --format json
```

可用参数：`<mission-id>...`、`--cwd <project-root>`、`--parallel`、`--blocked`、`--graph-only`、`--format md|json`。

边界：输入必须符合 `/mission` 工作流的标准目录与 `milestones/MS-XXX.md` 约定。跨项目比较须由用户显式调用并分别收集结果；本 skill 不会自动扫描相邻仓库。
