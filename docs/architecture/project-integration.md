# External Project Integration Contract

> **Status**: M-040 MS-009 baseline  
> **Reference pilot**: Kucell/axrail

## 1. Purpose

Cortex can govern software projects other than `cortex-agent` without requiring those projects to adopt Cortex's internal runtime/domain architecture.

Project Integration is separate from Runtime Integration.

```text
Cortex Governance
   ├─ Project Integration -> Axrail / HMI / Industra / autopeer / ...
   └─ Runtime Integration -> Native adapters / Paseo / future runtimes
```

Axrail is a project integration reference, not a RuntimePort backend.

## 2. Integration modes

### Embedded

The project installs/owns Cortex `.agent` governance directly.

### Connected

The project remains autonomous and exposes a stable `cortex.project.json` descriptor.

This is the Axrail pilot mode.

### Capability Bridge

The project provides a Project Adapter/Provider that implements selected capabilities behind explicit operations.

## 3. Project Descriptor

The portable `@cortex-agent/project-sdk` contract describes:

- project identity;
- repository identity;
- integration mode;
- provided/required capabilities;
- validation profiles;
- evidence/artifact paths;
- observational event source;
- authority boundaries.

It computes a canonical `ProjectRef`.

## 4. Project capabilities

Initial capability family:

```text
project.discover
project.validation.list
project.validation.run
project.artifact.list
project.event.read
```

A descriptor may declare a capability, but executable capabilities require a Project Adapter operation implementation.

## 5. Validation profiles

A connected project may declare validation profiles:

```json
{
  "id": "release-dry-run",
  "command": "pnpm release:dry-run",
  "purpose": "release gate",
  "blocking": true
}
```

The descriptor is data.

Reading it never executes the command.

Execution requires a controlled Project Adapter/CI boundary and remains subject to Cortex permission/approval policy.

The M-040 pilot validator deliberately accepts only simple `pnpm <script>` declarations and rejects compound shell commands.

## 6. Project Adapter

The Project Adapter contract separates discovery from execution.

A descriptor-only adapter can expose:

- project discovery;
- validation profile listing;
- artifact listing.

It cannot execute `project.validation.run` unless an explicit operation owner is supplied.

## 7. Authority boundaries

Every connected project declares:

- authoritative domain;
- authoritative runtime;
- Cortex role;
- protected components.

For Axrail:

```text
authoritative_domain  = axrail
authoritative_runtime = axrail
cortex_role           = governance-orchestration
```

Protected Axrail components include:

- HarnessRuntime
- ToolRuntime
- Policy
- Validation
- Approval
- TransactionRuntime
- EventStore
- EngineeringAdapters

Cortex must not create an alternate industrial execution path around these owners.

## 8. Project events

Project events are observational unless a separate governed command contract explicitly says otherwise.

Axrail may expose `@axrail/events` as an observational source.

Selected events may be projected into CortexEvent for Mission/evidence correlation.

```text
Axrail transaction.committed
  -> CortexEvent evidence

Axrail transaction.committed
  != Cortex Mission completed
```

## 9. Cross-project Mission composition

Connected projects compose with existing CompositeWorkspace/topology concepts.

```text
Mission
  ├─ cortex-agent workspace
  ├─ axrail workspace
  └─ product integration workspace
```

Each repository keeps independent Git history, validation and merge decisions.

## 10. Axrail pilot

Axrail contains a root `cortex.project.json` on the pilot branch.

Cortex's cross-repository validation:

1. checks out Cortex;
2. checks out Axrail pilot;
3. validates the descriptor with `@cortex-agent/project-sdk`;
4. verifies declared validation scripts and artifacts exist;
5. verifies Axrail authority boundaries;
6. installs Axrail with its own pnpm version;
7. executes Axrail's declared `release-dry-run` profile;
8. stores validation JSON + release log as workflow evidence.

This validates a real external project without importing Axrail runtime code into Cortex core.

## 11. Security invariants

- descriptor != authorization;
- project capability != Cortex permission;
- validation declaration != automatic shell execution;
- project events != commands;
- external domain ownership stays external;
- Cortex never assumes an external runtime is sandboxed;
- project-specific logic stays behind project adapters/pilot integrations, not Cortex protocol core.
