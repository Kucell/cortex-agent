---
name: mission-progress
description: 查询标准 Mission Lite 的里程碑状态、依赖关系与可并行工作；只读。
---

# Mission Progress

读取当前项目的 `.agent/missions/`，生成状态矩阵、Mermaid 依赖图和可执行里程碑清单。

```bash
node .agent/skills/mission-progress/scripts/report.js
node .agent/skills/mission-progress/scripts/report.js M-001 --parallel
node .agent/skills/mission-progress/scripts/report.js --blocked
node .agent/skills/mission-progress/scripts/report.js --format json
```

边界：仅支持 `/mission` 的标准目录和里程碑文件；只读，不自动扫描兄弟仓、不调用网络服务，也不改变 Mission 状态。
