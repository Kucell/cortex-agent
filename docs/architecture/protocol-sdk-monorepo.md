# Protocol, SDK and Progressive Monorepo

> **Status**: M-040 MS-002 baseline  
> **Validated**: 2026-09-29  
> **CI**: M-040 Architecture Validation run 36519997237 — PASS

## 1. Purpose

Cortex Agent now uses a progressive pnpm workspace to isolate stable contracts and SDK surfaces without moving existing authoritative implementation owners out of `lib/` prematurely.

The root `cortex-agent` package remains the primary CLI/template distribution package.

## Repository boundary: monorepo does not include .agent governance

The progressive monorepo applies **only to `Kucell/cortex-agent`**.

`Kucell/cortex-agent-agent` remains an independent repository that manages development of Cortex Agent through the project's `.agent` governance state.

Therefore:

- `packages/*` are product/source package boundaries;
- `cortex-agent-agent` is not a pnpm workspace member;
- the root npm artifact must not package the project's private development `.agent`;
- CI may materialize the governance repository into a temporary `.agent` path only to reproduce the development/test environment;
- package publishing and runtime installation must remain independent of the governance repository.

```text
Kucell/cortex-agent
  ├─ package.json
  ├─ packages/*
  ├─ lib/*
  └─ ...

Kucell/cortex-agent-agent
  └─ independent project-development governance repository
     (mounted/materialized as cortex-agent/.agent when required)
```

## 2. Workspace layout

```text
cortex-agent/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── packages/
│   ├── protocol/
│   └── sdk/
├── lib/
├── bin/
├── templates/
└── docs/
```

Future M-040 packages may include:

```text
packages/runtime-port/
packages/project-sdk/
packages/extension-sdk/
```

They are not introduced until their milestone boundaries are ready.

## 3. @cortex-agent/protocol

The protocol package is portable and implementation-free.

Current responsibilities:

- opaque typed refs;
- protocol version constants;
- canonical result/error envelope;
- canonical capability identifiers/namespaces.

Current ref kinds:

```text
project
workspace
run
agent
host
runtime
session
```

Examples:

```text
project:axrail
runtime:paseo-local
host:mac-mini
```

The protocol package MUST NOT depend on filesystem, child_process, Management implementation, UI, Paseo, Axrail, or provider SDKs.

## 4. @cortex-agent/sdk

The SDK is a stable consumer facade and owns no persistence.

Current read-first surface:

```text
client.project.resolve()
client.capabilities.discover()

client.management.query()
client.management.capabilities()

client.tasks.get()

client.runs.list()
client.runs.get()

client.decisions.list()
client.waitpoints.list()

client.coordination.tasks.list()
client.coordination.tasks.get()

client.topology.get()
```

The SDK transport may be synchronous or asynchronous. This preserves the existing synchronous CLI while allowing future remote transports.

## 5. Local transport

`lib/sdk/local-transport.js` bridges the SDK to existing authoritative owners:

```text
SDK
 └─ local transport
     ├─ Management API
     └─ Topology
```

It does not write a new state store.

Project identity is resolved from topology `self.project_id` first, with repository directory basename only as a compatibility fallback.

## 6. First migrated public surface

`cortex-agent query <projection>` now routes reads through:

```text
CLI query
  -> createLocalCortexClient()
  -> SDK management facade
  -> local transport
  -> Management API
```

Compatibility preserved:

- projection filtering;
- `--project`;
- exact projection filters;
- output envelope;
- exit-code behavior;
- legacy projects without the capabilities projection.

## 7. Capability identifier model

Canonical capability IDs are namespaced strings.

Examples:

```text
management.query
tasks.read
runs.read
topology.read
runtime.run.create
project.validation.run
extension.event.consume
```

Current top-level namespaces include management, tasks, runs, decisions, waitpoints, coordination, topology, runtime, project, and extension.

M-040 MS-003 extends this with protocol-version negotiation and compatibility rules.

## 8. Packaging compatibility

The root package includes `packages/` in its npm artifact so internal SDK fallback imports work without npm workspace links.

Standalone workspace packages can use normal package dependencies.

The root package remains installable as one package.

## 9. Validation

The focused validation workflow verifies:

1. Node 24.19.0
2. pnpm 11.13.1
3. `pnpm install --frozen-lockfile`
4. architecture boundary tests
5. capability contract tests
6. SDK tests
7. local transport tests
8. existing Management query CLI regression tests

Validated result:

```text
25 tests
25 pass
0 fail
```

## 10. Non-goals

MS-002 does not move all `lib/` implementation into packages, publish every workspace package, introduce a second persistence model, create RuntimePort, create Project SDK, create Extension SDK, or introduce Nx/Turbo/Lerna.
