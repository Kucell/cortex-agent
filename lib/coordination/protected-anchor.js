"use strict";

// Rollback detection for the protected permit store.
//
// A valid but older snapshot from the same service_epoch is indistinguishable
// from the newest state using only in-database checks (Decision, minimum
// epoch, body checksum, clock). The high-water mark therefore lives OUTSIDE
// the database rollback domain.
//
// Why an append-only journal instead of a single replaceable record:
// an independent validator showed that a single record cannot distinguish a
// genuine crash window (the anchor was written, the database commit did not
// happen) from a one-step database rollback, because both leave byte-identical
// state. That made the recovery entry point usable to launder a rollback: a
// consumed one-shot permit could be revived and consumed again.
//
// The journal removes that ambiguity. It is append-only and lives in the
// protected anchor directory, so an attacker who can replace the database
// cannot roll the journal back. Each transaction writes:
//
//   intent(seq=N, body_digest)   before the database transaction commits
//   commit(seq=N, body_digest)   after the database transaction commits
//
// The committed high-water mark H is the largest sequence with a commit
// entry. Comparing the database's own anchor_sequence D against H yields an
// unambiguous reading:
//
//   D < H   the database is older than the journal: a rollback. Refuse.
//   D > H   the database is ahead of the journal: a crash between the
//           database commit and the journal commit entry. This is the only
//           recoverable case, and it is provable because the journal's
//           dangling intent at D carries the digest the database now has.
//   D == H  the database matches the journal. The journal's body_digest at H
//           must equal the digest of the committed database body, otherwise
//           the database body was altered.
//
// A one-step rollback produces D == H-1, which is the first case and is never
// recoverable. The recovery entry point can therefore not launder a rollback.
//
// Ordering contract per transaction:
//   1. append intent(seq) and fsync
//   2. commit the database transaction
//   3. append commit(seq) and fsync
// A crash before 2 leaves a dangling intent: the database still carries the
// previous sequence, so D == H and the service starts normally. A crash
// between 2 and 3 leaves D == H+1, which is the recoverable case above.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const authz = require("./anchor-authorization");

const JOURNAL_FILE = "protected-anchor.journal";
const ENTRY_PREFIX = "protected-anchor-entry-";
const HIGH_WATER_FILE = "protected-anchor-high-water.log";
const JOURNAL_SCHEMA_VERSION = 1;
// The declaration file is a second, independent witness of the committed
// high-water mark. It must not be silently absent: a missing or empty
// declaration used to read as "no mark at all", which turned the second
// witness into a no-op exactly when it was needed. It now fails closed.
const EMPTY_HIGH_WATER = "ERR_ANCHOR_DECLARATION_MISSING";
// The anchor directory is the trust root of the rollback detection: the
// high-water mark is only trustworthy while the directory cannot be changed
// by an ordinary process. The service design already requires the anchor
// (trust anchor) to be writable by the service identity only, but that was a
// written convention and not a checked fact. The checks below make it a
// fact the code verifies, so a deployment that does not honour it is refused
// instead of silently losing the rollback detection.
//
// The checks look at two things: the permission bits of the directory and of
// the files inside it, and the owner of the directory. A directory that is
// owned by the account of the calling process cannot be protected against
// that account's other processes, so such a directory is refused in the
// strict mode. The development and test mode opts out explicitly.
const ANCHOR_MODE = Object.freeze({
  // "strict": the anchor directory must not be writable by group or other,
  // must not be owned by the calling account, and every file in it must be
  // readable and writable by the owner only. This is the mode the protected
  // deployment uses.
  strict: "strict",
  // "permissive": the permission bits are not checked. This exists for the
  // development and test environment, where the anchor directory belongs to
  // the developer account and no separate service identity exists.
  permissive: "permissive",
});

// The permission modes are ordered by strength: the strict mode is the
// stronger contract. A caller may state a mode that is at least as strong as
// the recorded one, but never a weaker one.
const ANCHOR_MODE_STRENGTH = Object.freeze({
  [ANCHOR_MODE.strict]: 2,
  [ANCHOR_MODE.permissive]: 1,
});

// A witness inside the anchor domain must belong to the calling account. The
// service writes its own journal entries and declaration, so they are owned
// by the service identity. The owner of a file may always write it, whatever
// the permission bits say, so a witness owned by anybody else is a second
// writer that can rewrite the witness in place.
//
// The comparison is a separate function so that the rule can be exercised
// without the privilege needed to create a file owned by another account.
function assertWitnessOwnership(currentUid, itemStat) {
  if (currentUid === null) return;
  if (typeof itemStat.uid !== "number") return;
  if (itemStat.uid !== currentUid) fail("ERR_ANCHOR_OWNERSHIP");
}

