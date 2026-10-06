# GitHub-native shared Agent repository use case

## Status

Use-case / architecture input only.

This document intentionally does **not** prescribe an implementation. It captures a real project workflow that is not fully covered by the current local-worktree + shared-filesystem collaboration model, so Cortex Agent can evaluate an appropriate design.

## Summary

Cortex Agent already supports parallel development through Tasks, Missions, `/parallel`, Worktree isolation, Queue, Progress Lock, Run journal, Handoff, Decisions and Waitpoints.

The current worktree collaboration model assumes multiple execution workspaces can share one physical `.agent/` and `.agent-runtime/` through local filesystem links.

A second collaboration mode is needed for environments where agents do not share a local filesystem at all.

A representative case is:

- development is performed from multiple Web Chat sessions;
- every session operates GitHub directly through API / remote repository actions;
- sessions create or update independent GitHub branches rather than local Git worktrees;
- no persistent developer workstation is assumed;
- different sessions may be active at the same time;
- all sessions still need one authoritative project governance state.

In this environment, local symlink-based `.agent` sharing is unavailable.

## Real business scenario

A welding simulation platform is managed by Cortex Agent.

The product repository has several independent workstreams:

- A: production deployment foundation;
- B: welding timeline / integrated simulation experience;
- C: production activation readiness;
- D: AI geometry / 2D-to-3D pipeline.

Each workstream may be handled by a different Web Chat session.

The user expects to issue commands such as:

- "check A line";
- "continue B line";
- "pause C line";
- "show all parallel workstreams";
- "continue every non-blocked task in parallel".

The user also expects every session to see the same facts:

- current Task / Mission stage;
- active Queue items;
- current Run state;
- workspace / branch ownership;
- Progress Locks and owned files;
- Handoff state;
- Decisions and Waitpoints;
- latest validation / review artifacts;
- blockers and recommended next action.

## Current local collaboration model

The current Worktree design works well when all worktrees exist on the same machine:

```text
primary worktree
  .agent/
  .agent-runtime/

child worktree A
  .agent -> primary/.agent
  .agent-runtime -> primary/.agent-runtime

child worktree B
  .agent -> primary/.agent
  .agent-runtime -> primary/.agent-runtime
```

This keeps governance state shared while source worktrees remain isolated.

## Gap in GitHub-native Web Chat environments

With remote-only Web Chat sessions, the topology instead looks like:

```text
Session A -> GitHub branch A
Session B -> GitHub branch B
Session C -> GitHub branch C
Session D -> GitHub branch D
```

There is no common local path that can be used as:

```text
primary/.agent
```

If every feature branch carries its own tracked copy of `.agent/`, governance state forks together with code.

Example:

```text
branch A:
  Task A = validate
  Task B = implement

branch B:
  Task A = implement
  Task B = validate
```

Both branches can be internally valid while presenting contradictory project state.

Merging feature branches then also creates unnecessary conflicts in:

- tasks;
- missions;
- queues;
- runs;
- locks;
- artifacts;
- decisions;
- waitpoints;
- activity journals.

This is especially problematic because the governance state is intended to coordinate the branches rather than be duplicated by them.

## Desired conceptual model

The requested model separates the product repository from the project governance repository.

Example:

```text
product repository
  org/project

governance repository
  org/project-agent
```

The governance repository owns the project-level Cortex state.

Its repository root corresponds to the project's logical `.agent/` content:

```text
project-agent/
  tasks/
  missions/
  queues/
  runs/
  locks/
  handoffs/
  artifacts/
  decisions/
  waitpoints/
  registry/
  workspaces/
  plans/
  rules/
  workflows/
  skills/
  ...
```

The product repository remains focused on source code, tests, deployment assets and product documentation.

## Desired remote collaboration flow

A Web Chat session should be able to:

1. resolve the product repository to its canonical governance repository;
2. read shared Task / Mission / Queue / Run / Lock state from that governance repository;
3. identify the exact product branch / PR owned by its task;
4. verify Decisions / Waitpoints and write scope before editing code;
5. update product code only in the assigned product branch;
6. append or reconcile governance evidence back into the shared governance repository;
7. allow other sessions to observe the new state without merging the product branch first.

