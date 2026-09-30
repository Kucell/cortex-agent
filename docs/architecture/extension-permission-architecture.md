# Extension and Permission Architecture

> **Status**: M-040 MS-008 baseline  
> **Date**: 2026-09-29

## 1. Position

Cortex extensions share a common governance contract without forcing existing Skills, catalog plugins, Agent Adapters, Host Adapters, UI bridges, or project integrations into one universal runtime container.

The common contract covers:

- identity;
- extension type;
- Cortex compatibility range;
- capabilities provided/required;
- permissions requested;
- entry points;
- configuration schema;
- deterministic registration.

## 2. Extension types

```text
agent-adapter
host-adapter
runtime-adapter
knowledge-provider
policy-provider
workflow
skill
validator
event-consumer
ui-surface
project-adapter
project-provider
```

A catalog `plugin` is intentionally not an executable extension type by default. Content/catalog objects only gain executable authority through an explicit adapter/manifest.

## 3. Compatibility

Every executable extension declares compatibility with the `cortex-extension` protocol:

```yaml
cortex:
  protocol: cortex-extension
  min_version: "1.0"
  max_version_exclusive: "2.0"
```

Unknown fields and incompatible ranges fail closed.

## 4. Capabilities

Extensions may declare:

```yaml
capabilities:
  provided:
    - runtime.run.create
  required:
    - management.query
```

Capability declaration does not imply authorization.

## 5. Permissions

Permission families:

```text
filesystem.read
filesystem.write
git.read
git.commit
git.push
process.spawn
network.connect
secrets.read
```

Scoped permissions use explicit lists, for example:

```yaml
permissions:
  filesystem:
    read: ["src/**"]
    write: ["tests/**"]
  git:
    read: true
    commit: true
    push: false
  process:
    spawn: true
  network:
    allow: ["127.0.0.1"]
  secrets:
    read: []
```

## 6. Policy outcomes

The policy evaluator returns:

```text
allow
deny
approval_required
```

Default policy may be deny.

Aggregate behavior:

- any deny -> deny;
- otherwise any approval_required -> approval_required;
- otherwise allow.

## 7. Enforcement boundary

Permission evaluation is not a sandbox.

The SDK explicitly reports:

```text
enforcement.claimed = false
```

Actual enforcement must happen where Cortex controls the boundary, such as:

- extension activation;
- RuntimePort invocation;
- governed tool invocation;
- privileged Management mutation;
- filesystem/process/network wrappers controlled by Cortex.

If an external runtime can bypass Cortex, that limitation must remain visible.

## 8. Entry points

Supported manifest entry points:

- server
- client
- cli
- worker

Absolute paths and `..` traversal are rejected.

## 9. Registry

The in-memory reference registry is deterministic:

- same id + same version -> idempotent;
- same id + different version -> explicit conflict.

This is a contract/reference implementation, not a persistence owner.

## 10. Existing systems remain authoritative

M-040 does not replace:

- Agent Adapter registry;
- catalog registry;
- Skill discovery;
- Host Adapter extension UI;
- project topology.

Those systems may expose compatibility descriptors to the unified contract over time.

## 11. Security invariants

- no implicit execution from catalog content;
- no silent permission grants;
- unknown permission fields fail closed;
- capability != authorization;
- permission policy != sandbox;
- external enforcement gaps must be declared, not hidden.
