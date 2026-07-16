---
name: prd
description: Create, review, and update local PRD assets under `.agent/prd/` before architecture, prototype, planning, or implementation work.
---

# PRD Workflow (/prd)

## Usage

```text
/prd create <prd-id> "<title>"
/prd status [prd-id]
/prd review <prd-id>
/prd link-task <prd-id> <task-id>
/prd design <prd-id> --tool openpencil|figma|penpot|markdown --status draft|reviewed|ready
```

## Purpose

Turn user requirements into local, reviewable PRD assets that Dashboard, `/arch-design`, `/prototype`, `/plan`, and `/publish-docs` can consume.

## Data Layout

```text
.agent/prd/
├── index.json
├── prd.schema.json
└── PRD-001/
    ├── state.json
    ├── prd.md
    ├── user-stories.md
    ├── flows.md
    ├── screens.md
    ├── acceptance-criteria.md
    ├── decisions.md
    └── links.json
```

## Status Machine

```text
idea -> draft -> review -> approved -> designed -> implemented -> validated -> published
```

Use `blocked` when a missing decision or external dependency prevents progress.

## CREATE

1. Read the user requirement and existing `.agent/prd/index.json`.
2. Choose a stable PRD id, such as `PRD-001` or `PRD-<task-id>`.
3. Create the PRD folder from templates in `.agent/resources/templates/`.
4. Fill `state.json` with title, status, owner, related tasks, design state, review state, and `updated_at`.
5. Add the PRD to `.agent/prd/index.json`.
6. Run `/agent-dashboard` so the PRD appears in the PRD Studio panel.

## STATUS

Read `state.json` plus the required PRD files and report:

- PRD status
- design status
- review status
- completeness gaps
- related tasks
- recommended next command

## REVIEW

Check these required sections:

- context
- goals
- non-goals
- users
- requirements
- user stories
- flows
- screens
- acceptance criteria
- open decisions

If complete enough for implementation, move status to `approved`. If visual design is required, recommend `/prototype` or OpenPencil/Figma/Penpot linkage before `/plan`.

## Integration Rules

- `/arch-design` should read the latest approved or review PRD before writing architecture proposals.
- `/prototype` should use PRD `flows.md`, `screens.md`, and acceptance criteria when available.
- `/plan` should link tasks back to `state.json.related_tasks`.
- Dashboard should remain read-only and must not mutate PRD state.

