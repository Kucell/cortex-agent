# Local Git transaction boundary

Status: candidate implementation and tests; no execution result is claimed here.

## Scope and entry

`createGitTransactionStore({repo, ref, gitExecutable})` is a synchronous
storage primitive for a dedicated, newly created local Linux bare repository.
The trusted fixture launcher supplies a verified installed Git executable and
a canonical repository path owned by its current UID. This constructor does not
attest that a repository was freshly created, authenticate a user, or create an
Authorization, Decision, Waitpoint, Operation, Lease or Mission.

The only ref is `refs/cortex/state`. The initial repository must be initialized
with an empty template, SHA-1 object format, initial branch `unused`, and exactly
the ordinary Linux bare core config:
repositoryformatversion=0, filemode=true, bare=true. No other config, repository
extensions, hooks directory, packed refs/objects, alternates, grafts, shallow
history, replace refs, remotes, includes, filters or promisor state are supported.
Git does not initialize or clone a repository through this API.

Public methods:

- `readSnapshot(keys)` captures one direct ref OID and reads every requested
  record from that immutable commit. It returns a typed Git revision, UTF-8
  text, blob OID, byte count and raw-byte SHA-256 for each present key.
- `prepareBatch({expected_revision, writes, transaction_id})` accepts
  either null for an absent ref or exactly {store_kind:"git",value:40hex}.
  Every write has exactly key and content. It validates the entire input and
  merged tree before its first object write, then writes loose blobs, trees and
  a commit with exactly the expected parent (or no parent for the first commit).
  The result contains an opaque instance-bound single-use handle and preparation
  evidence. It does not advance the ref.
- `publishPrepared(handle)` consumes that handle even on rejection. It checks
  the current ref, then attempts one `update-ref --no-deref ref new old`.
  It never retries the CAS, re-prepares a stale proposal, deletes leftover
  objects, rewinds a ref, or invokes a caller-supplied admission callback.

All exported results say effect_authority=false. A caller Boolean or fabricated
fixture record cannot upgrade this storage API into an authenticated broker.

## Bounds and process controls

At most 64 keys are supported in a complete tree, 64 KiB per text value and
256 KiB total content. Keys are bounded ASCII relative segments. Duplicate
keys, traversal, leading dots, lock suffixes and file/directory collisions are
rejected. Content must be a JavaScript string with a lossless UTF-8 roundtrip.
Raw Buffer values, deletion, executable modes and any extra write field are
rejected. Every stored leaf is 100644. Reads validate the complete tree and
recompute every returned Git blob SHA-1 against the tree OID.

Only fixed plumbing commands are used. No shell, inherited environment, index,
checkout, network transport, credentials, installation or model is involved.
The environment disables system/global config, replacements, lazy fetching and
terminal prompts; fixed command arguments disable hooks, fsmonitor, signing,
automatic GC/maintenance and transports. No GIT_INDEX_FILE is created.

Before each Git invocation, the implementation rechecks canonical paths,
directory bindings, exact config bytes, HEAD format, loose-object/refs layout,
file types and permissions. Leaf reads use bounded same-fd buffers, no-follow
and nonblocking opens with before/after identity and metadata comparisons.
The repository and nested directories must be owned by the same UID and not
group/world writable. The trusted executable is absolute, canonical, regular,
not group/world writable and metadata-bound to the factory observation.

Each command has at most 1.5 seconds and a 1 MiB maxBuffer bound;
each API operation has a 15-second cooperative command budget. Preparation and
publication elapsed times and the publication budget-exhausted flag are
recorded. These are not OS real-time guarantees: synchronous filesystem calls
and process teardown can exceed a deadline. A successful Git publication remains
a recorded publication if the elapsed budget was exhausted afterward.

## Visibility, persistence and uncertainty

The atomic unit is visibility through this one canonical ref. An artifact,
its receipt and related authority/operation/lease records can occupy a single
tree and become visible together. This does not make arbitrary filesystem,
tool, network or Host effects atomic.

Preparation has real persistence effects before publication. A losing CAS,
cancelled proposal or crash can leave unreachable blobs, trees and commits.
Evidence distinguishes prepare-object from publish-ref. Absence from the
canonical ref is not absence from disk; sensitive payloads must be admitted
before preparation by a future broker. This primitive receives synthetic
fixture text only in the reviewed tests.

