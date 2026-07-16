---
id: 0007-mission-task-decomposition
target: workflows/mission.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## Mission Breakdown Rule Integration

When creating a mission, read `.agent/rules/task-decomposition.md` and use `.agent/resources/templates/task-breakdown.md` when helpful to decide:

- Which work must become prerequisite architecture, interface, or migration milestones
- Which milestones can run read-only research, validation, or documentation in parallel
- Which implementation tasks must stay serial to avoid same-file or same-contract conflicts
- Whether each milestone has independent, recoverable, and verifiable acceptance criteria
