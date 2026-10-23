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

## The relay attack — found by the first independent review

The first independent review of this PR (against `590efbc4`) returned **FAIL**, and it found a
hole the secret-on-a-second-channel fix does not close.

The coordinator's `_dispatchInbound` never verified the MAC of an **inbound** request, and the
coordinator signed its own answer to that inbound request **with its own key**. A descendant
holding the transferred handle could therefore:

1. read the coordinator's outbound REQUEST off the shared handle,
2. replay it back as an inbound REQUEST with an **attacker-chosen payload**,
3. receive the coordinator's **legitimately signed** answer to that payload, and
4. feed it straight back into the coordinator's pending slot.

The coordinator then accepted a response its supervised child never sent, computed from a
payload the attacker chose. The reviewer reproduced it 3/3 on the pristine commit:

```
[!!! REQUEST SUCCEEDED WITHOUT THE EXECUTOR ANSWERING !!!]
[COORD HANDLER PAYLOAD] = {"attackerControlled":true,"target":"/etc/shadow"}
```

**The fix is direction binding.** The signed kind now separates the two directions —
`request-out` / `request-out-response` / `request-in` / `request-in-response` — and the four are
not interchangeable. The coordinator accepts only an answer signed as `request-out-response`,
and it executes an inbound request only after that request verifies under `request-in`. The
coordinator therefore never signs an answer to an unauthenticated inbound request, so there is
no signed material left for an attacker to relay. The response MAC additionally binds the
**request payload digest**, so a signed answer cannot be moved to a different payload.

Two further findings from the same review were fixed in the same round:

- **The negative cases were not reaching the coordinator.** A frame written straight onto the
  socket arrives with Node's IPC envelope intact, and the coordinator was discarding the whole
  envelope instead of routing the payload — so the "forged response" fixtures had never
  actually delivered a forgery. The envelope is now unwrapped before routing.
- **The audits were never called.** `auditChannelHolders` / `auditProcessContinuity` existed but
  ran on no request path, and degraded environments reported `ok: true`. Both now run on the
  request path and **fail closed**: an unknown socket address or a missing start token refuses
  the dispatch rather than permitting it.

## Commits in this PR (oldest first)

| sha | subject | lineage |
|---|---|---|
| `06aec2fc` | feat(governed): 受管调用者以进程句柄与签名通道证明身份 | M-044 / MS-002 |
| `590efbc4` | test(governed): 覆盖受管调用者的四类反例与身份来源约束 | M-044 / MS-002 |
| `b80d5ae8` | docs(pr): 补 MS-002 受管调用者证明的 PR 说明 | M-044 / MS-002 |
| `d630b0dd` | fix(governed): 让受管调用者的反例在 Linux 与 macOS 上同样成立 | M-044 / MS-002 |
| `bd4c006c` | fix(governed): 封堵受管调用者的中继路径并让身份审计 fail-closed | M-044 / MS-002 |

## What is in the diff

| File | Role |
|---|---|
| `lib/governed/managed-caller-signing.js` | HMAC response authentication; MAC covers the **direction-bound kind**, request id, seq, operation, request payload digest and body |
| `lib/governed/managed-caller-identity.js` | OS-level facts: process start token (microsecond on macOS, boot-id qualified on Linux), IPC socket address, socket holder set, command digest |
| `lib/governed/managed-caller-session.js` | Session lifecycle, handshake, request/response, direction-bound inbound authentication, read-only identity, holder and continuity audits **on the request path** |
| `lib/governed/managed-caller-supervisor.js` | Supervisor: non-detached spawn, secret pipe, batch scope, child-side endpoint |
| `tests/governed/managed-caller-*.test.js` | 51 tests across session, signing and identity facts |
| `tests/governed/fixtures/m044-ms002-*.js` | Executor fixture (incl. the deliberate handle-transfer and relay cases), grandchild fixture, relay-attacker fixture |

## Validation

- `node --test --test-timeout 30000 tests/governed/managed-caller-*.test.js` → **51 pass / 0 fail** on macOS
  and **51 pass / 0 fail** on Linux (`node:22-bookworm` + `lsof`)
- `node --test --test-timeout 30000 tests/governed/*.test.js` → **219 pass / 0 fail**
- No fixture process leaks after the run (`ps … | grep m044-ms002` is empty), including the
  grandchild that deliberately holds the inherited descriptor
- `node scripts/check-l3-boundary.js` → 0 violations; `node scripts/check-template-parity.js` → 3/3 match

### Correction to an earlier attribution

An earlier revision of this PR described the `governed/codex-shadow-persist.test.js` failure as
"pre-existing — it fails identically with this branch's changes stashed". **That attribution was
wrong.** The real cause is that this worktree's `.agent` gitlink is not initialised (the repo has
no `.gitmodules`, so `git submodule status` reports `fatal: no submodule mapping found`), and
`lib/governed/codex-shadow-persist.js` requires
`.agent/skills/context-budget/scripts/minimal-context.js`. Supplying that skill makes the file
pass 3/3 and the whole `tests/governed/` directory pass 219/219. CI fetches `.agent` at the pinned
gitlink commit, so CI is unaffected.

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
this repository's source SHA. The **first** review returned FAIL; the defects it found are fixed
in `bd4c006c`, and a **second** independent review is in progress against SHA `bd4c006c`.

MS-001's threat-model exclusion adjudication (`D-M044-MS001-THREAT-MODEL-ADJUDICATION-OPEN`)
is still open, and MS-003 does not start before it is settled. The SamHMI-side product security
posture stays `BLOCK`; this PR does not change that.

Refs: M-044 / MS-002
