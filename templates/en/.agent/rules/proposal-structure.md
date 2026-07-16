# Proposal Directory Structure

## Goal

`.agent/plans/proposals/` must support small standalone proposals, project-level proposal groups, and related-project architecture programs. The directory structure must make it clear:

- which project or topic a proposal belongs to
- whether it is standalone or project-level
- how child proposals relate to each other
- which proposals are approved, in progress, or done
- which entry `/approve`, `/plan`, `/mission`, and `/publish-docs` should read

## Directory Modes

### 1. Standalone Proposal

```text
.agent/plans/proposals/<topic>/<short-name>-proposal.md
```

### 2. Project-Level Proposal Group

```text
.agent/plans/proposals/projects/<project-slug>/
  index.md
  proposals/
    P-001-<short-name>-proposal.md
    P-002-<short-name>-proposal.md
  decisions/
    D-001-<short-name>.md
  references.md
  relations.md
```

### 3. Related-Project Proposal Group

Continue to use `projects/<project-slug>/`, and maintain upstream projects, downstream validation projects, shared capabilities, upgrade scope, differences, verified projects, and pending projects in `relations.md`.

## When To Use A Project Folder

Use `projects/<project-slug>/` when any condition is true:

- The proposal has more than 3 phases.
- It touches more than 2 workflows, skills, or CLI capabilities.
- It incorporates feedback from more than 2 real projects.
- It needs multiple child proposals.
- It needs cross-project validation tracking.
- It needs its own dashboard, PRD, runtime, or task group.

## index.md

A project-level `index.md` should include:

```text
# <Project Name>

## Status
## Goal
## Scope
## Child Proposals
## Related Projects
## Milestones
## Current Decisions
## Next Steps
```

## Forbidden

- Do not place proposals directly under `.agent/plans/proposals/`.
- Do not commit `.DS_Store`, temporary files, or export caches under proposals.
- Do not use vague folder names such as `new`, `misc`, `test`, or `temp`.
- Do not use one huge proposal file for a large project that needs multiple sub-proposals.
