# RuntimePort v1 and Native Adapter Compatibility

> **Status**: M-040 MS-004 baseline  
> **Validated**: 2026-09-29  
> **CI**: M-040 Architecture Validation — 43/43 PASS

## 1. Purpose

RuntimePort is the runtime-agnostic execution contract between Cortex governance/control logic and concrete execution backends.

It does not replace the existing native Adapter contract. Existing adapters are preserved through an explicit compatibility bridge.

## 2. RuntimePort surface

```text
discoverRuntime()
health()
createRun()
send()
cancel()
getStatus()
getTimeline()
wait()
archive()
```

Each operation maps to an explicit capability.

Unsupported operations are still present on the port but fail with:

```text
ERR_RUNTIME_CAPABILITY_UNSUPPORTED
```

This prevents callers from inferring support from method existence alone.

## 3. Runtime capabilities

Current v1 capability vocabulary:

```text
runtime.discover
runtime.health
runtime.run.create
runtime.run.cancel
runtime.run.status
runtime.run.wait
runtime.run.send
runtime.timeline.read
runtime.run.archive
```

A backend declares only capabilities it actually implements.

## 4. Existing native Adapter contract

The existing 5-method contract remains valid:

```text
discover()
health()
invoke()
cancel()
report()
```

It continues to own its existing dispatch journal/evidence behavior.

## 5. Compatibility bridge

`lib/runtime-port/legacy-adapter-bridge.js` adapts the legacy contract to RuntimePort.

Mapping:

| Legacy Adapter | RuntimePort |
| :--- | :--- |
| discover | discoverRuntime |
| health | health |
| invoke | createRun |
| cancel | cancel |
| report | getStatus |
| report polling | wait |
| — | send unsupported |
| — | getTimeline unsupported |
| — | archive unsupported |

The bridge does not claim unsupported capabilities.

## 6. Run identity

RuntimePort exposes a canonical opaque `RunRef`:

```text
run:R-...
```

The compatibility bridge does not expose a second public raw `run_id` field beside the canonical ref.

The raw backend run identifier remains an implementation detail encoded behind the opaque reference boundary.

## 7. Status normalization

The bridge normalizes legacy terminal results into runtime lifecycle status.

Examples:

```text
result present        -> completed
error present         -> failed
report not found      -> pending
cancel/cancelled      -> cancelled
```

This status is execution evidence only.

It does not directly complete a Cortex Mission or Coordination Task.

## 8. Wait semantics

Legacy adapters do not expose an independent run handle before `invoke()` returns, but the adapter journal can still be queried for an existing run.

The compatibility bridge implements `wait()` by bounded polling of `report()`.

Timeout fails explicitly with:

```text
ERR_RUNTIME_WAIT_TIMEOUT
```

Future runtime backends such as Paseo may implement native wait/stream semantics directly.

## 9. Evidence boundary

Legacy journal ownership remains unchanged under the adapter runtime dispatch directory.

RuntimePort status projection exposes only normalized result/error/evidence summary.

It does not make runtime-specific journal layout part of the portable RuntimePort package.

## 10. Package boundary

`@cortex-agent/runtime-port` depends only on `@cortex-agent/protocol`.

It does not depend on:

- filesystem;
- child_process;
- native adapters;
- Paseo;
- Management API;
- Coordination;
- UI.

Concrete implementations live outside the portable package.

## 11. Governance invariants

- RuntimePort does not own Mission truth.
- Runtime completion does not imply governance completion.
- Runtime capability availability does not imply authorization.
- Native Adapter compatibility remains available without Paseo.
- Provider-specific metadata stays below the RuntimePort boundary.