// Collect the permission-relevant facts of one directory level. A directory
// that other identities may write lets them replace its entries wholesale,
// so the level is reported as such and its files are checked individually.
function collectWitnesses(dirStat, currentUid, items) {
  const dir = dirStat.path;
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    let itemStat;
    try { itemStat = fs.lstatSync(full); }
    catch { continue; }
    if (itemStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    if (itemStat.isFile() && (itemStat.mode & 0o7777) & 0o022) fail("ERR_ANCHOR_PERMISSIONS");
    if (itemStat.isFile()) items.push(itemStat);
  }
}

// The paths of the files inside one directory level. The writable identity
// set of each of them is checked by the authorization adapter, so only the
// paths are collected here.
function collectWitnessPaths(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  const paths = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let itemStat;
    try { itemStat = fs.lstatSync(full); }
    catch { continue; }
    if (itemStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    if (itemStat.isFile()) paths.push(full);
  }
  return paths;
}

// The core of the strict check: for every object of the anchor domain, the
// set of identities that can write it has to be exactly {the service
// identity}.
//
// Three outcomes are distinguished:
//
//   the set cannot be enumerated  -> ERR_ANCHOR_AUTHORIZATION_UNKNOWN
//   the set contains "any identity" -> ERR_ANCHOR_PERMISSIONS
//   the set is not exactly {service} -> ERR_ANCHOR_WRITER_SET
//
// The first case is the one that used to be invisible: on Windows the mode
// bits said "666" and the check refused every deployment, and on macOS a
// writable named ACL was invisible to the mode bits and was accepted. The
// adapter reports the real writable set for both, and a set that cannot be
// read is refused instead of guessed.
function assertWriterSetIsServiceIdentity(checkedPaths, adapter, declared) {
  const writers = writableIdentitiesBatch(checkedPaths, adapter);
  if (writers === null) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
  for (const targetPath of checkedPaths) {
    const set = writers.get(targetPath);
    if (set === undefined) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
    if (set.has(authz.ANY_IDENTITY)) fail("ERR_ANCHOR_PERMISSIONS");
    if (set.size !== 1 || !set.has(declared)) fail("ERR_ANCHOR_WRITER_SET");
  }
}

// The ancestor chain is checked for replaceability rather than for the full
// writer set: an ancestor that somebody else can write lets that somebody
// replace the whole anchor directory, which discards every witness at once.
// The POSIX rule that used to apply here -- group or other writable is
// refused unless the directory carries the sticky bit -- is expressed on
// Windows through the same writer set, where a writable ancestor is an
// ancestor with a second writer.
function assertAncestorsNotReplaceable(ancestorPaths, adapter, declared, opts) {
  if (ancestorPaths.length === 0) return;
  if (process.platform !== "win32") {
    for (const ancestorPath of ancestorPaths) {
      const stat = fs.lstatSync(ancestorPath);
      const mode = stat.mode & 0o7777;
      if ((mode & 0o022) && !(mode & 0o1000)) fail("ERR_ANCHOR_PERMISSIONS");
    }
    return;
  }
  const writers = writableIdentitiesBatch(ancestorPaths, adapter);
  if (writers === null) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
  for (const ancestorPath of ancestorPaths) {
    const set = writers.get(ancestorPath);
    if (set === undefined) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
    // A broad group means ordinary processes can write the ancestor, so they
    // could rename the anchor directory away and replace it. A specific
    // identity is a deployment operator, which is allowed.
    if (hasBroadWriter(set)) fail("ERR_ANCHOR_PERMISSIONS");
  }
}

// A writer set that contains a broad group means that ordinary processes can
// write the object, which is what the ancestor check refuses.
function hasBroadWriter(set) {
  for (const identity of set) {
    if (identity === authz.ANY_IDENTITY) return true;
    if (identity === "sid:S-1-1-0") return true;
    if (identity === "sid:S-1-5-11") return true;
    if (identity === "sid:S-1-5-32-545") return true;
    if (identity === "sid:S-1-5-32-544") return true;
    if (identity === "sid:S-1-5-32-546") return true;
  }
  return false;
}

// The writable identity set of several paths, in one platform call where the
// platform supports it. The adapter without a batch implementation falls
// back to one call per path.
function writableIdentitiesBatch(targetPaths, adapter) {
  if (typeof adapter.writableIdentitiesBatch === "function") {
    const batch = adapter.writableIdentitiesBatch(targetPaths);
    if (batch === null) return null;
    return batch;
  }
  const map = new Map();
  for (const targetPath of targetPaths) {
    const set = adapter.writableIdentities(targetPath);
    if (set === null) return null;
    map.set(targetPath, set);
  }
  return map;
}

