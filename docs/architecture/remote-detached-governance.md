# Remote & Detached Governance

> Status: delivered architecture
> Project: Cortex Agent
> Scope: ProjectIdentity + GovernanceStore + ExecutionWorkspace + reconciliation + remote parallel coordination

## Position

Cortex Agent treats project governance as durable project state rather than state owned by one local checkout or one AI session.

> **Develop anywhere. Resume everywhere. Keep one authoritative project state.**

The core model is:

```text
Cortex Project
├── ProjectIdentity
├── GovernanceStore
├── ExecutionWorkspace(s)
└── Execution Agent(s)
```

- **ProjectIdentity** is stable across devices, sessions, workspaces and governance-store migration.
- **GovernanceStore** owns durable Task / Mission / Decision / Waitpoint / Queue / logical Lock / Handoff / evidence state.
- **ExecutionWorkspace** describes where code work happens: local worktree, remote Git branch, cloud sandbox or composite workspace.
- **Execution Agent** is an ephemeral worker. It can attach, work, checkpoint, handoff and detach, but it does not own project truth.

## Project bootstrap

Cortex reuses the existing portable `cortex.project.json` descriptor.

```json
{
  "schema_version": 1,
  "project_id": "cortex-project-...",
  "repository": {
    "slug": "org/product",
    "default_branch": "main"
  },
  "governance": {
    "kind": "filesystem",
    "locator": ".agent",
    "ref": null
  }
}
```

The descriptor contains identity and discovery metadata only. Mutable governance objects never live in the descriptor.

`cortex-agent init` creates or preserves the stable `project_id` and defaults to embedded local governance:

```text
project/
├── cortex.project.json
└── .agent/
```

## Governance modes

### Embedded local

```text
product/.agent/
```

This remains the default low-friction experience.

### Detached local

```text
product/.agent -> ../product-agent
```

Multiple local worktrees may share one authoritative governance root.

### Git-backed / remote-ready

```text
Product repository
    |
cortex.project.json
    |
GovernanceBinding
    |
GitGovernanceStore
```

The product repository and governance repository may use different hosting providers. Provider-specific terminology stays behind adapters.

## GovernanceStore

Current backends:

- `FilesystemGovernanceStore`
- `GitGovernanceStore`

The common capability model includes:

- read
- write
- compare-and-write
- append
- history
- watch

Shared mutation uses expected-revision / CAS semantics.

```text
read R17
  ↓
prepare mutation
  ↓
write expected=R17
  ├─ success → R18
  └─ changed → RevisionConflict
```

Silent last-writer-wins is not allowed.

## Provider abstraction

```text
Cortex Core
   ↓
GovernanceStore
   ↓
GitGovernanceStore
   ↓
RemoteGitProvider
   ↓
GitHub / GitLab / Gitee / Generic Git
```

Portable concepts:

- Repository
- Branch
- Revision
- ChangeRequest
- Check
- Artifact
- Identity

Provider-specific names such as pull request, merge request, GitHub Actions or GitLab Pipeline do not enter the core governance schema.

See [Provider Capability Matrix](provider-capability-matrix.md).

## ExecutionWorkspace

Supported workspace kinds:

- `local-worktree`
- `git-remote`
- `cloud-sandbox`
- `composite`

Only `local-worktree` requires `worktree_path`.

A remote workspace can be identified by:

```text
repository_id
branch
base_revision
head_revision
change_request
task_id
mission_id
session_id
```

This allows Web Chat / Cloud Agent sessions to participate without a shared filesystem.

## State classification

Governance migration does not copy every runtime file blindly.

### Durable

Examples:

- Tasks
- Missions
- Decisions
- Waitpoints
- Queues
- logical ProgressLock / owned_files
- Handoffs
- validation evidence metadata
- durable Run / Operation facts
- plans / rules / architecture records

### Derived

Examples:

- indexes
- dashboard projections
- summaries
- health aggregates

