# Control Service Daemon v1

> **Status**: M-041 MS-005 baseline  
> **Default**: disabled / opt-in  
> **Runtime state**: `.agent-runtime/control-service/`

## 1. Position

The daemon is a user-space host for repeated Control Service iterations.

It is not a Mission store, Coordination state machine, Runtime provider, or authorization authority.

```text
Queue / dispatch-state owner
        +
explicit runtime request sidecar
        |
        v
Daemon request source
        |
        v
ControlService.execute()
        |
        +-> DispatchPlan owner
        +-> Runtime routing owner
        +-> approved Decision owner
        +-> existing executeDispatch owner
```

## 2. Public lifecycle

```text
cortex-agent daemon start
cortex-agent daemon status
cortex-agent daemon stop
```

The daemon never starts automatically.

`status` is read-only.

`start` and `stop` are idempotent.

## 3. Local runtime state

Process state is intentionally outside the independent development-governance repository:

```text
.agent-runtime/control-service/
  daemon-state.json
  daemon-owner.json
  idempotency.json
  requests/
```

The tracked `.agent/dispatch/daemon-state.schema.json` is only the contract schema.

PID, heartbeat and request-spool data are local runtime data and are not pushed as governance truth.

## 4. Ownership and stale recovery

Lifecycle mutation is protected by a local lifecycle lock.

The owner record carries:

- PID;
- random owner token;
- project root;
- start timestamp.

Before starting, Cortex checks whether the recorded owner process is actually alive and running the daemon host.

A stale owner is recovered explicitly before a new process is spawned.

Read-only status reports stale ownership without mutating the state.

## 5. Request model

Daemon v1 does not infer executable requests from a Queue item.

A request is eligible only when both are true:

1. the existing dispatch/queue projection still reports the task as queued;
2. a local runtime request sidecar exists with `opt_in=true` and complete Control Service routing inputs.

This preserves:

```text
queued != authorized
trigger != authorized
request sidecar != authorized
```

The Control Service revalidates authorization before dispatch.

The existing `executeDispatch` owner revalidates approval, ownership lease and idempotency again.

## 6. Request spool

Sidecars are stored under:

```text
.agent-runtime/control-service/requests/
```

They contain execution intent such as:

- task id;
- idempotency key;
- workflow gate;
- RuntimeRequirement;
- RuntimeEndpoints;
- HostRequirement;
- endpoint/profile bindings.

They do not contain arbitrary shell commands.

A sidecar is an execution request, not a governance source of truth.

## 7. Durable idempotency

Successful dispatch keys are written to a bounded local ledger:

```text
.agent-runtime/control-service/idempotency.json
```

Only a `dispatched` Control Service result is remembered permanently.

`blocked` or `awaiting_authorization` remains retryable so later governance changes can be re-evaluated.

## 8. Polling and concurrency

The daemon engine has a bounded concurrency limit.

Requests are processed in bounded batches and every request goes through `ControlService.execute()`.

The current default concurrency is 1.

No worker bypasses the Control Service.

## 9. PlatformHealth

Daemon v1 contributes a `daemon` component to PlatformHealth.

Examples:

- daemon intentionally stopped/default-disabled -> healthy;
- starting/stopping -> degraded;
- running with configured request source -> healthy;
- stale enabled owner/PID -> unhealthy;
- daemon state available but executable request source absent -> degraded.

Health remains observation only.

## 10. Trigger status

The public `trigger` CLI remains Phase 0 / fail-closed in MS-005.

Daemon v1 has a governed runtime request-source API, but M-041 does not silently turn legacy trigger declarations into executable work.

A future trigger productization must materialize a valid runtime request through an explicit owner boundary and still pass Control Service authorization.

## 11. Direct mode

Daemon use is optional.

Existing direct/manual/native flows continue to work when the daemon is absent.

## 12. Shutdown

SIGINT and SIGTERM move daemon state through stopping -> stopped.

The process clears its owner record only when it still owns that record.

This avoids one process clearing another process's ownership during restart races.

## 13. Security invariants

- no daemon auto-start;
- no provider PTY implementation;
- no direct Mission/Coordination writes from the daemon host;
- no task execution from queue state alone;
- no approval inferred from runtime request data;
- no persistent successful replay after process restart;
- no PID/heartbeat state stored in the independent governance repository.
