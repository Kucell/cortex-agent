---
id: 0010-worktree-mission-coordination
target: workflows/mission.md
anchor: ".agent/rules/worktree-collaboration.md"
---

---

## Mission Worktree Coordination Addendum

When multiple mission milestones can progress in parallel, read `.agent/rules/worktree-collaboration.md` and record in the mission plan:

- worktree path / branch / owner agent for each milestone
- base commit and target merge branch for each worktree
- handoff, Artifact Bus, and lock state references
- timely commit points for each worktree
- post-merge mainline validation commands and evidence requirements

A mission cannot complete just because a child worktree passed validation; it must pass validation again in the merge target worktree before COMPLETE.
