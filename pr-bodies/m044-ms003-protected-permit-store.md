## Summary

Implements **M-044 / MS-003 — the protected scope's transactional dispatch permit store and
the platform authorization adapter that anchors it**.

Two pieces, one property. The property is: *the set of identities that can write the anchor
domain is exactly {the service identity}*. The permit store is what depends on that property,
and the adapter is what finally makes it enforceable.

## Why this PR exists now

The MS-003 product source had **never reached `origin/main`**. It was not an oversight of
this round — every prior Decision for this milestone said "does not authorize committing or
pushing product source, does not authorize creating a PR", so the files stayed in the isolated
worktree across eight rounds of rework. The consequence was concrete: the SamHMI side could
not lift its product-security `BLOCK`, because the capability was never delivered and
"wait for M-044's capability sign-off" could never be satisfied.

MS-002 shipped the same way via PR #114. This PR is the corresponding step for MS-003.

## The protected scope's transactional dispatch permit store

Permits, idempotency keys, desktop draining and revocation tombstones commit in one database
transaction; the permit is returned only after the durable commit.

The property VC-044-007 requires detecting: *once a one-shot permit is consumed, if an
attacker rolls the database back to a pre-consumption snapshot, is the permit consumable a
second time?*

The high-water mark therefore lives **outside** the database's rollback domain, in the
protected anchor directory, as an append-only journal of `intent(seq, body_digest)` /
`commit(seq, body_digest)` records. Comparing the committed high-water mark `H` with the
database's own anchor sequence `D` is unambiguous:

| relation | reading | recoverable? |
| :--- | :--- | :--- |
| `D < H` | the database is older than the journal — a rollback | never |
| `D > H` | crash between the database commit and the journal commit | **yes**, the only recoverable case |
| `D == H` | the database matches the journal | the journal's `body_digest` must equal the database body |

A one-step rollback produces `D == H-1`, which is the first case and is never recoverable.
The recovery entry point therefore cannot launder a rollback.

## The platform authorization adapter

The previous strict check implemented **pure POSIX semantics** (mode bits + `st_uid`), which
is wrong on two of the three supported platforms:

- **Windows** — mode bits are constantly `0666` and there is no `st_uid`, so strict
  refused *every* Windows deployment (the target platform) while proving nothing. The real
  authorization model is the DACL.
- **macOS** — a named ACL entry grants write without showing up in the mode bits, so a
  deployment that `staff` could write was accepted as safe.

The adapter reads "who can write this object" from the platform's own authorization model:

| platform | model | source |
| :--- | :--- | :--- |
| POSIX | mode bits | `fs.lstatSync` |
| macOS | POSIX bits + NFSv4-style ACL | `ls -lde` (LC_ALL=C) |
| Windows | DACL | `Get-Acl` + `ConvertTo-Json` (structured ACEs) |

The judgment rule is unified: **the writable identity set must equal {the declared service
identity}**. The declaration is explicit, and the calling process's identity must equal it.
Trusting only "whoever is calling" would make the check circular — a process able to run as
the service identity would pass by definition. The explicit comparison turns impersonation
into a detectable failure.

Three states stay distinguishable:

- `null` — the platform model cannot be enumerated. This is **not** "safe" and **not**
  "nobody can write": it is "unknown", and it fails closed.
- empty set — nobody can write the object.
- a set — these identities can write it.

Collapsing `null` into the empty set would turn an unreadable or unparseable ACL into a
silently accepted deployment. New error codes 1050-1054 carry this:
`ERR_ANCHOR_AUTHORIZATION_UNKNOWN` (not decidable), `ERR_ANCHOR_SERVICE_IDENTITY_INVALID`,
`ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH`, `ERR_ANCHOR_WRITER_SET` (the writer set is not
exactly {service identity}), `ERR_ANCHOR_ADAPTER_UNAVAILABLE`.

The Windows adapter deliberately does **not** fold a group SID into the caller's identity:
Administrators, Users and Everyone mean "ordinary processes can write this", and their members
are not the deployment operator. The DACL owner is counted as a writer too, because the owner
implies `WRITE_DAC`.

## The declared service identity is persisted with the state

The managed recovery entry points run long after the store was opened and from a different
process. Persisting the identity means they apply the same contract instead of whatever
their own caller happened to pass.

## Validation

Local:

- `node --test 'tests/coordination/*.test.js'` → **622 pass / 0 fail**
- `node --test 'tests/governed/*.test.js'` → **231 pass / 0 fail**
- `node --test 'tests/security/*.test.js' 'tests/runtime-layout/*.test.js'` → **58 pass / 0 fail**
- adapter-specific suite → **12 pass / 0 fail**

Real Windows host, three DACL shapes (the probe only applies ACLs to its own temporary
directory and deletes it afterwards; no system directory, no install, no elevation, no
service or task, **no account creation, no user switching**):

| shape | owner | writable set the adapter derives | verdict |
| :--- | :--- | :--- | :--- |
| 1 default inheritance | Administrators | {`"*"`, SYSTEM, current account, Administrators} | unusable |
| 2 SYSTEM only | Administrators | {SYSTEM, Administrators} | unusable |
| 3 SYSTEM only | SYSTEM | {SYSTEM} | **usable** |

Shapes 2 and 3 differ **only in the owner**: an administrator-group owner implies
`WRITE_DAC`, so the owner is itself a second writer. This gives real-hardware support to
the deployment contract "the anchor domain's owner must not be an administrator group",
which until now was an inference.

Shape 3's same-account write **succeeds** — that is the administrator-token privilege bypass
already located and reproduced by the `privilege-bypass-discriminator` probe (the token
carries `SeRestorePrivilege` and friends; removing them makes the same write fail with
EPERM). The adapter therefore excludes **ordinary** same-account processes, not an elevated
administrator token — the boundary V6 records, unchanged by this PR.

Evidence: `.agent/missions/M-044/evidence/ms003-windows-authorization-adapter-verification-2026-10-26.md`.

## Scope boundaries (deliberately not touched)

- No protected service is installed, no service or scheduled task is created, nothing is
  elevated, no system directory ACL is modified
- No Windows connection for sensitive UIA
- **No user account is created and no login user is switched** — the whole M-044 line uses the
  current account and only reads ACLs/SIDs/tokens
- No SamHMI product code, no release or distribution
- Submission is by precise path; `git add .` was never run, and this repo's other agents'
  untracked content is untouched

## Status and remaining gate

VC-044-007 stays **REVISE**. Closing it still requires measuring the ACL on a protected
deployment, which is an installation-time action that this PR does not authorize. The
deployment contract also carries two items that remain unmeasured: the shape with a real
service SID (this host has no registered service SID) and whether a non-administrator
service identity can establish and hold that ACL.

The SamHMI-side product-security posture stays `BLOCK`; this PR does not change that.

Refs: M-044 / MS-003
