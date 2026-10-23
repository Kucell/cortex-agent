## Summary

Implements **M-044 / MS-002 — managed caller proof**: a dedicated, non-detached supervisor
process that holds the supervised child's OS process handle plus a filename-less inherited
bidirectional IPC channel, and derives the caller's identity from those two facts alone.

## Origin Story

The upstream M-053 / MS-008 R3 coordination contract lists "handle mis-inheritance and
explicit handle transfer" as mandatory negative cases (VC-044-005) but **does not give a
mechanism by which they are rejected**.

This implementation measured that gap on the target platform and found it real:

- Node's `fork` + `stdio: [..., 'ipc']` channel lives on **fd 3** in the child, and that fd
  **can be deliberately handed to a descendant** via `spawn(..., { stdio: [..., 3] })`.
- The descendant then **reads the coordinator's requests and writes forged responses** onto
  the parent's channel. Reproduced locally — the coordinator received a forged
  `result: { forged: true }` *before* the genuine answer.
- A **nonce handshake does not stop this.** The nonce travels on the very channel that is
  transferable, so the descendant sees it too, and it can replay it.

The fix separates the two channels: the **session secret travels only on a second,
independent pipe** (fd 4 in the child), and every response carries an **HMAC-SHA256** over the
request identity. A descendant that inherited only the IPC handle has no secret, so it cannot
produce a valid MAC. Two further layers detect rather than merely blunt the attack:
the socket's holder set is audited for handle transfer, and a pid + process-start-time token
detects PID reuse.

## Commits in this PR (oldest first)

| sha | subject | lineage |
|---|---|---|
| `06aec2fc` | feat(governed): 受管调用者以进程句柄与签名通道证明身份 | M-044 / MS-002 |
| `590efbc4` | test(governed): 覆盖受管调用者的四类反例与身份来源约束 | M-044 / MS-002 |

## What is in the diff

| File | Role |
|---|---|
| `lib/governed/managed-caller-signing.js` | HMAC response authentication; MAC covers kind, request id, seq, operation and body |
| `lib/governed/managed-caller-identity.js` | OS-level facts: process start token, IPC socket address, socket holder set, command digest |
| `lib/governed/managed-caller-session.js` | Session lifecycle, handshake, request/response, identity freezing, holder and continuity audits |
| `lib/governed/managed-caller-supervisor.js` | Supervisor: non-detached spawn, secret pipe, batch scope, child-side endpoint |
| `tests/governed/managed-caller-*.test.js` | 40 tests across session, signing and identity facts |
| `tests/governed/fixtures/m044-ms002-*.js` | Executor fixture (incl. the deliberate handle-transfer case) and grandchild fixture |

## Validation

- `node --test --test-timeout 20000 tests/governed/managed-caller-*.test.js` → **40 pass / 0 fail**
- No fixture process leaks after the run (`ps … | grep m044-ms002` is empty), including the
  grandchild that deliberately holds the inherited descriptor
- `node scripts/test-runner.cjs --scope governed` → 14/15; the single failure
  (`governed/codex-shadow-persist.test.js`) is **pre-existing** — it fails identically with this
  branch's changes stashed
- Full suite: **415/479 with 64 failures** vs. baseline **412/476 with the same 64 failures**.
  The failure set is identical and contains none of the files added here → **no regression**
- `node scripts/check-l3-boundary.js` → 0 violations; `node scripts/check-template-parity.js` → 3/3 match

## Scope boundaries (deliberately not touched)

- `lib/governed/launcher.js` is **unchanged**; its existing `detached: true` + `0600` context
  file behaviour still serves the existing non-sensitive flows and is **never** used as a
  fallback for sensitive batches (a test asserts the sensitive path contains no
  `CORTEX_LAUNCH_CONTEXT`, `context.json` or `detached: true`)
- `lib/coordination/lease*.js` untouched (MS-003 scope)
- No third-party dependency; Node built-ins only
- No SamHMI product code, no Windows connection, no Lease requested

## Status and remaining gate

VC-044-003 / 004 / 005 are **implemented and self-tested, but not marked PASS**. VC-044-018
requires an independent validator who did not implement the change to review the source diff,
the credential and process-identity chain and the negative matrix, with the sign-off bound to
this repository's source SHA. That review is in progress against SHA `590efbc4`.

MS-001's threat-model exclusion adjudication (`D-M044-MS001-THREAT-MODEL-ADJUDICATION-OPEN`)
is still open, and MS-003 does not start before it is settled. The SamHMI-side product security
posture stays `BLOCK`; this PR does not change that.

Refs: M-044 / MS-002
