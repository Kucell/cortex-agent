# Remote Peer Primitives (M-053 / MS-008 P-009, batch C1)

> Status: implementation in an independent worktree, not committed, not merged.
> This document freezes the semantics of the C1 primitives. It does not
> authorize a signing entry point, a bridge production wiring, a Windows
> action, or a service deployment.

## 1. Why these primitives exist

The cross-machine permit chain needs a peer identity that is *not* the local
managed caller identity. `lib/governed/managed-caller-session.js` proves
identity with an OS process handle, an inherited anonymous IPC channel and a
secret that never leaves a second pipe. None of that crosses a machine
boundary, and a local fork session must never be reused to impersonate a
remote peer.

So the remote path gets its own type. `lib/governed/remote-peer-trust.js`
turns a signed fact set into an opaque `VerifiedRemotePeer`, and
`lib/governed/remote-peer-session.js` owns the life of one proven connection
and the per-call authority gate.

## 2. Write set

| File | Responsibility |
| --- | --- |
| `lib/governed/remote-peer-trust.js` | Trust configuration validation, signed fact schema, field-by-field verification, remote peer construction |
| `lib/governed/remote-peer-session.js` | Connection binding, challenge handshake, request and ticket binding, replay rules, lifecycle, per-call authority gate |
| `tests/governed/remote-peer-primitives.test.js` | Positive, negative and lifecycle coverage for both modules |
| `docs/architecture/remote-peer-primitives.md` | This contract |

Both modules are pure logic. They create no key, open no socket and read no
machine state, so the whole rejection matrix is testable on one host.

## 3. Field-by-field verification matrix

Every refusal is a `RemotePeerRejectedError` with a stable `code` and the
offending `field`. There is no partial acceptance path.

### 3.1 Trust configuration

| Field | Requirement | Rejection code |
| --- | --- | --- |
| `instanceId` | non-empty string | `TRUST_FIELD_MISSING` |
| `audience` | non-empty string | `TRUST_FIELD_MISSING` |
| `peerScope` | non-empty list of action names | `TRUST_SCOPE_EMPTY` |
| `pinnedKey.keyId` | non-empty string | `TRUST_KEY_NOT_PINNED` |
| `pinnedKey.keyDigest` | non-empty string | `TRUST_KEY_NOT_PINNED` |
| `epoch` | integer, not negative | `TRUST_EPOCH_INVALID` |
| `notBeforeMs` / `expiresAtMs` | integers, expiry after the start | `TRUST_CONFIG_INVALID` |
| validity window | `notBeforeMs <= now < expiresAtMs` | `TRUST_NOT_YET_VALID`, `TRUST_EXPIRED` |
| `limits.*` | positive integer | `TRUST_LIMIT_INVALID` |
| `limits.*` | not looser than the frozen ceiling | `TRUST_LIMIT_EXCEEDED` |

Frozen ceilings (`REMOTE_PEER_LIMIT`): handshake 5000 ms, fact age 1000 ms,
ticket TTL 2000 ms, request 5000 ms, revocation staleness 15000 ms, clock skew
2000 ms. A configuration may tighten a bound, never widen it. Widening is
refused rather than clamped, so a misconfigured peer cannot silently widen
the window.

### 3.2 Signed facts

| Field | Requirement | Rejection code |
| --- | --- | --- |
| `factVersion` | equals 1 | `REMOTE_FACT_VERSION_UNSUPPORTED` |
| `signature` | verifies under the pinned key | `REMOTE_FACT_SIGNATURE_INVALID` |
| `signerKeyId` | equals `pinnedKey.keyId` | `REMOTE_FACT_KEY_NOT_PINNED` |
| `instanceId` | equals the pinned instance | `REMOTE_FACT_INSTANCE_MISMATCH` |
| `epoch` | equals the pinned epoch | `REMOTE_FACT_EPOCH_MISMATCH` |
| `runId`, `generationText` | non-empty | `REMOTE_FACT_FIELD_MISSING` |
| `host.pid`, `host.startToken`, `host.commandDigest` | present and well formed | `REMOTE_FACT_HOST_UNBOUND` |
| `connection.connectionId` | equals the live connection | `REMOTE_FACT_CONNECTION_MISMATCH` |
| `connection.tlsPublicKeyDigest` | equals the live connection key | `REMOTE_FACT_CONNECTION_KEY_MISMATCH` |
| `challenge` | equals the outstanding challenge | `REMOTE_FACT_CHALLENGE_MISMATCH` |
| `issuedAtMs` | not more than the skew in the future | `REMOTE_FACT_CLOCK_SKEW` |
| `issuedAtMs` | not older than the fact age | `REMOTE_FACT_STALE` |
| `expiresAtMs` | in the future | `REMOTE_FACT_EXPIRED` |
| `expiresAtMs - issuedAtMs` | not wider than the fact age | `REMOTE_FACT_WINDOW_EXCEEDED` |
| `scope` | contained in the pinned scope | `REMOTE_FACT_SCOPE_ESCALATION` |