Derived state may be rebuilt.

### Ephemeral

Examples:

- PID
- socket
- process/resource lease
- watcher state
- local notification cursor
- temporary cache
- machine-specific process data
- credentials

Ephemeral state is not promoted into Git-backed authoritative governance.

## Migration and rebind

A governance-store move is an explicit transaction:

```text
PREPARE
→ COPY
→ VERIFY
→ FREEZE OLD AUTHORITY
→ FLIP CANONICAL BINDING
→ VERIFY NEW AUTHORITY
→ ARCHIVE OLD SOURCE
→ COMPLETED
```

Properties:

- ProjectIdentity is preserved.
- old authority is retained as an archive, not silently deleted.
- machine-local state is excluded.
- unclassified state fails closed.
- rollback is supported across the safe boundary.
- no two writable authoritative sources are allowed.

## Reconciliation and controlled resume

Attaching a new environment is not equivalent to blindly resuming work.

Cortex compares:

- governance snapshot revision;
- expected workspace head;
- observed product branch head;
- ChangeRequest revision;
- provider checks;
- Decision / Waitpoint / logical Lock state.

The read-only engine returns:

- `READY`
- `BLOCKED`
- `RECONCILIATION_REQUIRED`
- `DEGRADED`

```text
collect facts
  ↓
compare expected vs observed
  ↓
classify drift / gates / warnings
  ↓
controlled resume decision
```

Reconciliation never performs repair by itself. It does not release locks, resolve Decisions, release Waitpoints, rebase, merge or mutate the workspace.

## Remote /parallel

Remote sessions continue to use the existing `/parallel` isolation model:

- shared
- locked
- worktree
- serial

Remote coordination adds a GovernanceStore-backed shared layer for:

- Queue
- logical progress lock
- `owned_files`
- Decision read gates
- Waitpoint read gates

Two sessions reading the same revision cannot both silently win:

```text
Session A reads R17
Session B reads R17

A writes expected=R17 → R18
B writes expected=R17 → RevisionConflict
```

A remote workspace does not need a local `worktree_path`.

## Project health surfaces

One shared read-only `project-health` projection is consumed by:

- SDK
- Management-facing local transport
- MCP
- Dashboard

The projection reports:

- ProjectIdentity
- GovernanceBinding
- store accessibility
- store capabilities
- governance revision
- reconciliation summary

A remote locator with no bound transport is reported as `unavailable/degraded`; Cortex does not fabricate a healthy state.

## Provider validation status

| Provider | Core adapter | Conformance | Live end-to-end |
| :--- | :---: | :---: | :---: |
| GitHub | ✅ | ✅ | ✅ |
| GitLab | ✅ | ✅ | Not claimed |
| Gitee | ✅ | ✅ | Not claimed |
| Generic Git | ✅ | ✅ | Git protocol/store validation |

The framework supports GitLab and Gitee through the provider-neutral adapter contract, but public documentation does not claim live-provider validation until a real provider pilot executes.

## Security invariants

- descriptor != authorization
- provider capability != permission
- remote attach != approval
- secrets never enter GovernanceStore
- provider credentials are external to governance state
- Decision / Waitpoint cannot be bypassed by provider discovery
- repository conflict fails closed
- migration retains a recovery path
- MCP / Dashboard remain consumers, not alternate state owners

## Validation evidence

Delivered acceptance includes:

- stable ProjectIdentity across rebind roundtrip;
- embedded → detached migration;
- Git-backed governance seed and revision history;
- stale writer CAS conflict;
- session restart against persistent Git governance;
- remote Queue / logical Lock conflict handling;
- Decision / Waitpoint remote gate preservation;
- reconciliation drift and controlled resume;
- GitHub product + GitHub governance live topology;
- provider capability conformance for GitHub / GitLab / Gitee / Generic Git.

See [RDG MS-012 Acceptance Evidence](../validation/rdg-ms012-acceptance.md).
