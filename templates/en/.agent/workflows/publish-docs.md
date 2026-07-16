---
name: publish-docs
description: Publish verified project knowledge from .agent/references and completed architecture proposals into standalone developer docs under docs/.
---

# Documentation Publishing Workflow (/publish-docs)

## Goal

Publish project knowledge from `.agent/` into `docs/` so developers have readable, linkable, and maintainable documentation outside the agent workspace.

`/publish-docs` extracts and sanitizes knowledge; it must not copy `.agent` content wholesale:

- `.agent/references/` is the internal fact base maintained by `/scan-project` and `/update-refs`
- `.agent/plans/proposals/` contains architecture decision history; publish only `status: done` or user-confirmed conclusions
- `docs/` is developer-facing documentation and must remain understandable without reading `.agent/`

## Usage

```text
/publish-docs
/publish-docs <module>
/publish-docs <target docs directory>
/publish-docs --architecture
```

By default, publish only the current task, current diff, or explicitly requested scope. Do not rewrite all of `docs/` without a clear reason.

## Process

### Step 1: Determine Scope

First output a publishing plan:

```text
Source files:
  - .agent/references/<module>.md
  - .agent/plans/proposals/<topic>/<proposal>.md
  - .agent/plans/proposals/projects/<project-slug>/index.md
  - <code paths used for verification>

Target files:
  - docs/<target>/README.md
  - docs/<target>/<topic>.md

Out of scope:
  - task handoff / prompt / model config / temp debug / secrets
```

Scope rules:

1. Prefer the matching `.agent/references/*.md` for the target module
2. For architecture decisions, read only completed or user-approved proposals under `.agent/plans/proposals/`
3. For a project-level proposal group, use `projects/<project-slug>/index.md` as the entry: first confirm the project or target milestone is finalized, then follow the index to relevant child proposals that are completed or explicitly approved by the user
4. Re-check the current code for paths, APIs, commands, dependencies, and configuration
5. If `.agent/references/` is missing or stale, suggest `/scan-project` or `/update-refs` first
6. If no module is specified, only handle modules related to the current task or git diff

Project-level publishing order:

1. Start with the finalized `index.md` and distill the project goal, scope, milestones, and final decisions into a standalone overview
2. Then reference completed child proposal conclusions as needed; do not publish unapproved child proposals or process discussion
3. Treat child proposals, `decisions/`, and `relations.md` as fact sources only; published `docs/` must not retain a reading dependency on `.agent/`

### Step 2: Choose Document Location

Prefer the existing project `docs/` structure. If the project has no clear convention, use:

```text
docs/
  README.md
  architecture/
    README.md
  modules/
    README.md
    <module>/
      README.md
```

Projects may override the mapping locally, for example:

- Frontend pages: `docs/pages/<page>/README.md`
- Micro-apps: `docs/micro-apps/<app>/README.md`
- Packages: `docs/packages/<package>/README.md`
- Backend services: `docs/services/<service>/README.md`

Do not hard-code one project's business directory names into the framework template.

### Step 3: Generate Content

Module docs should usually include:

1. Module purpose and boundary
2. Core capabilities
3. Key architecture and component relationships
4. Data flow or call flow
5. Important code paths
6. Development and debugging commands
7. Constraints, caveats, and common pitfalls
8. Validation steps

Architecture docs should usually include:

1. Background and problem
2. Final decision
3. Option comparison summary
4. Key flowchart or structure diagram
5. Impact scope
6. Migration and rollback strategy
7. Follow-up task links

Use `.agent/resources/templates/published-doc.md` as a starter structure when useful.

### Step 4: Sanitize and Boundaries

Content published to `docs/` must:

- Not depend on `.agent/` paths as body text, index links, or reader entry points
- Not expose prompts, model config, agent routing, handoffs, temporary debug files, machine paths, credentials, tokens, or private network addresses
- Not present task progress notes as documentation conclusions
- Not publish unapproved architecture drafts unless explicitly marked as drafts
- Not copy large internal notes; publish curated conclusions

### Step 5: Maintain Indexes

After publishing, update relevant indexes:

- `docs/README.md`: project documentation entry point
- `docs/<category>/README.md`: category index
- `docs/modules/README.md` or a project-specific module index
- Use relative links between published documents

### Step 6: Validate

Run at least:

```bash
test -d docs
find docs -name README.md -type f | sort
rg -n "\.agent/" docs && exit 1 || true
git diff --check
```

Also manually confirm:

- Relative links point to real files
- Code paths, commands, and APIs were verified against current code
- The diff does not include unrelated code changes
- No secrets, machine credentials, temporary logs, or internal governance details were published

## Workflow Integration

- `/scan-project`: creates `.agent/references/` during initial setup and feeds `/publish-docs`
- `/update-refs`: refreshes the fact base after iteration or refactoring before docs are published
- `/arch-design`: after an architecture proposal is approved, call `/publish-docs --architecture` for developer-facing architecture docs
- `/ship`: after `/update-refs`, enter the optional `PUBLISH_DOCS` phase when user-facing docs are affected
- `/agent-update`: maintains this workflow or project-local docs mapping rules
