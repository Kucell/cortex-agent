---
id: 0004-arch-design-proposal-subfolder
target: workflows/arch-design.md
anchor: "Never place a proposal directly under"
insert_after: "- **Write Proposal**: Provide clear design descriptions, recommended to include:"
---
- **Determine proposal path**: Before writing the file, derive the topic from the proposal subject and save it under:
  ```
  .agent/plans/proposals/<topic>/<short-name>-proposal.md
  ```
  - `topic` is the core module or business domain in kebab-case (e.g. `auth`, `device-template`, `state-management`)
  - Reuse an existing subfolder if one matches; create a new one if not
  - **Never place a proposal directly under `.agent/plans/proposals/`**

