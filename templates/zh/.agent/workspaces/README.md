# Workspace Contracts

This directory defines the stable data boundary for Cortex Agent workspace orchestration. It is a contract layer, not an executable hook runner or external resource provisioner.

## Contracts

- `workspace-identity.schema.json`: one repository/worktree execution identity and its Run, Session, Queue, Lock, hook, and lease relations.
- `hook-lifecycle.schema.json`: setup, run, and teardown attempts with explicit ownership, authorization, timeout, redaction, evidence, retry, and compensation state.
- `resource-lease.schema.json`: local resource claims and adapter-backed namespaces with conflict, stale, release, and external-side-effect gates.
- `composite-workspace.schema.json`: two or more independent repositories correlated under one task without pretending their Git histories or merges are atomic.

## Ownership and safety

- `/worktree` owns WorkspaceIdentity lifecycle transitions.
- The workflow that invokes a hook owns HookLifecycle transitions and evidence.
- A future local lease manager owns ResourceLease allocation and release; read-only queries never clean state.
- `/mission` or `/parallel` owns CompositeWorkspace planning; each repository keeps its own worktree, branch, commits, validation, and merge approval.
- Credentials must never be stored in these records. Hook output is redacted, and external side effects require an approved Decision reference.
- Teardown and release are idempotent. Interrupted work remains inspectable as `failed`, `stale`, `recovering`, or another non-success state instead of being silently deleted.

## Compatibility

These schemas are additive. Existing projects without `.agent/workspaces/` continue to use the current `/worktree` behavior until a later milestone adds an explicit adapter and migration path.
