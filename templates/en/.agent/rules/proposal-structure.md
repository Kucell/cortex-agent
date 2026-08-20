---
title: Proposal Directory Structure
description: "The .agent/plans/proposals/ tree must support standalone proposals, project-level proposal groups, and related-project architecture programs at a glance: which project or topic a proposal belongs to, how child proposals relate, and which entry /approve, /plan, /mission, and /publish-docs should read."
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-08-06
status: stable
---
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

## Cross-Repository / Cross-Developer Sharing

Project proposal groups (`projects/<project-slug>/`) are self-contained directories and can be
shared as a whole with another developer or repository: once placed at the standard path
`.agent/plans/proposals/projects/<slug>/` on the receiving side, `/approve`, `/plan`,
`/mission`, and `/publish-docs` recognize them directly.

Notes (especially for dual-repo joint proposals):

- `.agent/` is usually gitignored, so **git clone/push cannot transport it**; use tar/zip
  packaging or direct directory copy.
- A dual-repo joint proposal must share BOTH volumes (the backend repo and the mobile repo
  `projects/<slug>/`).
- Absolute paths in `cross_project_peers`, `relations.md`, `index.md`, and topology
  `host_root` must be rewritten to local paths on the new machine.
- Shared decisions mirrored via symlinks (e.g. `decisions/D-xxx`) are flattened by packaging and
  must be re-linked after handover.

For one-command packaging / import use `/proposal-share` (`.agent/workflows/proposal-share.md`):
it collects proposals + missions + validation-contract + topology + peer volumes, tokenizes absolute
paths and rebuilds symlinks; runtime state (locks, branches, unmerged commits,
Decisions/Waitpoints/Runs) travels via the dual-format `/handoff` artifacts.

## Forbidden

- Do not place proposals directly under `.agent/plans/proposals/`.
- Do not commit `.DS_Store`, temporary files, or export caches under proposals.
- Do not use vague folder names such as `new`, `misc`, `test`, or `temp`.
- Do not use one huge proposal file for a large project that needs multiple sub-proposals.