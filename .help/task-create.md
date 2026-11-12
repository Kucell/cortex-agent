# cortex-agent task create

Create a coordination task through the Coordination Application Service.

## Field-based interface (preferred)

    cortex-agent task create --project <path> --task <id> \
      --actor <coordinator-id> --session <session-id> \
      --project-id <project-id> --correlation-id <correlation-id> \
      [--repository-id <repository-id>] [--message <text>] \
      [--notification-policy <policy>] [--auth-context-json <json>] [--json]

`--task`, `--actor`, `--session`, `--project-id` and `--correlation-id` are
required. `--project` defaults to the current directory. The writer supplies
the `task.created` envelope and a coordinator producer; this declaration does
not grant static Registry capabilities or a file Lease.

`--auth-context-json`, when supplied, contains `actorId`, `kind`, `sessionId`
and optional `workflowGate`. The producer must match that context. Task,
actor, session and project IDs are existing identities, not interchangeable.

## Legacy event-envelope compatibility path

    cortex-agent task create --project <path> --event-json <complete-event-json> \
      [--auth-context-json <json>] [--json]

`--event-json` remains the legacy path and takes precedence over the field
builder. It requires a complete valid coordination event, including
`schemaVersion`, `eventId`, `projectId`, `taskId`, `correlationId`, `producer`,
`targets`, `eventType`, `previousState`, `currentState`, `timestamp`,
`repository` and `notification`; use the shipped coordination event schema.
`eventType` must be `task.created`, `previousState` must be null, and
`currentState` must be `CREATED`. A partial event is not a valid example.

## Ownership and state boundaries

The field-based `create/assign/accept` builders do not bind `fileOwnership`.
A raw envelope may carry it, but must satisfy the application service's
actor, transition, lease and fencing rules. There is no arbitrary set_state.

`task rebind-ownership` refreshes existing ownership over the same scope and
owner using a newer continuation Lease. It is not first registration, initial
file ownership assignment, a scope expansion, or a way to change the owner.
Never infer permission from an empty ownership list or from command success.

Task events and leases resolve to the same runtime namespace during the
legacy-layout compatibility window. Static `agent register/enable/disable`
does not create Task, Session or Lease state; acquire and validate these
separately before source writes or Runtime activation.

## Example

    cortex-agent task create --project . --task T-EXAMPLE \
      --actor coordinator-id --session existing-session-id \
      --project-id example --correlation-id CORR-EXAMPLE --json
