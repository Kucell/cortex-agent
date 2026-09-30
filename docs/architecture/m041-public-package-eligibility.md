# M-041 Public Package Eligibility Matrix

> **Status**: MS-001 working baseline  
> **Date**: 2026-09-30

## Decision model

M-041 does not publish packages merely because they exist in `packages/*`.

A package is eligible for external/public release only when:

- its API surface is intentionally frozen;
- it has an explicit export map;
- dependency closure is appropriate for consumers;
- it does not expose private project-governance state;
- semver/deprecation policy is defined;
- external consumer smoke succeeds;
- package documentation is sufficient.

## Current package assessment

| Package | Current state | Candidate status | Rationale |
| :--- | :--- | :--- | :--- |
| `@cortex-agent/protocol` | private, 0.0.0 | **Public candidate — highest priority** | Portable contracts only; no filesystem/process/UI/provider dependency. PlatformHealth v1 now lives here. |
| `@cortex-agent/sdk` | private, 0.0.0 | **Public candidate** | Consumer-facing facade; must validate external transport/consumer use and document sync/async semantics. |
| `@cortex-agent/runtime-port` | private, 0.0.0 | **Public candidate** | Stable runtime integration contract; suitable for third-party runtime authors after export/docs freeze. |
| `@cortex-agent/project-sdk` | private, 0.0.0 | **Public candidate** | Required for connected-project tooling and external project adapters. |
| `@cortex-agent/extension-sdk` | private, 0.0.0 | **Public candidate** | Required for extension authors; permission/enforcement limitations must be documented. |
| `@cortex-agent/runtime-paseo` | private, 0.0.0, optional peer | **Deferred public candidate** | External runtime-specific package; publish only after live-daemon/operator contract is validated. |
| root `cortex-agent` | public CLI/framework | **Remain product/meta package** | Continues to ship CLI/templates and compatibility surface; must not absorb the independent development `.agent` repository. |

## Initial publication sequence

Recommended sequence:

1. protocol
2. runtime-port
3. project-sdk
4. extension-sdk
5. sdk
6. runtime-paseo only after MS-007 live integration

The final release may still use coordinated/lockstep versions.

## Version policy proposal

For MS-001 contract freeze:

- workspace packages remain `private:true` and `0.0.0`;
- no npm publication occurs yet;
- public-candidate APIs are treated as pre-1.0 contracts;
- incompatible changes before first public release require explicit changelog/migration notes;
- after publication, normal semver applies;
- protocol major changes require a documented negotiation/migration path.

## Export policy

Initial public packages should expose a deliberately small root export only.

Subpath exports are added only when they provide a stable conceptual boundary.

Do not expose:

- `lib/*` implementation internals;
- private Management persistence;
- project `.agent` content;
- raw provider/runtime SDK objects;
- test fixtures/internal helpers.

## PlatformHealth relation

PlatformHealth v1 is part of the portable protocol contract and therefore part of the protocol public-candidate API.

Health producer implementations are not automatically protocol exports. Subsystem producers remain implementation/adaptor code unless a stable producer-authoring interface is intentionally promoted.

## MS-002 consumer targets

External consumer validation should cover at least:

- pure CommonJS consumer using `@cortex-agent/protocol`;
- SDK client constructed with a custom transport;
- RuntimePort implementer package;
- connected-project descriptor/tooling consumer;
- extension manifest/permission consumer.

Tests must run outside the Cortex workspace dependency graph.