// A mode that is not one of the known modes is not a weaker mode, it is an
// unknown mode. Treating an unknown mode as permissive would turn a typo or
// a tampered value into a silent opt-out of the permission contract, so it
// is refused instead.
function assertKnownAnchorMode(mode) {
  if (mode === undefined || mode === null) return ANCHOR_MODE.strict;
  if (!Object.prototype.hasOwnProperty.call(ANCHOR_MODE_STRENGTH, mode)) {
    fail("ERR_ANCHOR_MODE_INVALID");
  }
  return mode;
}

// The mode a caller states must not be weaker than the mode that was
// recorded with the state. The recorded mode is the contract of the
// deployment; a single call may not hand a weaker contract to a stricter
// store, no matter which entry point is used.
function assertNoAnchorModeDowngrade(recordedMode, requestedMode) {
  const recorded = assertKnownAnchorMode(recordedMode);
  if (requestedMode === undefined || requestedMode === null) return recorded;
  const requested = assertKnownAnchorMode(requestedMode);
  if (ANCHOR_MODE_STRENGTH[requested] < ANCHOR_MODE_STRENGTH[recorded]) {
    fail("ERR_ANCHOR_MODE_DOWNGRADE");
  }
  return requested;
}
// The declaration file grows by one record per transaction. Without a bound
// it becomes an unbounded file in the hot path, so it is compacted once it
// passes the threshold. The compaction keeps the record that carries the
// mark, so it can never lower the high-water mark.
const HIGH_WATER_COMPACT_BYTES = 256 * 1024;
// How many recent sequences keep their attempt counter. The attempt counter
// is only needed for a sequence that can still be retried, which is the most
// recent one.
const HIGH_WATER_RETENTION = 64;

class ProtectedAnchorError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProtectedAnchorError";
    this.code = code;
  }
}