Conceptually:

```text
                 +--> product branch A
                 |
shared governance +--> product branch B
repository        |
                 +--> product branch C
                 |
                 +--> product branch D
```

## Important property: governance state must not fork with feature code

For this mode, project governance state should have one canonical source.

Feature branches may reference governance objects, but they should not independently own divergent copies of the same Queue, Lock, Decision, Waitpoint or Task state.

The system should distinguish:

- code history;
- project governance history;
- ephemeral runtime state.

These three lifecycles do not necessarily have the same branch topology.

## Relationship to Cortex Agent self-bootstrapping

Cortex Agent already demonstrates that an Agent workspace can live in a separate repository from its primary source repository.

The new requirement is broader than self-bootstrapping:

- the detached Agent repository is a project-level collaboration control plane;
- multiple remote sessions use it concurrently;
- the sessions may edit different branches in another repository;
- no local filesystem sharing is assumed.

The existing self-bootstrapping repository relationship therefore appears to be a useful precedent, but not yet a complete solution for this usage pattern.

## Parallel development expectations

The existing `/parallel` semantics should remain authoritative.

The desired remote mode should still preserve:

- dependency analysis;
- `shared | locked | worktree | serial` isolation decisions, or an equivalent remote interpretation;
- explicit `owned_files`;
- Queue state;
- task / file locks;
- Run journal;
- independent validation;
- Handoff;
- merge approval;
- post-merge validation.

A GitHub branch must not automatically be considered safe for parallel execution merely because it is isolated at the Git level.

Shared contracts, migrations or common files still require serial coordination.

## Workspace identity in a remote-only environment

A WorkspaceIdentity may need to represent a remote Git workspace without requiring a local `worktree_path`.

Useful identity facts include:

- product repository ID;
- governance repository ID;
- task ID;
- mission ID;
- branch;
- base branch;
- base commit;
- current HEAD;
- pull request;
- owning agent / session;
- owned files;
- Queue item;
- Lock references;
- Artifact references.

The design should determine whether this is:

- an extension of the existing WorkspaceIdentity;
- a new workspace adapter;
- a repository-backed composite workspace;
- or another abstraction.

This document intentionally does not select one.

## Concurrency requirements

Multiple Web Chat sessions may attempt governance updates close together.

The design should account for optimistic concurrency and fail-closed writes.

Examples:

- branch A advances Task A;
- branch B appends validation evidence;
- branch C observes a Lock conflict;
- two sessions attempt to update a shared Queue projection.

Desired behavior:

- no silent last-writer-wins overwrite;
- conflicts are surfaced explicitly;
- append-only records are preferred when possible;
- derived indexes can be rebuilt from authoritative records;
- mutable shared projections should use a compare-and-swap / revision check or equivalent mechanism.

Git commit SHA / blob SHA based optimistic concurrency may be a useful transport primitive, but the architecture should decide the correct ownership model.

## Runtime state considerations

Not all Cortex state necessarily belongs in Git.

The design should explicitly classify:

1. durable governance state that should survive sessions and be auditable;
2. derived projections that can be rebuilt;
3. local ephemeral runtime state that should remain outside version control.

For example, local notification processes, temporary leases, host PIDs or machine-specific runtime files should not be blindly synchronized through a Git repository.

The remote model therefore needs a clear boundary between the detached governance repository and `.agent-runtime` semantics.

## Migration use case

Existing projects may already have a large tracked `.agent/` directory inside the product repository.

A migration path is needed that can:

1. preserve existing Task / Mission / Decision / Waitpoint / Artifact history;
2. create or attach a dedicated governance repository;
3. establish an explicit product-repo <-> agent-repo relationship;
4. reconcile active feature branches that still contain governance changes;
5. avoid losing currently open Decisions / Waitpoints;
6. avoid breaking active PRs;
7. optionally replace the product repository's `.agent/` with a reference, submodule, generated anchor or another supported mechanism;
8. verify the migrated governance state before deleting / untracking the original copy.

The migration should be resumable and fail closed.

## Example repository topology

