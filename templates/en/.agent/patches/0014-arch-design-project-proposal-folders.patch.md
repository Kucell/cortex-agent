---
id: 0014-arch-design-project-proposal-folders
target: workflows/arch-design.md
anchor: "project-level proposal group"
insert_after: "- **Write Proposal**: Provide clear design descriptions, recommended to include:"
---
- **Project-level proposal folders**: Read `.agent/rules/proposal-structure.md` before creating a proposal, then decide whether it is standalone or part of a project-level proposal group.

  Continue to use this path for standalone proposals:
  ```text
  .agent/plans/proposals/<topic>/<short-name>-proposal.md
  ```

  Use a project folder for large or related projects, changes spanning multiple workflows/skills/CLI capabilities, validation across multiple real projects, or work requiring multiple child proposals:
  ```text
  .agent/plans/proposals/projects/<project-slug>/
    index.md
    proposals/P-001-<short-name>-proposal.md
    decisions/
    references.md
    relations.md
  ```
  - Create or update `index.md` with `.agent/resources/templates/proposal-project-index.md`
  - Record related projects, upstream and downstream dependencies, synchronization scope, and validation status in `relations.md`
  - Never place a proposal directly under `.agent/plans/proposals/`
  - Never commit `.DS_Store`, temporary files, or export caches
