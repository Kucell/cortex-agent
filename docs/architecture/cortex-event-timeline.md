# CortexEvent v1 and Timeline Contract

> **Status**: M-040 MS-007 baseline  
> **Validated**: 2026-09-29  
> **Focused CI**: 78/78 PASS

## 1. Position

CortexEvent is a canonical **observation envelope** across Cortex domains.

It does not replace the authoritative journals or state stores that produced the event.

```text
Coordination journal ─┐
Framework Event Bus ──┼─> source bridge -> CortexEvent v1 -> consumers
Runtime Boundary ─────┘
```

## 2. Envelope

CortexEvent v1 contains:

- stable canonical event_id;
- dotted event type;
- occurred_at;
- source identity;
- correlation identity;
- optional source-local sequence;
- optional causation id;
- bounded/projected payload;
- evidence refs;
- explicit redaction flag.

The contract lives in `@cortex-agent/protocol`.

## 3. Source identity

Source kinds include:

- framework
- coordination
- runtime
- project
- extension
- control

Source identity may carry canonical ProjectRef, HostRef and RuntimeRef.

A coding-agent adapter id is not automatically a physical HostRef.

## 4. Correlation

Canonical correlation supports:

- mission_id
- milestone_id
- task_id
- decision_id
- waitpoint_id
- operation_id
- trace_id
- correlation_id
- RunRef
- SessionRef
- WorkspaceRef

Correlation does not become state ownership.

## 5. Sequence and ordering

There is no fake global sequence.

```text
Coordination journal
  -> strict producer/task sequence
  -> preserved in CortexEvent

Framework Event Bus
  -> no intrinsic event sequence
  -> no CortexEvent sequence invented
  -> replay cursor remains separate
```

If a source supplies an explicit local ordinal, it may be represented as:

```json
{
  "stream_id": "coordination:T-1:agent-1",
  "value": 42
}
```

## 6. Cursor

Timeline cursor position is opaque.

Examples:

```text
byte:4096
event:123
page:abc
```

A cursor is not treated as an event sequence.

This allows existing Event Bus byte offsets and future remote cursors to coexist without inventing common ordering semantics.

## 7. Replay, dedupe and gaps

Timeline analysis:

1. normalizes events;
2. deduplicates by canonical event_id;
3. tracks each source-local stream independently;
4. detects gaps and regressions;
5. marks reconciliation as required when continuity breaks.

A partial timeline does not assume its first observed sequence must be 1. A caller may provide the previous known sequence when continuing from a cursor.

## 8. Reconciliation

When a gap/regression is found:

```text
reconciliation.required = true
reason = sequence_gap_or_regression
```

Consumers must query authoritative state/snapshot owners instead of guessing missing state from the event stream.

## 9. Source bridges

### Framework Event Bus

Maps existing bus event IDs/types/correlation into CortexEvent.

Framework payloads are not assumed redacted unless the caller explicitly knows they are.

No sequence is invented from byte offsets.

### Coordination

The existing Coordination contract validates the source event first.

Strict per-task/producer sequence is preserved.

The CortexEvent projection deliberately omits free-form message content and keeps state/evidence relations.

### Runtime Boundary

The existing Runtime Boundary validator runs first, including taint/secret checks.

The projection is therefore marked redacted-safe.

RuntimeRef may be derived from the native adapter or explicitly supplied by a higher runtime layer such as Paseo.

Physical HostRef is attached only when explicitly known.

## 10. Authority

```text
CortexEvent != command
CortexEvent != authorization
CortexEvent != source-of-truth state
```

Event consumers that want to mutate governed state must call an explicit governed command/owner API.

## 11. Validation

Focused tests cover:

- closed event envelope;
- canonical ref validation;
- dedupe;
- gap/regression detection;
- partial-stream baseline;
- opaque cursor semantics;
- Framework Event Bus projection;
- Coordination strict sequence projection;
- Runtime Boundary projection and redaction;
- physical HostRef not inferred from adapter identity.

Result:

```text
78 tests
78 pass
0 fail
```