PUBLISHED means the actual Git command succeeded and the ref was observed at
that commit or a verified descendant. It is not Task acceptance or proof of
the legitimacy of later descendants. A known stale base or a recognized failed
CAS returns CONFLICT. Timeout, signal, ambiguous failure, inconsistent post-read
or unverified history returns UNKNOWN with the prepared commit and available
ref observation. UNKNOWN quarantines that instance; no automatic recovery or
retry is allowed. Prepared object evidence must be retained for investigation.

A receipt stored in the same commit cannot contain that commit's own hash:
doing so creates a circular hash dependency. The fixture receipt binds a
transaction identifier, known base and artifact digest instead. The publication
result separately supplies the final commit OID.

## Cooperative-writer limits

Every supported writer preserves the previous canonical commit as its parent
and uses the same expected-old CAS on the same local repository/ref.
Concurrent publication of already prepared commits is supported. Concurrent
object preparation is not promised: a guard can observe Git's temporary loose
object names and fail closed. Observed rollback, deletion or unverified ancestry
quarantines an instance; this is not an atomic defense against a transient ABA
rewrite between observations.

The no-deref flag does not reject symbolic refs atomically. Git can replace a
symref whose referent resolves to the supplied old OID. The implementation
rejects an already observed symref, but a concurrent external ref-type change
is outside the supported writer protocol. A real-Git test deliberately performs
that unsupported change between the final guard and the Git call and observes
publication plus UNKNOWN/quarantine. It does not pretend the write was denied.
A malicious same-UID writer can also mutate objects, configuration or paths
between validation and use. Metadata checks are not an OS sandbox or cross-
process filesystem transaction.

Separate clones have independent refs and fences. This module has no remote
push/server CAS or shared-device protocol. No two-device authority claim follows
from these local tests.

## Integration still required

Before any production enablement, an authenticated owning-workflow provider
must validate the resource-bound Decision/Waitpoint, Authorization scope and
expiry, current Operation and Lease fence, and one-time run identity. It must
compute the complete state transition and artifact/receipt under one immutable
base, then publish all of them through the same CAS. Revoke, supersede, release,
lease expiry/renewal, operation transition and all effect writers must use that
same transactional ref. A denied request must stop before any hash-object -w.

Current direct FS writers and the old single-key Git Store are unchanged:
management-api Decision/Waitpoint tmp+rename writers; Operation lifecycle's
separate authorization, journal and resource writes; lease-cli's separate state
and idempotency writes; CoordinationApplicationService's lease/journal/snapshot
writes and recovery paths. None is automatically covered by this primitive.
They require migration or explicit exclusion before any global fencing claim.

Actual Owner identity, OS/tool isolation preventing the Host from modifying the
canonical store, trustworthy time/expiry, one-time run binding, durable restart
policy and a real AI Host remain separate unresolved production dependencies.
This candidate does not wire the legacy synthetic dispatch path, run a model,
or establish formal L3/Tier H acceptance.

## Test execution boundary

The single test file requires only this new module and Node built-ins.
Tests use new temporary synthetic bare repositories, a fixed installed
/usr/bin/git resolved canonically, fixed small artifacts and a sibling sentinel.
They invoke real local Git plumbing for successful publication, snapshot
consistency, CAS competition, revocation and retained objects. Two actual Git
leaders are launched for one simultaneous update-ref race; their stop/close
observation is bounded and an unobserved exit fails and preserves the fixture.

Other cases intercept only the relevant spawnSync call to place a deterministic
competing write or model a lost/uncertain exit. A reported timeout after a real
successful publication is deliberately UNKNOWN even though the ref contains
the prepared commit. Mocks are restored before filesystem snapshots or cleanup.
The symref case uses a deliberate unsupported writer and exposes Git's actual
behavior. Synthetic record names do not make these canonical authority records.

No repository checkout, dependency installation, remote call, real registry,
user project, credential, model, canonical Mission/Task completion or release
action belongs to this test closure. All generated roots are disposable;
unobserved owned process exit preserves the root and fails rather than treating
directory cleanup as process cleanup.

Primary semantics: https://git-scm.com/docs/git-update-ref and Git's
t/t1400-update-ref.sh tests for no-deref symref updates.