function fail(code) { throw new ProtectedAnchorError(code); }

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// The anchor directory must exist, must not be a symlink, and must not be the
// database directory or live inside it: a replaced database directory must
// not carry the journal with it.
function anchorDirFor(anchorDir) {
  if (typeof anchorDir !== "string" || !anchorDir) fail("ERR_INVALID_INPUT");
  const resolved = path.resolve(anchorDir);
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { fail("ERR_ANCHOR_DIR_MISSING"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  // A symlink anywhere between the anchor directory and the file system root
  // would let the anchor directory be redirected at runtime, after the
  // separation check has already passed. The path is resolved first so that
  // the platform's own canonical aliases (for example /tmp on macOS) are
  // absorbed and not reported as an attack.
  let real = resolved;
  try { real = fs.realpathSync(resolved); }
  catch { fail("ERR_ANCHOR_DIR_MISSING"); }
  // Every component of the resolved path must be a real directory. The
  // canonical path is used so that a platform alias such as /tmp on macOS
  // is absorbed instead of being reported as an attack.
  let current = real;
  const root = path.parse(current).root;
  for (;;) {
    let componentStat;
    try { componentStat = fs.lstatSync(current); }
    catch { break; }
    if (componentStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    if (!componentStat.isDirectory()) fail("ERR_UNSAFE_PATH");
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // A symlink in the original path would let the anchor directory be
  // redirected at runtime, after the separation check has already passed.
  // The platform's own aliases (for example /tmp on macOS) live above the
  // point where the original path and the canonical path diverge, so only
  // the components below that point are inspected.
  const originalParts = resolved.split(path.sep).filter(Boolean);
  // The component directly below the root is the platform's own namespace
  // ("/tmp" and "/var" are symbolic links on macOS). Those are not part of
  // the protected path and are therefore not inspected.
  for (let i = originalParts.length - 1; i >= 1; i -= 1) {
    const component = path.sep + originalParts.slice(0, i + 1).join(path.sep);
    let componentStat;
    try { componentStat = fs.lstatSync(component); }
    catch { break; }
    if (componentStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  }
  return resolved;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Verify that the anchor domain cannot be changed by an ordinary process.
//
// The property to establish is: the set of identities that can write the
// anchor domain is exactly {the service identity}. Everything else follows
// from that.
//
// On a POSIX file system, a directory whose group and other write bits are
// clear can be written only by its owner, and a file whose group and other
// bits are clear can be written only by its owner. The owner of a file may
// always write it, whatever the permission bits say. So:
//
//   owner == the service identity, group and other not writable
//       => the only writer is the service identity
//   owner != the service identity
//       => the owner is a second writer and can delete or replace a witness
//
// The rule is therefore that the owner must BE the calling account, not that
// it must differ from it. The service writes the journal entries and the
// high-water declaration itself, so it has to own them; a domain owned by
// somebody else has that somebody else as an additional writer, which is
// exactly the state the contract forbids.
//
// The parent directories are checked as well: a writable ancestor lets the
// whole directory be renamed away and replaced.
function assertAnchorPermissions(anchorDir, mode) {
  return assertAnchorPermissionsWithIdentity(anchorDir, mode, undefined, undefined);
}

// The strict check with an explicit service identity.
//
// The declared identity is what the deployment promises the service runs as.
// It is required on Windows, where the process token cannot be trusted on
// its own: the development account is an administrator, and an
// administrator token bypasses the DACL by design, so the check has to
// state which identity the DACL is supposed to grant write to.
//
// The service identity is persisted with the store, so the managed recovery
// entry points -- which run long after the store was opened and from a
// different process -- apply the same contract instead of the one their own
// caller happened to pass.
function assertAnchorPermissionsWithIdentity(anchorDir, mode, serviceIdentity, options) {
  // A caller that states no mode is asking for the default, which is the
  // strict mode. A caller that cannot honour the permission contract has to
  // say so explicitly, so that the failure of the contract is visible in the
  // code that caused it instead of being a silent default.
  const effective = assertKnownAnchorMode(mode);
  if (effective !== ANCHOR_MODE.strict) return;
  const opts = options || {};
  const resolved = path.resolve(anchorDir);
  const adapter = authz.resolveAdapter(opts);
  // The declared service identity is the deployment's promise about who the
  // service runs as. When the caller does not declare one, the calling
  // process identity is used, which is the POSIX behaviour: on POSIX the
  // owner of the witnesses has to be the service, so the calling account IS
  // the service identity. On Windows the declaration is mandatory, because
  // the calling account is not necessarily the service and the check would
  // otherwise be circular.
  const declared = serviceIdentity === undefined || serviceIdentity === null
    ? adapter.currentIdentity()
    : adapter.normalizeIdentity(serviceIdentity);
  if (declared === null || declared === undefined) fail("ERR_ANCHOR_SERVICE_IDENTITY_INVALID");
  const caller = adapter.currentIdentity();
  if (caller === null) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
  // The calling process has to BE the declared service identity. Without
  // this a process that happens to be able to run as the service identity
  // would pass the check by definition, and the check would prove nothing.
  if (caller !== declared) fail("ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH");
  // Every file in the directory: owner only. The quarantine directory holds
  // retired evidence and is checked the same way.
  let names;
  try { names = fs.readdirSync(resolved); }
  catch { fail("ERR_ANCHOR_UNREADABLE"); }
  // The paths whose writable identity set has to be exactly the service
  // identity: the anchor domain itself, every witness in it, and the
  // quarantine directory with its contents.
  const checkedPaths = [resolved];
  for (const name of names) {
    const full = path.join(resolved, name);
    let itemStat;
    try { itemStat = fs.lstatSync(full); }
    catch { continue; }
    if (itemStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    if (itemStat.isDirectory()) {
      // The quarantine directory holds the retired evidence. Its contents are
      // witnesses too: they are read during an incident investigation, so a
      // file that somebody else can rewrite would corrupt the record. The
      // directory is therefore walked like the anchor domain itself.
      if (name === "quarantine") {
        itemStat.path = full;
        checkedPaths.push(full);
        for (const witness of collectWitnessPaths(full)) checkedPaths.push(witness);
        continue;
      }
      checkedPaths.push(full);
      continue;
    }
    if (!itemStat.isFile()) continue;
    // Only write access matters here. A witness that other identities may
    // read is not compromised: changing it requires write access. Refusing
    // group or other read access would also refuse the ordinary operational
    // reads (backup, log collection) that a protected deployment needs.
    checkedPaths.push(full);
  }
  assertWriterSetIsServiceIdentity(checkedPaths, adapter, declared);
  // The ancestor chain must not be writable by group or other either, so the
  // directory cannot be replaced by a path above it. The directory directly
  // below the root is checked, and the chain up to the anchor directory.
  //
  // The chain is walked over the canonical path. The path as given may run
  // through a platform alias such as /tmp on macOS, which is a symbolic
  // link; walking the canonical path keeps that alias from ending the
  // inspection early.
  let real = resolved;
  try { real = fs.realpathSync(resolved); }
  catch { fail("ERR_ANCHOR_DIR_MISSING"); }
  const ancestorPaths = [];
  let current = path.dirname(real);
  for (;;) {
    let parentStat;
    try { parentStat = fs.lstatSync(current); }
    catch { break; }
    if (parentStat.isSymbolicLink()) break;
    ancestorPaths.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  assertAncestorsNotReplaceable(ancestorPaths, adapter, declared, opts);
}

// The anchor and the database must live in separate rollback domains. Any of
// these relations would let one directory restore carry the other along.
function assertSeparateDomains(anchorDir, databasePath) {
  const anchor = path.resolve(anchorDir);
  const database = path.resolve(databasePath);
  const databaseDir = path.dirname(database);
  if (isInside(anchor, databaseDir) || isInside(databaseDir, anchor)) {
    fail("ERR_ANCHOR_NOT_SEPARATE");
  }
}

function journalFileFor(anchorDir) {
  return path.join(anchorDirFor(anchorDir), JOURNAL_FILE);
}

function parseEntry(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { fail("ERR_ANCHOR_CORRUPT"); }
  if (!parsed || typeof parsed !== "object") fail("ERR_ANCHOR_CORRUPT");
  if (parsed.schema_version !== JOURNAL_SCHEMA_VERSION) fail("ERR_ANCHOR_CORRUPT");
  if (!["intent", "commit", "abort"].includes(parsed.type)) fail("ERR_ANCHOR_CORRUPT");
  if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) fail("ERR_ANCHOR_CORRUPT");
  if (typeof parsed.body_digest !== "string" || !/^[a-f0-9]{64}$/.test(parsed.body_digest)) fail("ERR_ANCHOR_CORRUPT");
  if (typeof parsed.store_id !== "string" || !parsed.store_id) fail("ERR_ANCHOR_CORRUPT");
  // Entries that share a sequence are ordered by their attempt counter.
  // Without it the winner for a retried sequence would be decided by the
  // file name hash, which is unrelated to the order the attempts happened
  // in, and the wrong attempt could be selected.
  if (!Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1) fail("ERR_ANCHOR_CORRUPT");
  // Each entry carries a digest over its own fields, so a tampered entry is
  // rejected as journal corruption instead of silently changing the recorded
  // high-water mark.
  if (typeof parsed.entry_digest !== "string" || parsed.entry_digest !== entryDigest(parsed)) {
    fail("ERR_ANCHOR_CORRUPT");
  }
  return parsed;
}

function entryDigest(entry) {
  return sha256([
    String(entry.schema_version),
    String(entry.type),
    String(entry.sequence),
    String(entry.body_digest),
    String(entry.store_id),
    String(entry.attempt),
  ].join("\n"));
}

// Read the journal entries and derive the committed high-water mark. Each
// entry lives in its own file, so concurrent writers never corrupt each
// other and a torn entry is impossible.
function readJournal(journalFile) {
  const dir = path.dirname(journalFile);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if (error.code === "ENOENT") {
      return { entries: [], committed: 0, committedDigest: null, committedBySeq: new Map(),
        intentsBySeq: new Map(), aborted: new Set(), storeIds: new Set(), latestAttemptBySeq: new Map(), trailing: "" };
    }
    fail("ERR_ANCHOR_UNREADABLE");
  }
  // The journal lives in the anchor directory as one file per entry. The
  // name reserved for the journal itself must not be a symbolic link: a
  // link would point the journal at a file the attacker controls.
  const journalName = path.basename(journalFile);
  if (names.includes(journalName)) {
    let journalStat;
    try { journalStat = fs.lstatSync(path.join(dir, journalName)); }
    catch { fail("ERR_ANCHOR_UNREADABLE"); }
    if (journalStat.isSymbolicLink() || !journalStat.isFile()) fail("ERR_UNSAFE_PATH");
  }
  // Temporary files from an interrupted write are not journal entries and
  // must be ignored rather than treated as corruption: the transaction they
  // belonged to did not commit.
  const entryNames = names.filter((name) => name.startsWith(ENTRY_PREFIX) && !name.includes(".tmp-")).sort();
  const entries = [];
  for (const name of entryNames) {
    const full = path.join(dir, name);
    // The entry can disappear between the directory listing and the stat
    // (a concurrent cleanup or a race with the file system). That must be
    // reported as an anchor problem, not as a raw file system error.
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (error) {
      if (error.code === "ENOENT") fail("ERR_ANCHOR_UNREADABLE");
      fail("ERR_ANCHOR_UNREADABLE");
    }
    // A directory in the journal space is the quarantine area, not an entry.
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    let content;
    try { content = fs.readFileSync(full, "utf8"); }
    catch { fail("ERR_ANCHOR_UNREADABLE"); }
    entries.push(parseEntry(content));
  }
  let committed = 0;
  let committedDigest = null;
  const committedBySeq = new Map();
  const intentsBySeq = new Map();
  const aborted = new Set();
  const storeIds = new Set();
  // The latest attempt for a sequence decides its fate. A failed attempt
  // leaves an intent and an abort; a retry of the same sequence writes a new
  // intent with a higher attempt counter, and that retry is the one whose
  // intent must be compared against the database body. Selecting by file
  // name hash instead of by attempt order would let an aborted attempt win
  // over the retry that actually committed.
  const latestAttemptBySeq = new Map();
  for (const entry of entries) {
    const known = latestAttemptBySeq.get(entry.sequence);
    if (known === undefined || entry.attempt > known) latestAttemptBySeq.set(entry.sequence, entry.attempt);
  }
  for (const entry of entries) {
    storeIds.add(entry.store_id);
    if (entry.attempt !== latestAttemptBySeq.get(entry.sequence)) continue;
    if (entry.type === "intent") intentsBySeq.set(entry.sequence, entry);
    else if (entry.type === "abort") aborted.add(entry.sequence);
    else if (entry.type === "commit") {
      committedBySeq.set(entry.sequence, entry);
      if (entry.sequence > committed) {
        committed = entry.sequence;
        committedDigest = entry.body_digest;
      }
    }
  }
  // An intent whose attempt was aborted does not explain the database: the
  // transaction never committed. Only an intent of an attempt that neither
  // committed nor aborted is a dangling intent, and only such an intent
  // describes a crash window.
  for (const sequence of aborted) intentsBySeq.delete(sequence);
  for (const sequence of committedBySeq.keys()) intentsBySeq.delete(sequence);
  return { entries, committed, committedDigest, committedBySeq, intentsBySeq, aborted, storeIds, latestAttemptBySeq, trailing: "" };
}

function appendEntry(journalFile, entry) {
  // The attempt counter makes the order of retries for the same sequence
  // explicit. It must be derived from the journal itself, otherwise two
  // processes retrying the same sequence could pick the same counter and
  // leave two indistinguishable latest attempts.
  let attempt = entry.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    const journal = readJournal(journalFile);
    attempt = (journal.latestAttemptBySeq.get(entry.sequence) || 0) + 1;
  }
  const record = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    type: entry.type,
    sequence: entry.sequence,
    body_digest: entry.body_digest,
    store_id: entry.store_id,
    attempt,
  };
  record.entry_digest = entryDigest(record);
  const line = JSON.stringify(record) + "\n";
  // The journal is shared between processes. The database serialises the
  // state transitions, but the journal append itself must be serialised too,
  // otherwise two processes can interleave a partial line.
  // The journal directory holds one file per entry. Creating a file with an
  // exclusive name is atomic, so two processes can never interleave a line,
  // and a partially written entry can never be observed as a valid record.
  const dir = path.dirname(journalFile);
  // The file name carries a digest of the entry content, so a retried
  // sequence (the previous attempt failed and the sequence was reused) does
  // not collide with the earlier attempt and overwrite its record.
  const suffix = sha256(line).slice(0, 16);
  const target = path.join(dir, `${ENTRY_PREFIX}${String(entry.sequence).padStart(12, "0")}-${String(attempt).padStart(6, "0")}-${entry.type}-${suffix}.json`);
  const temp = target + ".tmp-" + process.pid + "-" + Date.now();
  const handle = fs.openSync(temp, "wx", 0o600);
  try {
    const written = fs.writeSync(handle, line);
    if (written !== Buffer.byteLength(line)) fail("ERR_ANCHOR_WRITE_INCOMPLETE");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    // A concurrent writer may have produced the same entry file already.
    // The entry content is derived from the committed state, so an existing
    // identical entry is not an error; a conflicting one is.
    if (error.code !== "EEXIST") throw error;
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}

// The attempt counter for the next attempt at a sequence. The caller reads
// the journal once per transaction and passes the counter to every entry of
// that attempt, so an intent, its commit and its abort all belong to the same
// attempt and the journal is not read again for each entry.
function nextAttemptFor(journal, sequence) {
  return (journal.latestAttemptBySeq.get(sequence) || 0) + 1;
}

// Move the entries of a foreign store identity out of the journal. A journal
// that carries more than one identity is unusable: every open refuses it as
// corruption and no other entry point can repair it. The foreign entries are
// moved into a quarantine directory rather than deleted, so the evidence for
// the administrator survives. Only entries of another identity are touched,
// so the store's own high-water mark is not affected.
function quarantineForeignEntries(journalFile, storeId) {
  const dir = path.dirname(journalFile);
  let names;
  try { names = fs.readdirSync(dir); }
  catch { fail("ERR_ANCHOR_UNREADABLE"); }
  const quarantineDir = path.join(dir, "quarantine");
  // The entries of the store identity that is being repaired carry its
  // high-water mark. Moving every entry away would empty the journal and
  // silently drop the mark, so the guard below refuses that. A journal that
  // already holds no entry of this identity is not a repair case: the caller
  // has to decide whether the identity is gone (reset) or the entries were
  // pruned (rebuild), and this function must not decide it by emptying the
  // journal.
  let ownCount = 0;
  for (const name of names) {
    if (!name.startsWith(ENTRY_PREFIX) || name.includes(".tmp-")) continue;
    let content;
    try { content = fs.readFileSync(path.join(dir, name), "utf8"); }
    catch { continue; }
    let entry;
    try { entry = JSON.parse(content); } catch { continue; }
    if (entry && entry.store_id === storeId) ownCount += 1;
  }
  if (ownCount === 0) return 0;
  let moved = 0;
  for (const name of names) {
    if (!name.startsWith(ENTRY_PREFIX) || name.includes(".tmp-")) continue;
    const full = path.join(dir, name);
    let content;
    try { content = fs.readFileSync(full, "utf8"); }
    catch { continue; }
    let entry;
    try { entry = JSON.parse(content); }
    catch { continue; }
    if (!entry || entry.store_id === storeId) continue;
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { mode: 0o700 });
    try {
      fs.renameSync(full, path.join(quarantineDir, name));
      moved += 1;
    } catch { /* the entry stays; the journal remains corrupt and is refused */ }
  }
  return moved;
}

// Retire the whole anchor domain. Every file that belongs to the previous
// identity is moved into the quarantine directory, including the high-water
// declaration: leaving it behind would keep the old mark and make the fresh
// instance refuse to start.
function retireAnchorDomain(anchorDir) {
  const quarantineDir = path.join(anchorDir, "quarantine");
  if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { mode: 0o700 });
  let retired = 0;
  for (const name of fs.readdirSync(anchorDir)) {
    if (name === "quarantine") continue;
    const full = path.join(anchorDir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isDirectory()) continue;
    // Only the files that belong to the anchor domain are retired. A file an
    // administrator placed in the directory is not part of the anchor state
    // and must not be moved away by a reset.
    if (!name.startsWith(ENTRY_PREFIX) && name !== HIGH_WATER_FILE &&
        name !== JOURNAL_FILE && name !== "protected-anchor-audit.log" &&
        name !== "protected-anchor-recovery.log") continue;
    try {
      fs.renameSync(full, path.join(quarantineDir, name));
      retired += 1;
    } catch { /* the file stays and the domain remains inconsistent */ }
  }
  pruneQuarantine(quarantineDir);
  return retired;
}

// The quarantine directory keeps the evidence of a retired or foreign
// identity. Without a bound it would grow without limit on a service that
// resets often. The oldest entries are removed first, because the recent
// ones are the ones an administrator still investigates.
function pruneQuarantine(quarantineDir, keep = 64) {
  let names;
  try { names = fs.readdirSync(quarantineDir); }
  catch { return 0; }
  if (names.length <= keep) return 0;
  const entries = [];
  for (const name of names) {
    const full = path.join(quarantineDir, name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      entries.push({ full, mtimeMs: stat.mtimeMs });
    } catch { /* the entry vanished */ }
  }
  if (entries.length <= keep) return 0;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let removed = 0;
  for (const entry of entries.slice(0, entries.length - keep)) {
    try { fs.unlinkSync(entry.full); removed += 1; }
    catch { /* the entry stays */ }
  }
  return removed;
}

// The high-water declaration is a second, append-only record of the
// committed mark. The journal alone cannot carry that guarantee: an attacker
// who can delete journal entries could lower the mark, because the deleted
// entries are the only witness of the previous mark. The declaration keeps
// every mark that was ever committed, so removing journal entries does not
// remove the mark they witnessed.
//
// Each line is a JSON record with its own digest, so a truncated or edited
// line is corruption rather than a silently lower mark.
function readHighWater(anchorDir) {
  const file = path.join(anchorDir, HIGH_WATER_FILE);
  // The declaration file must be a regular file. A symbolic link would let
  // the witness be redirected to a file the attacker controls, which would
  // hand them the high-water mark without touching the anchor directory.
  let fileStat;
  try { fileStat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") fail(EMPTY_HIGH_WATER);
    fail("ERR_ANCHOR_UNREADABLE");
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") fail(EMPTY_HIGH_WATER);
    fail("ERR_ANCHOR_UNREADABLE");
  }
  // An empty declaration carries no witness at all. Reading it as "no mark"
  // would silently disable the second witness exactly in the case it is
  // needed, so it fails closed instead.
  if (!content.trim()) fail(EMPTY_HIGH_WATER);
  let mark = 0;
  let digestOfMark = null;
  let storeIdOfMark = null;
  let records = 0;
  const latestAttemptBySeq = new Map();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { fail("ERR_ANCHOR_CORRUPT"); }
    if (!record || typeof record !== "object") fail("ERR_ANCHOR_CORRUPT");
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) fail("ERR_ANCHOR_CORRUPT");
    if (typeof record.body_digest !== "string" || !/^[a-f0-9]{64}$/.test(record.body_digest)) fail("ERR_ANCHOR_CORRUPT");
    if (typeof record.record_digest !== "string" || record.record_digest !== highWaterDigest(record)) fail("ERR_ANCHOR_CORRUPT");
    records += 1;
    if (Number.isSafeInteger(record.attempt) && record.attempt >= 1) {
      const known = latestAttemptBySeq.get(record.sequence) || 0;
      if (record.attempt > known) latestAttemptBySeq.set(record.sequence, record.attempt);
    }
    if (record.sequence >= mark) {
      mark = record.sequence;
      digestOfMark = record.body_digest;
      storeIdOfMark = record.store_id;
    }
  }
  return { mark, digest: digestOfMark, storeId: storeIdOfMark, records, latestAttemptBySeq };
}

function highWaterDigest(record) {
  return sha256([String(record.sequence), String(record.body_digest), String(record.store_id), String(record.attempt)].join("\n"));
}

// Append a high-water declaration. The declaration is written after the
// database commit, so a crash in between leaves the declaration one sequence
// behind the journal. The declaration therefore never claims a sequence the
// database does not have; it only repeats the mark that was already committed
// and witnessed by the journal, so it can act as a second witness when the
// journal entries are removed.
function appendHighWater(anchorDir, entry) {
  const record = {
    sequence: entry.sequence,
    body_digest: entry.body_digest,
    store_id: entry.store_id,
    attempt: entry.attempt,
  };
  const file = path.join(anchorDir, HIGH_WATER_FILE);
  // Compact the declaration before it grows without bound. The compaction
  // writes the record of the current mark and the attempt counters of the
  // most recent sequences; it never writes a mark below the current one, so
  // the high-water mark cannot be lowered by compaction.
  record.record_digest = highWaterDigest(record);
  compactHighWaterIfNeeded(anchorDir, file, record);
  let handle;
  try { handle = fs.openSync(file, "a", 0o600); }
  catch { fail("ERR_ANCHOR_WRITE_INCOMPLETE"); }
  try {
    const line = JSON.stringify(record) + "\n";
    const written = fs.writeSync(handle, line);
    if (written !== Buffer.byteLength(line)) fail("ERR_ANCHOR_WRITE_INCOMPLETE");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

// Rewrite the declaration file so that it stops growing without bound. The
// file is written to a temporary name and renamed over the original, so a
// crash in the middle leaves the original declaration intact.
function compactHighWaterIfNeeded(anchorDir, file, record) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return; }
  if (stat.size < HIGH_WATER_COMPACT_BYTES) return;
  let current;
  let records;
  try {
    current = readHighWater(anchorDir);
    records = readHighWaterRecords(anchorDir);
  }
  catch { return; }
  // The compaction keeps the record of the mark, because without it the
  // declaration would no longer witness the current mark. It also keeps the
  // most recent sequences, because their attempt counters decide which
  // attempt of a sequence is the current one. Records of older sequences are
  // dropped: those sequences are committed long ago and can no longer be
  // retried, and keeping them would make the file grow without bound.
  const keptSequences = new Set();
  if (current.digest) keptSequences.add(current.mark);
  const recent = records
    .filter((entry) => entry.sequence !== current.mark)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, HIGH_WATER_RETENTION - 1);
  for (const entry of recent) keptSequences.add(entry.sequence);
  const lines = [];
  for (const entry of records) {
    if (!keptSequences.has(entry.sequence)) continue;
    const kept = {
      sequence: entry.sequence,
      body_digest: entry.body_digest,
      store_id: entry.store_id,
      attempt: entry.attempt,
    };
    kept.record_digest = highWaterDigest(kept);
    lines.push(JSON.stringify(kept));
  }
  if (!lines.length) {
    // Nothing survived, which must not happen for a well-formed declaration:
    // the mark record is always kept. Leaving the file untouched is safer
    // than writing a declaration that no longer witnesses anything.
    return;
  }
  const temp = file + ".tmp-compact-" + process.pid + "-" + Date.now();
  let handle;
  try { handle = fs.openSync(temp, "wx", 0o600); }
  catch { return; }
  try {
    const content = lines.join("\n") + (lines.length ? "\n" : "");
    const written = fs.writeSync(handle, content);
    if (written !== Buffer.byteLength(content)) fail("ERR_ANCHOR_WRITE_INCOMPLETE");
    fs.fsyncSync(handle);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

// Read every record of the declaration file, in the order it was written.
function readHighWaterRecords(anchorDir) {
  const file = path.join(anchorDir, HIGH_WATER_FILE);
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch { return []; }
  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || !Number.isSafeInteger(record.sequence)) continue;
    records.push(record);
  }
  return records;
}

module.exports = {
  ANCHOR_MODE,
  ANCHOR_MODE_STRENGTH,
  HIGH_WATER_FILE,
  JOURNAL_FILE,
  JOURNAL_SCHEMA_VERSION,
  ProtectedAnchorError,
  anchorDirFor,
  assertAnchorPermissions,
  assertAnchorPermissionsWithIdentity,
  assertKnownAnchorMode,
  assertNoAnchorModeDowngrade,
  assertWitnessOwnership,
  appendHighWater,
  appendEntry,
  assertSeparateDomains,
  journalFileFor,
  nextAttemptFor,
  pruneQuarantine,
  quarantineForeignEntries,
  readHighWater,
  readJournal,
  retireAnchorDomain,
  sha256,
};
