# PRD Workspace

`.agent/prd/` stores local product requirement documents and their structured state.

Each PRD should live in its own folder:

```text
.agent/prd/PRD-001/
├── state.json
├── prd.md
├── user-stories.md
├── flows.md
├── screens.md
├── acceptance-criteria.md
├── decisions.md
└── links.json
```

Dashboard and Management API use these files to show PRD completeness, design readiness, related tasks, review state, and next actions.

