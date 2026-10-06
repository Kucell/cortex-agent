# Remote & Detached Governance — MS-001 Contract Baseline

> Status: implementation baseline
> Authorization: D-RDG-MS001-20261006
> Scope: contract freeze only; no remote backend or provider network implementation

## Position

Cortex already has a portable project identity contract in `cortex.project.json` through `@cortex-agent/project-sdk`.

Remote & Detached Governance extends that existing contract instead of introducing a second project manifest.

```text
cortex.project.json
  ├── project_id              stable ProjectIdentity
  ├── repository
  ├── integration_mode
  ├── capabilities
  ├── validation / artifacts / boundaries
  └── governance              optional GovernanceBinding
```

Legacy descriptors without `governance` remain valid.

## Frozen contracts

### GovernanceBinding

```text
kind    = filesystem | git
locator = portable locator
ref     = optional revision/branch ref
```

The binding is discovery metadata only. It must not contain mutable Task, Mission, Decision, Waitpoint, Lock, Queue or Run state.

### GovernanceStoreCapabilities

A store exposes explicit booleans for read, write, compare-and-write, append, history and watch. Provider-specific API names do not enter the core contract.

### ExecutionWorkspaceIdentity

Execution identity is no longer synonymous with a local worktree.

Supported kinds:

- local-worktree
- git-remote
- cloud-sandbox
- composite

Only `local-worktree` requires `worktree_path`. A `git-remote` workspace is identified by repository + branch/revision facts.

### RevisionToken / RevisionConflict

Remote shared writes must fail closed on revision mismatch. `RevisionConflict` is the stable Cortex error surface; Git blob SHA, commit SHA, ETag or provider-specific compare tokens remain backend details.

### StateClass

- durable
- derived
- ephemeral

This vocabulary is frozen before any Git-backed store implementation.

### Governance Lock vs Runtime Lease

`GovernanceLockClaim` is a durable logical ownership claim that may be shared across agents.

`RuntimeResourceLease` is host-local process/resource state (port, PID, socket, namespace, process) and is not Git-backed authoritative governance.

### Rebind transaction

The cutover ordering is frozen as:

```text
prepare
→ copy
→ verify
→ freeze-old-authority
→ flip-canonical-binding
→ verify-new-authority
→ archive-old-source
→ completed
```

Rollback is a separate terminal state before finalization. No implementation may permit two writable authoritative governance sources.

## Compatibility

MS-001 is additive:

- existing Connected Project descriptors remain valid;
- existing Embedded projects are not migrated automatically;
- local worktree behavior is unchanged;
- no GitHub/GitLab/Gitee dependency is introduced;
- no network I/O is added by these contracts.

## Deferred to later milestones

- Git-backed storage implementation;
- provider adapters;
- remote mutations;
- attach/rebind CLI;
- migration I/O;
- Management API remote resolution;
- Dashboard remote views;
- remote /parallel mutation.
