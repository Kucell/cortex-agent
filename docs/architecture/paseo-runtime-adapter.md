# Paseo Runtime Adapter

> **Status**: M-040 MS-010 baseline  
> **Validated**: 2026-09-29  
> **Reference SDK**: `@getpaseo/client@0.10.0` public API  
> **Focused CI**: 105/105 PASS

## 1. Position

Paseo is one optional RuntimePort backend.

Cortex does not fork Paseo, vendor its daemon, or depend on Paseo for native execution.

```text
Cortex Governance / Control
          |
      RuntimePort
       /     \
  Native     Paseo Adapter
              |
        public Paseo SDK
              |
          Paseo daemon
```

## 2. Package boundary

The adapter lives in:

```text
@cortex-agent/runtime-paseo
```

It depends on Cortex Protocol + RuntimePort.

`@getpaseo/client` is an optional peer dependency. The root `cortex-agent` package does not declare Paseo as a dependency.

The workspace sets `autoInstallPeers: false`, so optional runtime/provider SDKs are installed intentionally rather than pulled into every Cortex development/install path.

## 3. Public SDK only

MS-010 targets Paseo's public client facade:

- `createPaseoClient()`
- `PaseoClient.agents`
- `PaseoAgentHandle`
- public timeline handle

The adapter does not import `@getpaseo/client/internal/daemon-client`.

Paseo currently exposes low-level cancellation in its daemon protocol, but the public `PaseoAgentHandle` does not expose cancel/interrupt in 0.10.0.

Therefore Cortex does not advertise `runtime.run.cancel` for Paseo.

## 4. RuntimePort capability mapping

Advertised:

```text
runtime.discover
runtime.health
runtime.run.create
runtime.run.send
runtime.run.status
runtime.run.wait
runtime.timeline.read
runtime.run.archive
```

Not advertised:

```text
runtime.run.cancel
```

When Paseo exposes a stable public cancel API, this capability can be added additively.

## 5. Run identity

Paseo agent identity remains behind a Cortex RunRef:

```text
Paseo agent id: agent-123
Cortex RunRef:  run:paseo:agent-123
```

No Paseo-specific field is added to Mission or other core governance entities.

## 6. Lifecycle mapping

Paseo agent sessions are reusable multi-turn sessions.

Mapping:

| Paseo | Cortex Runtime |
| :--- | :--- |
| initializing | created |
| running | running |
| idle | waiting |
| error | failed |
| closed | stopped |
| archivedAt present | archived |

Critically, Paseo `idle` is not `completed`.

A turn finishing only means the reusable runtime is waiting for more work.

## 7. Creation and send

`createRun()` delegates to `client.agents.create()`.

Required inputs include:

- working directory;
- explicit Paseo provider/model id.

Optional inputs include prompt, idempotency key, title and labels.

Prompts must be strings; the adapter does not serialize arbitrary payload objects into prompts.

`send()` delegates to the public Agent Handle.

## 8. Wait

`wait()` uses public `waitForFinish()`.

Paseo wait outcomes are projected as execution evidence:

- idle -> waiting
- error -> failed
- permission -> waiting + requires_attention
- timeout -> waiting + timed_out

These results do not complete a Cortex Mission.

## 9. Timeline normalization

Paseo's timeline uses an epoch + source-local sequence cursor.

Cortex maps:

```text
Paseo { epoch, seq }
  -> Cortex source-local event sequence
  -> opaque Cortex timeline cursor
```

Paseo raw timeline items are not exposed to Cortex consumers.

The adapter emits bounded CortexEvent payloads such as:

- provider
- item type
- turn id
- bounded status

Prompt/message text, tool input and other raw content are deliberately omitted.

Timeline events are marked redacted.

## 10. Epoch/reset reconciliation

Paseo timeline replacement may create a new epoch.

When `reset=true`, the adapter sets:

```text
reconciliation.required = true
reason = paseo_timeline_reset_or_epoch_replacement
```

Cortex never concatenates incompatible epochs and pretends global continuity.

## 11. Health and lifecycle ownership

The adapter connects lazily.

`health()` returns structured down/ready state rather than throwing on daemon connection failure.

The adapter companion exposes `close()` for client cleanup; close is intentionally not added to RuntimePort v1 just for Paseo.

## 12. Validation strategy

MS-010 tests use an injected fake implementation of the **public Paseo client contract** so Cortex core validation does not require a running daemon or mandatory Paseo install.

The API mapping was checked against Paseo 0.10.0 source.

A live-daemon deployment remains an integration/operator concern.

## 13. Validation

Focused validation covers:

- optional root dependency boundary;
- truthful capability descriptor;
- cancel remains unsupported;
- createRun -> RunRef;
- provider/cwd/prompt/idempotency mapping;
- send/status/wait;
- idle != completed;
- timeline redaction and epoch/seq mapping;
- reset -> reconciliation;
- archive;
- health failure behavior.

Result:

```text
105 tests
105 pass
0 fail
```
