# Protocol Versioning and Capability Negotiation

> **Status**: M-040 MS-003 baseline  
> **Date**: 2026-09-29

## 1. Protocol families

Cortex separates protocol families by integration boundary:

```text
cortex             general SDK / management capabilities
cortex-runtime     RuntimePort integration
cortex-project     external Project Integration
cortex-extension   extension/plugin integration
```

Each family currently starts at `1.0`.

## 2. Version model

Protocol versions use:

```text
major.minor
```

Rules:

- same major may negotiate;
- negotiated version is the lower common minor;
- minor evolution must be additive;
- major mismatch fails closed;
- no implicit downgrade across majors;
- timestamps or implementation versions do not affect protocol compatibility.

Example:

```text
local  1.3
remote 1.1
=> negotiated 1.1

local  1.3
remote 2.0
=> fail: ERR_PROTOCOL_MAJOR_MISMATCH
```

## 3. Capability descriptor

Canonical descriptor shape:

```json
{
  "schema_version": "1",
  "protocol": "cortex-runtime",
  "protocol_version": "1.0",
  "implementation": "paseo",
  "implementation_version": "0.x",
  "capabilities": [
    "runtime.run.create",
    "runtime.run.cancel",
    "runtime.timeline.read"
  ],
  "deprecated_capabilities": []
}
```

The descriptor is intentionally small and stable.

Unknown descriptor fields fail closed so one major version cannot silently reinterpret a different contract.

## 4. Capability identifiers

Canonical capability IDs are namespaced strings.

Examples:

```text
management.query
tasks.read
runs.read
runtime.run.create
runtime.timeline.read
project.validation.run
extension.event.consume
```

Current namespaces:

- management
- tasks
- runs
- decisions
- waitpoints
- coordination
- topology
- runtime
- project
- extension

The existing Host Capability Descriptor under `lib/runtime-adapters/capability-contract.js` remains separate for now. Host observability names such as `tool.before.block` are not forced into the new generic namespace until the later Host/Runtime topology milestone defines the bridge.

## 5. Negotiation

Negotiation computes:

```text
protocol compatibility
+
capability intersection
+
required-capability validation
+
deprecation metadata
```

Example:

```text
local:
  runs.read
  tasks.read

remote:
  runs.read
  decisions.read

common:
  runs.read
```

If the caller requires `tasks.read`, negotiation fails.

A routing or score result must never manufacture a missing capability.

## 6. Required vs optional capabilities

Required capabilities are hard filters.

Optional capabilities may be absent without failing negotiation.

This rule is important for graceful degradation:

```text
required capability missing
=> fail closed

optional capability missing
=> feature unavailable, continue
```

## 7. Deprecation

A descriptor may mark one of its provided capabilities as deprecated.

Metadata may include:

- replacement capability;
- removal protocol version;
- reason.

Deprecation is advisory compatibility metadata. It does not automatically enable the replacement capability.

Example:

```json
{
  "id": "runtime.run.cancel",
  "replacement": "runtime.run.stop",
  "remove_in": "2.0",
  "reason": "unify stop semantics"
}
```

## 8. SDK integration

The SDK validates capability discovery responses through the protocol package.

```text
transport.discoverCapabilities()
          |
          v
createCapabilityDescriptor()
          |
          v
client.capabilities.discover()
          |
          +--> client.capabilities.negotiate(remote, requirements)
```

Both synchronous local transports and asynchronous future remote transports are supported.

## 9. Security and governance

Capability negotiation answers only:

> Can these two endpoints speak a compatible protocol and which capabilities do both claim?

It does **not** answer:

> Is this operation authorized?

Authorization remains owned by Decisions, Waitpoints, workflow gates, leases, policy and operation lifecycle.

```text
capability match != authorization
```

## 10. Compatibility with existing Host Capability Descriptor

The existing host descriptor already models:

- host identity;
- observability level;
- capability evidence source;
- friction observability;
- redaction posture.

M-040 preserves it as an authoritative host-observability contract.

Later milestones may adapt it to the generic protocol through an explicit bridge, but no direct replacement is required in MS-003.
