# Offline migration implementation checkpoint

These components are internal, not a complete production migration path.
`migration inspect/plan` still uses the Linux reader. No unsigned native worker
is connected to the public command, and no provider is deployed by these changes.

## Native sources

`scripts/native/inventory-worker.m` uses descriptor-relative reads, bounded
enumeration and framed output. `inventory-launcher.m` validates the exact worker
size/hash/static signature before spawn, then its running code identity before
forwarding a project request. Its empty release identity defaults deliberately
return `MIGRATION_NATIVE_RELEASE_UNAVAILABLE`.

Release preparation must compile the worker for each supported real architecture,
obtain separately authorized official signing, bind its size/SHA256/CDHash/TeamID
and requirement into the launcher, then sign that launcher and build the trusted
release manifest. No signing identity is configured or used here. Node-side
manifest verification, authenticated CLI integration, complete signed positive
and replacement tests, and real dual-architecture validation remain pending.

The output decoder rejects partial/endless streams, mismatched content and final
digests, unsupported names/identities and invalid framing. Local tests invoke the
worker directly only to verify its mechanism; that is not a production trust path.
Backpressure and SIGTERM tests call the actual launcher I/O/reaping functions in
an isolated harness. They do not replace signed end-to-end tests. Future Node
supervision must bound cancellation of its own launcher/worker process group;
uncontrolled SIGKILL is not represented as successful cleanup.

## Authority persistence

`lib/offline-migration/provider/authority-store.js` owns one private SQLite format.
Binding, audit, highwater and history append in one FULL-synchronous transaction.
Opening an existing file performs header and read-only exact schema/history
validation before a writable connection. Unknown WAL/schema/history is rejected
without reconstruction or journal-mode changes. A hot journal which cannot be
read without recovery is refused; a separately reviewed control-domain recovery
workflow is still required.

This primitive cannot prove writer shutdown. It does not accept a user boolean
as freeze evidence, issue operation tokens, activate generations, or perform
rollback. It must only be used behind the future protected provider control
service. Calling its low-level methods is not authorization to migrate data.

## Pending protected migration work

Real systemd provider and persistent freeze proof, operation-token lifecycle,
format 3 conversion from real v1, witness bridge/recovery, historical authorization
replay refusal, old-reader rejection and controlled disabled rollback are not yet
implemented end to end. The current non-root, no-network test image has no
systemctl, no `/run/systemd/system`, and PID 1 is sh. It cannot demonstrate a real
systemd control domain. No host services, ACLs, credentials or real project data
were changed to manufacture that evidence.

All historical failures remain recorded. Scoped component passes do not replace
full product strict tests, dual upgrades, exact-head CI, independent security
review, complete commit-message approval or release gates.