```text
org/welding-simulation
  main
  feat/production-deployment
  feat/welding-timeline
  feat/geometry-ai

org/welding-simulation-agent
  main
    tasks/
    missions/
    queues/
    runs/
    locks/
    decisions/
    waitpoints/
    artifacts/
    workspaces/
```

Possible associations:

```text
Task PROD-DEPLOY
  workspace -> org/welding-simulation:feat/production-deployment

Task WELD-TIMELINE
  workspace -> org/welding-simulation:feat/welding-timeline

Task GEOMETRY-AI
  workspace -> org/welding-simulation:feat/geometry-ai
```

All tasks still share the same governance repository.

## User-facing expectations

The user should be able to use stable human commands independent of the current session:

```text
check production deployment
continue welding timeline
show all parallel tasks
show conflicts
pause task X
resume task X
```

A new session should not require the user to re-explain prior project state.

The agent should recover current facts from the shared governance source and then verify the associated product branch / PR / CI.

## Non-goals

This use case does not request:

- automatic approval of Decisions;
- bypassing Waitpoints;
- automatic merge of product branches;
- removal of existing local Worktree support;
- treating Git branch isolation as a replacement for Progress Lock;
- synchronizing credentials or secrets through Git;
- storing all machine-local runtime state in the detached repository.

## Design questions for Cortex Agent

1. Should detached project governance repositories become a first-class Cortex concept?
2. How should a product repository declare its canonical governance repository?
3. Should the relationship use a submodule, anchor metadata, config reference, repository descriptor, or adapter?
4. How should `--project` resolve product root vs Agent root when they live in different Git repositories?
5. How should WorkspaceIdentity model remote-only GitHub branches?
6. What is the ownership model for Git-backed Queue / Run / Lock updates?
7. Which state should remain append-only and which may be mutable?
8. Which parts of `.agent-runtime` are inherently local and must remain outside the detached governance repository?
9. How should active PRs be reconciled during migration?
10. Can Management API / MCP expose the detached shared state without requiring a local checkout?
11. How should GitHub API optimistic concurrency failures be surfaced to `/parallel` and `/worktree`?
12. Should Dashboard show both the shared governance repository and the remote product workspace branch / PR?
13. Should `/parallel` gain a GitHub-native execution isolation mode, or should this be expressed through a workspace adapter?
14. Can the existing self-bootstrapping model be generalized safely without coupling Cortex Agent to GitHub specifically?

## Acceptance scenarios for a future design

### Scenario A: two remote sessions, independent code branches

- Session A owns Task A and branch A.
- Session B owns Task B and branch B.
- Both read the same project Task / Queue / Lock state.
- A progress update is observable by B without merging branch A.
- Neither session can overwrite the other's lock or task progress silently.

### Scenario B: shared contract conflict

- Task A and Task B both need to modify one shared contract.
- Even though they use different Git branches, Cortex detects overlapping ownership.
- The result is serial / blocked, not "parallel because branches differ".

### Scenario C: approval gate

- Task B reaches a Decision / Waitpoint.
- Session A can observe that B is blocked.
- Session A cannot release or bypass B's gate unless the owning workflow and approval rules permit it.

### Scenario D: Web Chat restart

- All browser / chat sessions are closed.
- A new session starts later.
- It can recover Task / Mission / Decision / Waitpoint / Artifact state from the shared governance source.
- It then verifies the latest associated product branch HEAD and CI before continuing.

### Scenario E: migration from embedded `.agent`

- Existing product repository has years of Agent history.
- The history is moved or imported to the detached governance repository.
- Existing open governance objects remain addressable.
- Active product PRs remain usable.
- The project does not temporarily have two authoritative governance sources.

## Why this matters

Cortex Agent already has strong primitives for parallel engineering.

Supporting a detached, shared governance repository would allow those same primitives to work in a growing class of environments where the execution agents are remote and ephemeral:

- Web Chat coding;
- GitHub-native agents;
- cloud coding agents;
- multi-session AI development;
- agents running in separate hosted sandboxes;
- teams where no shared developer filesystem exists.

The desired outcome is not "Git-based collaboration instead of Cortex governance".

The desired outcome is:

> preserve Cortex governance while replacing the shared local filesystem assumption with a supported remote collaboration boundary.
