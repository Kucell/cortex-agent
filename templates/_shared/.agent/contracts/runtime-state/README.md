# Runtime State Contracts

> **Status**: `frozen` (M-026 MS-001, P-001 runtime-state-layout revision `c8e0f0226cac`)
> **Owner**: `architecture-coordinator` (root validator gates follow-up milestones)

The `.agent/contracts/runtime-state/` directory is the **only** writable
contract surface for the runtime state layout. Writers (`update`, consumer
registries, journal segments, evidence archives) MUST reference the
schemas below; readers (CLI, MCP, Dashboard, Briefing, Review, audit) MUST
NOT mutate records, only read them through the runtime layout resolver
(`lib/runtime-layout/index.js`).

## Layout summary (P-001 §2)

```text
.agent/
├── contracts/
│   └── runtime-state/         # frozen schemas + writer contracts (this dir)
├── runtime/
│   ├── coordination/          # portable: tasks, leases, snapshots
│   ├── dispatch/              # portable: dispatch plans, journals
│   ├── cross-project/         # portable: inbox/outbox/subscriptions
│   ├── continuity/            # portable: continuity state
│   ├── evidence/              # portable: evidence archives
│   ├── hosts/<machine-id>/    # machine-local: bindings, PID, locks
│   └── worktrees/<instance>/  # per-instance: cursor, lease state
└── handoffs/                  # portable: handoff records
```

## Schemas in this directory

| Schema | Purpose |
| :--- | :--- |
| `identity-record.schema.json` | Frozen identity envelope (`project_id` / `repository_id` / `workspace_id` / `machine_id` / `workspace_instance_id`). |
| `logical-uri.schema.json` | Frozen logical URI envelope for the six P-001 schemes. |
| `local-binding.schema.json` | Per-host binding envelope (the only place absolute paths may live). |
| `runtime-layout.schema.json` | Frozen layout descriptor — what the resolver must produce for each logical identity. |

## Identity contract

Identities are **strings**, never derived from `root`, `worktree_path`,
`resolved_path`, or any absolute path on the local filesystem. Two
workspaces compare equal when and only when their identity strings are
identical. Identities used for equality, dedupe, lease-scope or fencing
must not be derived from the resolver's `paths.*` output.

## Logical URI contract

```text
project://<project-id>/<relative>
repo://<repository-id>/<relative>
workspace://<workspace-id>/<relative>
agent://<relative>
runtime://<relative>
artifact://<task-id>/<artifact-id>
```

Segments use NFC normalisation, percent-encoding for reserved characters,
and refuse `.` / `..` / absolute-path-looking inputs. Identities used for
equality, dedupe, lease-scope or fencing must remain on the logical URI
side; absolute paths only appear inside `local-binding.schema.json`.

## Local binding contract

Local bindings live at `.agent/runtime/hosts/<machine-id>/bindings.local.json`,
default-ignored by Git, written atomically (`O_EXCL` + 0o600), and refused
when any ancestor directory is a symlink. They are the only place where
absolute paths may persist. Two workspaces whose identity strings are equal
must produce the same logical operations even if their bindings diverge.

## Compatibility window

During the compatibility window the legacy `.agent-runtime/` directory is
read-only. Writers target `.agent/runtime/`; readers fall back to
`.agent-runtime/` when the new layout is not yet activated. The resolver
exposes `detectLegacyRuntime(root)` for this check.