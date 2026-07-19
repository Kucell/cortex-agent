# Runtime State Integration Invariant

## Classification

A feature is `stateful` when it has lifecycle transitions, persists across commands/processes/sessions, performs side effects, can fail or recover, is queried by coordination surfaces, or supplies delivery-gate evidence.

A feature may be `exempt` only when it is synchronous, side-effect-free, non-persistent, and creates no durable identity, owner, event, or evidence. Record the exemption reason in architecture and validation artifacts. Reclassify it as soon as it persists state or causes a side effect.

## Required contract

Every stateful feature must provide:

1. Resource: stable ID, schema, owner, and Task/Run/Session relations.
2. State machine: initial, legal transition, terminal, failure, timeout, stale, cancellation, and recovery semantics as applicable.
3. Event journal: append-only transition/activity events with actor and evidence relations.
4. Evidence: command, validation, artifact, and redacted log-cursor references. Worker prose is not evidence.
5. Write gate: owning workflow, owner checks, and Decision/Waitpoint gates for risky actions.
6. Query projection: focused and aggregate Management API read models that tolerate missing legacy state and never mutate.
7. Consumer surface: applicable CLI, optional MCP, Dashboard, Briefing, Review, Handoff, or audit views consuming the same projection.

## Source and direction

- `.agent/` resource state, events, and evidence refs are authoritative.
- Management API is the unified read projection, not a second source of truth.
- CLI, MCP, and Dashboard must not reimplement state transitions or parse separate private state models.
- Dashboard and MCP are read-only by default. Any future write tool must call the existing owning workflow and cannot bypass owner, Decision, or Waitpoint gates.
- Queries must not sweep, release, retry, resolve, merge, repair, or otherwise mutate state.

## Event and log integrity

- Store summaries and references instead of bulky stdout/stderr.
- Redact credentials, tokens, cookies, `.env` content, and sensitive command output before persistence.
- Cross-process or cross-machine time-filtered logs require a target-side timestamp and one cursor per producing target.
- Preserve failed, blocked, stale, timeout, canceled, retry, and compensation events; never overwrite them with a later success event.
- Log rotation may remove raw bytes only when the event retains a stable reference and reports evidence availability accurately.

## Delivery gates

- `/arch-design`: declare `stateful` or `exempt` and cover all seven contract parts when stateful.
- `/plan` and `/mission`: create explicit work for state, events, evidence, projection, consumers, recovery, compatibility, and tests.
- `/ship`: block completion when a required contract part, illegal-transition test, read-only query test, consumer, recovery evidence, or en/zh template mirror is missing.
- Shared schemas and Management API writers remain serial. Worktrees do not make concurrent shared-contract edits safe.