The verified peer is tagged `kind: "remote-peer"` and carries the host
binding inside `host`. It has no top-level `pid` or `startToken`, so it
cannot be confused with the local managed caller identity.

### 3.3 Session, requests and tickets

| Situation | Rejection code |
| --- | --- |
| Session started twice | `REMOTE_SESSION_ALREADY_STARTED` |
| Facts outside the handshake bound | `REMOTE_HANDSHAKE_TIMEOUT` |
| Facts presented twice, or after a failed verification | `REMOTE_HANDSHAKE_CONSUMED` |
| Request identifier reused | `REMOTE_REQUEST_REPLAY` |
| Sequence number not advancing | `REMOTE_REQUEST_SEQUENCE` |
| Replay registry at its hard bound | `REMOTE_REPLAY_REGISTRY_FULL` |
| Action outside the peer scope | `REMOTE_ACTION_OUT_OF_SCOPE` |
| Response bound to another request or payload | `REMOTE_REQUEST_UNKNOWN`, `REMOTE_REQUEST_PAYLOAD_MISMATCH` |
| Ticket not registered, already consumed, expired, over the TTL, or bound to another peer or connection | `REMOTE_TICKET_UNKNOWN`, `REMOTE_TICKET_REPLAY`, `REMOTE_TICKET_EXPIRED`, `REMOTE_TICKET_TTL_EXCEEDED`, `REMOTE_TICKET_PEER_MISMATCH`, `REMOTE_TICKET_CONNECTION_MISMATCH` |

The replay registry never evicts. When it reaches its bound the session fails
closed instead of forgetting an old request and accepting it again.

### 3.4 Per-call authority gate

`assertPerCallAuthority()` runs for every call that may reach a signing path.

| Check | Rejection code |
| --- | --- |
| Session established and peer present | `REMOTE_SESSION_INVALID_STATE` |
| `authorityHeld` is true | `REMOTE_AUTHORITY_NOT_HELD` |
| Authority epoch equals the peer epoch | `REMOTE_AUTHORITY_EPOCH_MISMATCH` |
| Lease fencing equals the expected fencing | `REMOTE_AUTHORITY_FENCING_MISMATCH` |
| Authority lease not expired | `REMOTE_AUTHORITY_LEASE_EXPIRED` |
| Action allowed by the authority and by the peer scope | `REMOTE_AUTHORITY_ACTION_NOT_ALLOWED`, `REMOTE_ACTION_OUT_OF_SCOPE` |
| Revocation list applied within the staleness bound | `REMOTE_REVOCATION_STALE` |
| Request bound on this session, same action and payload | `REMOTE_REQUEST_UNKNOWN`, `REMOTE_REQUEST_PAYLOAD_MISMATCH` |
| Deadline in the future and inside the request bound | `REMOTE_REQUEST_DEADLINE_PASSED`, `REMOTE_REQUEST_DEADLINE_EXCEEDED` |
| Deadline clipped to the remaining authority lifetime | `REMOTE_AUTHORITY_LIFETIME_TOO_SHORT` |
| Ticket registered, unused, same action, same peer, same connection | `REMOTE_TICKET_*` |

## 4. Test entry

```bash
node --test tests/governed/remote-peer-primitives.test.js
node scripts/test-runner.cjs --scope governed
node scripts/test-runner.cjs --scope coordination
```

## 5. Boundaries

- No signing, no permit issuance, no socket, no key material, no Windows
  action, no service and no ACL change.
- Not wired into `permit-bridge-*` yet. The assembly layer that connects these
  primitives to the bridge is a separate slice with its own owned files.
- The remote peer and the local managed caller identity are different types
  and must never be substituted for one another.
- Approved decisions this implements: `D-M053-MS008-P009-R1-TRUSTED-W-OPEN`,
  `D-M053-MS008-P009-R2R3-CONNECTION-TOPOLOGY-OPEN`,
  `D-M053-MS008-P009-R4-TRUSTED-CONTEXT-OPEN`,
  `D-M053-MS008-P009-R5-TIMING-REVOCATION-OPEN`,
  `D-M053-MS008-G0-CONNECTION-BINDING-BASIS-OPEN`,
  `D-M053-MS008-G0-A-SCOPE-NARROW-OPEN`.
