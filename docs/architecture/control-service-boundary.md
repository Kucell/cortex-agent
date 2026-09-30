# Control Service and Daemon Boundary

> **Status**: M-040 MS-006 baseline  
> **Validated**: 2026-09-29  
> **Focused CI**: 68/68 PASS

## 1. Position

The Cortex Control Service is an optional coordination layer.

It is not:

- a source of Mission truth;
- a new Coordination state machine;
- an Agent Runtime;
- an authorization engine;
- a persistence owner.

Its job is to compose existing owners in the correct order.

## 2. Control flow

```text
ControlService.inspect()
  -> existing DispatchPlan resolver
  -> RuntimeEndpoint routing
  -> ready | blocked

ControlService.execute()
  -> inspect()
  -> explicit authorize() owner
  -> require authorization_ref
  -> explicit dispatch() owner
  -> dispatched
```

The Control Service itself does not read or write `.agent` directly.

## 3. Owner injection

The core requires four explicit dependencies:

- resolvePlan
- route
- authorize
- dispatch

This prevents the coordinator from becoming an implicit owner of any of those concerns.

The local composition binds only:

- existing `lib/dispatch/plan.js`;
- existing RuntimeEndpoint/host routing.

Authorization and dispatch owners must still be supplied explicitly.

## 4. Fail-closed ordering

Execution is short-circuited in this order:

```text
dispatch plan blocked
  -> stop

no runtime selection
  -> stop

authorization denied/missing
  -> stop

authorization has no evidence ref
  -> fail closed

only then
  -> dispatcher
```

An authorized result must include an `authorization_ref` such as a Decision evidence reference.

## 5. No second state store

`lib/control-service/service.js` contains no filesystem, process, network or `.agent` persistence code.

All mutation remains with existing owners.

The local integration test confirms the existing dispatch plan reports zero mutations before authorization.

## 6. Daemon boundary

A daemon is a hosting mode for repeated Control Service iterations, not a new architecture layer.

The existing daemon/trigger schemas remain useful contracts, but the public CLI remains fail-closed:

```text
cortex-agent daemon ...
cortex-agent trigger ...
=> Phase 0 stub / disabled
```

This is intentional for M-040 MS-006.

The Control Service core must stabilize before Cortex enables a persistent polling process. Enabling a daemon later requires an explicit opt-in lifecycle and must preserve:

- workflow/Decision/Waitpoint gates;
- existing queue/session/run owners;
- idempotency;
- recoverable daemon state;
- default-disabled behavior;
- stop controls.

## 7. Trigger semantics

A Trigger remains a request to evaluate work, never execution authority.

```text
Trigger
  -> Control Service evaluation
  -> DispatchPlan
  -> Runtime routing
  -> Authorization
  -> Dispatcher
```

No Trigger type can bypass the authorization stage.

## 8. Direct mode remains valid

Cortex continues to support direct governed execution without a daemon.

```text
workflow / CLI
  -> governed dispatch / Control Service call
  -> RuntimePort
```

A future daemon merely repeats the same governed iteration.

## 9. Validation

Focused tests verify:

- blocked plan never reaches routing/authorization/dispatch;
- missing runtime selection never reaches authorization/dispatch;
- authorization denial never reaches dispatcher;
- successful authorization requires an evidence reference;
- dispatcher receives the selected RuntimeEndpoint and authorization ref;
- inspect is coordination-only;
- local composition reuses existing read-only plan/routing owners;
- Control Service core contains no persistence/process/network ownership;
- daemon and trigger public CLI remain default-disabled stubs.

Result:

```text
68 tests
68 pass
0 fail
```
