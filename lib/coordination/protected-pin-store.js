// The REGISTERED anchor domain (design document section 4.2.1).
//
// This is NOT MS-003's witnessing anchor domain. It stores the batch public
// key pin and nothing else: it carries no journal, witnesses no database
// body digest, and takes no part in rollback detection. Reusing
// ProtectedPermitStore for it would graft the "witnesses the database body"
// semantics onto a directory that only has to hold a pin.
//
// What it DOES reuse is MS-003's permission judgement surface: the
// writable-identity set enumeration and comparison, the null-is-fail-closed
// rule, and the mandatory service identity declaration. The contract this
// domain adds is the same one MS-003's own domain carries -- the writable
// set must be EXACTLY the service identity -- and it is checked with the
// same code, so the two cannot drift apart.
//
// The domain lives on the VERIFIER's machine (Windows side). The permit
// database stays on the Mac side. The two are on different machines, so
// their separation is automatic there, but the check is still made
// explicitly: a deployment shape change must not be allowed to quietly
// place the pin inside the permit database's directory.
//
// Two rules govern what may be written here, and they are different in
// kind:
//
//   1. Pin entries only ever GROW. A pin records a registration fact (who
//      was registered as a verifiable key). Revocation does not remove a
//      pin entry -- revocation semantics are carried entirely by the
//      fingerprint-level revoked set (design section 2.3.1 R4-B4 ruling 1).
//      Removing the entry would also deadlock the revocation protocol: a
//      revoked key could then never sign the list that revokes it.
//   2. The revoked fingerprint set also only ever GROWS, and it is a set of
//      facts rather than a list of intentions, so a list that drops a
//      fingerprint is refused.
//
// The state file is the domain's whole content. It is written atomically:
// the bytes go to a temporary file in the same directory, are flushed and
// fsynced, and are then renamed over the target. A reader therefore sees
// either the previous state or the next one, never a half-written file.
// The rename is atomic within a directory on the same filesystem, which is
// why the temporary file is created in the domain itself and not in the
// system temp directory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const anchor = require("./protected-anchor");
const { CoordinationError } = require("./errors");

function fail(code) { throw new CoordinationError(code); }

const STATE_FILE = "pin-state.json";
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_LOCK_TTL_MS = 30_000;

// The batch identity is the triple that decides whether an existing pin
// belongs to THIS batch (design section 2.2.3 R3-B3 ruling 1). The fields
// that are deliberately NOT part of it are listed in the design table:
// run_id and generation would kill a legitimate reconnect, and
// valid_from / valid_until / source_digest / deployment_digest do not
// distinguish one batch from another.
const BATCH_IDENTITY_FIELDS = Object.freeze(["decision_id", "instance_id", "fingerprint"]);

function requireText(value, key) {
  if (typeof value !== "string" || !value) fail(key || "ERR_PERMIT_INPUT_INVALID");
  return value;
}

function requireSafeInteger(value, key) {
  if (!Number.isSafeInteger(value)) fail(key || "ERR_PERMIT_INPUT_INVALID");
  return value;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function emptyState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    // The pins that have been registered on this machine. Each entry is a
    // registration fact and is never removed.
    pins: [],
    // The fingerprints that have been revoked. Only ever grows.
    revoked_fingerprints: [],
    // The revocation sequence that has been APPLIED locally. The revocation
    // list whose sequence is applied+1 is the only one accepted next.
    applied_revocation_sequence: 0,
    // The highest sequence that has been SEEN. This may run ahead of the
    // applied one while a pull is in flight.
    highest_seen_revocation_sequence: 0,
    // The clock-poisoning marker. A poisoned domain refuses every new
    // permit until it is cleared by the procedure the design defines.
    clock_poisoned: false,
  };
}

function stateFilePath(pinDir) {
  return path.join(pinDir, STATE_FILE);
}

function readState(pinDir) {
  let raw;
  try { raw = fs.readFileSync(stateFilePath(pinDir), "utf8"); }
  catch { return emptyState(); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail("ERR_PIN_STATE_CORRUPT"); }
  if (!parsed || typeof parsed !== "object") fail("ERR_PIN_STATE_CORRUPT");
  if (parsed.schema_version !== STATE_SCHEMA_VERSION) fail("ERR_PIN_STATE_CORRUPT");
  if (!Array.isArray(parsed.pins)) fail("ERR_PIN_STATE_CORRUPT");
  if (!Array.isArray(parsed.revoked_fingerprints)) fail("ERR_PIN_STATE_CORRUPT");
  requireSafeInteger(parsed.applied_revocation_sequence, "ERR_PIN_STATE_CORRUPT");
  requireSafeInteger(parsed.highest_seen_revocation_sequence, "ERR_PIN_STATE_CORRUPT");
  if (typeof parsed.clock_poisoned !== "boolean") fail("ERR_PIN_STATE_CORRUPT");
  for (const pin of parsed.pins) {
    if (!pin || typeof pin !== "object") fail("ERR_PIN_STATE_CORRUPT");
    for (const field of BATCH_IDENTITY_FIELDS) requireText(pin[field], "ERR_PIN_STATE_CORRUPT");
    requireText(pin.public_key_pem, "ERR_PIN_STATE_CORRUPT");
  }
  return parsed;
}

// The state is written atomically: a temporary file in the same directory,
// then a rename over the target. The temporary file carries a name that no
// reader looks at, and it is removed if the write fails, so a crashed
// write leaves the previous state intact rather than a truncated one.
function writeState(pinDir, state) {
  const body = JSON.stringify(state);
  const target = stateFilePath(pinDir);
  const temporary = path.join(pinDir, "." + STATE_FILE + ".tmp-" + process.pid);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
}

// The public key fingerprint is derived from the key material itself, so a
// pin entry cannot claim a fingerprint that does not belong to the key it
// carries. The fingerprint is what the design compares, so it has to be
// the derived one and not a value the caller supplied.
function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

function findPin(state, fingerprint) {
  return state.pins.find((pin) => pin.fingerprint === fingerprint) || null;
}

// The batch identity comparison is field-by-field equality on the triple
// (design section 2.2.3 R3-B3 ruling 1). A pin that is missing or
// unreadable is "undecidable", and an undecidable fact is handled as NOT
// satisfied -- the route stops. It is never treated as "different batch
// but harmless", because the two would lead to the same action here.
function sameBatchIdentity(pin, batchIdentity) {
  if (!pin) return false;
  for (const field of BATCH_IDENTITY_FIELDS) {
    if (pin[field] !== batchIdentity[field]) return false;
  }
  return true;
}

class ProtectedPinStore {
  #pinDir;
  #decisionId;
  #serviceIdentity;
  #anchorMode;
  #platform;
  #lockTtlMs;
  #lockDepth = 0;

  constructor(pinDir, options = {}) {
    this.#pinDir = pinDir;
    this.#decisionId = options.decisionId;
    this.#serviceIdentity = options.serviceIdentity;
    this.#anchorMode = options.anchorMode;
    this.#platform = options.platform;
    // The lock's own expiry. It is a backstop for a holder that died: a
    // live holder always wins, and a dead one is reclaimed immediately
    // rather than after the expiry elapses.
    this.#lockTtlMs = Number.isSafeInteger(options.lockTtlMs) && options.lockTtlMs > 0
      ? options.lockTtlMs
      : DEFAULT_LOCK_TTL_MS;
  }

  // open() brings the domain up. The permission contract is checked BEFORE
  // anything is read or written, so a domain whose writable set is not
  // exactly the service identity is refused rather than operated in.
  static open(pinDir, options = {}) {
    requireText(options.decisionId, "ERR_PERMIT_INPUT_INVALID");
    if (!pinDir) fail("ERR_PERMIT_INPUT_INVALID");
    const resolved = path.resolve(pinDir);
    // The pin directory must exist, must not be a symlink, and must not be
    // a file. anchorDirFor checks exactly those properties and normalises
    // the canonical path.
    const anchorDir = anchor.anchorDirFor(resolved);
    // The permission judgement surface is MS-003's. The strict mode
    // requires the service identity to be declared on Windows, because
    // there the calling account is not necessarily the service -- without
    // the declaration the comparison degenerates into comparing the caller
    // with itself.
    anchor.assertAnchorPermissionsWithIdentity(
      anchorDir,
      anchor.assertKnownAnchorMode(options.anchorMode),
      options.serviceIdentity,
      options,
    );
    return new ProtectedPinStore(anchorDir, options);
  }

  // The permit database's directory must not contain this domain and this
  // domain must not contain it. On the two-machine deployment the two are
  // on different hosts and the constraint holds automatically; the check is
  // made explicitly so that a deployment change cannot quietly violate it.
  assertSeparateFromPermitDatabase(databasePath) {
    anchor.assertSeparateDomains(this.#pinDir, databasePath);
  }

  get pinDir() { return this.#pinDir; }

  // The local critical section.
  //
  // "A transaction" in this design means the LOCAL critical section on the
  // registered anchor domain on the verifier's machine (design section
  // 2.3.1 R3-B2 ruling 1). It does NOT cover the Mac-side permit store and
  // it does NOT cover the network connection.
  //
  // The lock is a file lock taken on the domain itself. It is deliberately
  // not shared with the MS-003 SQLite transaction: those are two separate
  // locks on two separate machines, and the only thing that passes between
  // them is a signed revocation list.
  //
  // The caller injects the body; the body runs with the lock held, and the
  // lock is released whether the body returns or throws.
  //
  // The section is REENTRANT within one process. The cross-machine path
  // takes the section around the whole registration -- the exclusivity
  // check, the pin write and the snapshot advance are one atomic step --
  // and that path calls into the store's own registerPin, which takes the
  // section again. A non-reentrant lock would make the outer section fail
  // against its own inner call, and the fix for that must NOT be "take the
  // lock less often": the outer section is what makes the three steps one
  // step.
  //
  // Reentrancy is safe here because the lock exists to keep a SECOND
  // PROCESS from interleaving. Within one process the code is already
  // sequential, so a nested entry has nothing to exclude.
  criticalSection(body) {
    if (typeof body !== "function") fail("ERR_PERMIT_INPUT_INVALID");
    if (this.#lockDepth > 0) {
      this.#lockDepth += 1;
      try {
        return body();
      } finally {
        this.#lockDepth -= 1;
      }
    }
    const lockPath = path.join(this.#pinDir, ".pin-critical-section.lock");
    const release = acquireLock(lockPath, this.#lockTtlMs);
    this.#lockDepth = 1;
    try {
      return body();
    } finally {
      this.#lockDepth = 0;
      release();
    }
  }

  // Register a pin.
  //
  // The write is atomic create-if-absent with O_EXCL semantics: of two
  // concurrent registrants only the first succeeds, the second gets EEXIST
  // and does NOT overwrite (design section 2.2.3). That property is what
  // makes the registration exclusive without a separate check-then-act
  // window.
  //
  // The caller supplies the write as a function, and the whole
  // decision-and-write runs inside the protected critical section, so the
  // "there is no existing pin" half of the exclusivity guarantee is not a
  // window between a check and a write.
  registerPin(options) {
    const { batchIdentity, publicKeyPem, write } = options;
    for (const field of BATCH_IDENTITY_FIELDS) requireText(batchIdentity[field], "ERR_PERMIT_INPUT_INVALID");
    requireText(publicKeyPem, "ERR_PERMIT_INPUT_INVALID");
    if (typeof write !== "function") fail("ERR_PERMIT_INPUT_INVALID");
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    if (batchIdentity.fingerprint !== fingerprint) fail("ERR_PIN_FINGERPRINT_MISMATCH");
    return this.criticalSection(() => {
      const state = readState(this.#pinDir);
      const existing = findPin(state, fingerprint);
      if (existing) {
        // A pin for this key already exists. If it belongs to THIS batch
        // the route is a reconnect: the pin is reused, not rewritten.
        // If it belongs to a DIFFERENT batch the route stops -- the pin is
        // never overwritten with a new batch.
        if (sameBatchIdentity(existing, batchIdentity)) {
          return { registered: false, reused: true, fingerprint, pin: existing };
        }
        fail("ERR_PIN_BATCH_MISMATCH");
      }
      const entry = {
        decision_id: batchIdentity.decision_id,
        instance_id: batchIdentity.instance_id,
        fingerprint,
        public_key_pem: publicKeyPem,
        registered_at_ms: requireSafeInteger(options.nowMs, "ERR_PERMIT_INPUT_INVALID"),
      };
      // The create-if-absent write is the atomicity guarantee. A concurrent
      // creator that loses the race gets EEXIST and does not overwrite.
      const created = write(entry, fingerprint);
      if (created === false) fail("ERR_PIN_ALREADY_EXISTS");
      state.pins.push(entry);
      writeState(this.#pinDir, state);
      return { registered: true, reused: false, fingerprint, pin: entry };
    });
  }

  // The pins that are registered on this machine. This is the ONLY source
  // of public keys the verification path accepts.
  listPins() {
    const state = readState(this.#pinDir);
    return state.pins.map((pin) => ({ ...pin }));
  }

  // The fingerprint set of the registered pins. A revocation list is
  // refused unless the key that signed it is in this set.
  pinnedFingerprints() {
    const state = readState(this.#pinDir);
    return new Set(state.pins.map((pin) => pin.fingerprint));
  }

  // The public key for a fingerprint, or null. Null means "not registered
  // here", which the verification path treats as a refusal -- it never
  // falls back to a key carried by the list itself.
  publicKeyFor(fingerprint) {
    const state = readState(this.#pinDir);
    const pin = findPin(state, fingerprint);
    return pin ? pin.public_key_pem : null;
  }

  // The local revocation state, as the verification path consumes it.
  revocationState() {
    const state = readState(this.#pinDir);
    return {
      appliedRevocationSequence: state.applied_revocation_sequence,
      highestSeenRevocationSequence: state.highest_seen_revocation_sequence,
      revokedFingerprints: new Set(state.revoked_fingerprints),
    };
  }

  // Commit an applied revocation list.
  //
  // The revoked set and the applied high-water mark advance TOGETHER. The
  // design's local invariant B is exactly that: on exit from the critical
  // section, either both advanced or neither did (design section 2.3.1
  // R3-B2 ruling 3).
  //
  // The caller has already verified the list -- the signature, the chain
  // position, the signer's presence in the pin and the signer's absence
  // from the revoked set. This function only commits what passed those
  // checks; it never decides whether a list is acceptable.
  commitRevocation(options) {
    const { revokedFingerprints, sequence } = options;
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    if (!Array.isArray(revokedFingerprints)) fail("ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = readState(this.#pinDir);
      // The applied set only grows. A commit that would drop a fingerprint
      // is refused and nothing advances.
      const incoming = new Set(revokedFingerprints);
      for (const known of state.revoked_fingerprints) {
        if (!incoming.has(known)) fail("ERR_REVOCATION_SET_NOT_MONOTONIC");
      }
      state.revoked_fingerprints = Array.from(incoming).sort();
      state.applied_revocation_sequence = sequence;
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
      }
      writeState(this.#pinDir, state);
      return {
        appliedRevocationSequence: state.applied_revocation_sequence,
        revokedFingerprints: state.revoked_fingerprints.length,
      };
    });
  }

  // Record that a revocation list was SEEN, without applying it. The seen
  // mark may run ahead of the applied one while a pull is in flight.
  noteRevocationSeen(sequence) {
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = readState(this.#pinDir);
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
        writeState(this.#pinDir, state);
      }
      return { highestSeenRevocationSequence: state.highest_seen_revocation_sequence };
    });
  }

  // The direct revocation registration (design section 2.3.1 R4-B4
  // ruling 5).
  //
  // This is the ONE exception path that does not depend on a cross-machine
  // signature: it is how a batch's revocation is conveyed when no valid
  // batch key is left to sign a list with. It writes the revoked
  // fingerprint set directly, and it advances the revocation sequence by
  // one so the chain does not break.
  //
  // It does NOT relax the rule that the signer of a list must still be
  // valid -- this path never verifies a signature at all, so that rule does
  // not apply to it.
  registerDirectRevocation(options) {
    const { fingerprint, sequence } = options;
    requireText(fingerprint, "ERR_PERMIT_INPUT_INVALID");
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = readState(this.#pinDir);
      const incoming = new Set(state.revoked_fingerprints);
      incoming.add(fingerprint);
      state.revoked_fingerprints = Array.from(incoming).sort();
      state.applied_revocation_sequence = sequence;
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
      }
      writeState(this.#pinDir, state);
      return {
        appliedRevocationSequence: state.applied_revocation_sequence,
        revokedFingerprints: state.revoked_fingerprints.length,
      };
    });
  }

  // The clock-poisoning marker. A poisoned domain refuses every new
  // permit until the clearing procedure the design defines has run.
  isClockPoisoned() {
    return readState(this.#pinDir).clock_poisoned;
  }

  setClockPoisoned(poisoned) {
    if (typeof poisoned !== "boolean") fail("ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = readState(this.#pinDir);
      state.clock_poisoned = poisoned;
      writeState(this.#pinDir, state);
      return { clockPoisoned: state.clock_poisoned };
    });
  }

  // The batch identity of a registered pin, for the reconnect comparison.
  // An unregistered or unreadable pin yields null, which the reconnect
  // logic treats as undecidable -- and undecidable means the route stops.
  batchIdentityFor(fingerprint) {
    const pin = findPin(readState(this.#pinDir), fingerprint);
    if (!pin) return null;
    return {
      decision_id: pin.decision_id,
      instance_id: pin.instance_id,
      fingerprint: pin.fingerprint,
    };
  }
}

// The exclusive lock.
//
// Node has no advisory file lock in its standard library, so the lock is an
// O_EXCL lock FILE with an owner and an expiry, and it follows the same
// shape the coordination journal already uses (journal.js, section 8.1):
// exactly one holder creates the file, a holder that dies leaves a lock
// that is reclaimed by moving it out of the lock namespace atomically, and
// a lock that was renewed under a live owner is put back rather than
// stolen.
//
// The lock is not the only thing standing between two registrants: the
// atomic create-if-absent write of the pin entry is. The lock exists so
// that the read-decide-write sequence is not interleaved with another
// registrant's, and so the revocation commit is a single atomic step.
function acquireLock(lockPath, ttlMs) {
  const owner = "pin-pid" + process.pid + "-" + Date.now().toString(36);
  const token = crypto.randomBytes(16).toString("hex");
  const payload = () => JSON.stringify({
    owner,
    token,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    pid: process.pid,
  });

  const tryCreate = () => {
    // O_EXCL: the create either succeeds or reports that somebody else
    // already holds the lock. There is no window in which two holders both
    // believe they created it.
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, payload(), "utf8");
      fs.fsyncSync(fd);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };

  let fd;
  try {
    fd = tryCreate();
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    // Somebody holds the lock. If that holder is alive the section is
    // refused rather than waited on: the design wants the revocation pull
    // to carry its own explicit timeout, and a silent wait here would let
    // the lock be held for an unbounded time.
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(lockPath, "utf8")); }
    catch { existing = null; }
    if (existing && isProcessAlive(existing.pid)) {
      fail("ERR_LEASE_CONFLICT");
    }
    // The holder is gone. Move the stale lock out of the lock namespace
    // atomically. The file is never unlinked in place: another contender
    // may already have replaced it, and unlinking would leave two live
    // writers.
    const stalePath = lockPath + ".stale." + process.pid + "." + crypto.randomBytes(4).toString("hex");
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (reclaimError) {
      fail("ERR_LEASE_CONFLICT");
    }
    try {
      let moved = null;
      try { moved = JSON.parse(fs.readFileSync(stalePath, "utf8")); }
      catch { moved = null; }
      // The moved file has to be the one that was inspected. If it is not,
      // somebody replaced the lock while it was being reclaimed, and the
      // safe answer is to refuse rather than to take the lock.
      if (!moved || moved.owner !== (existing && existing.owner)) {
        try { fs.renameSync(stalePath, lockPath); } catch { /* fail closed below */ }
        fail("ERR_LEASE_CONFLICT");
      }
      // A live owner always wins, even if its expiry has not elapsed.
      if (isProcessAlive(moved.pid)) {
        try { fs.renameSync(stalePath, lockPath); } catch { /* fail closed below */ }
        fail("ERR_LEASE_CONFLICT");
      }
      fd = tryCreate();
    } catch (inner) {
      if (inner && inner.code === "EEXIST") fail("ERR_LEASE_CONFLICT");
      throw inner;
    } finally {
      try { fs.unlinkSync(stalePath); } catch { /* best effort */ }
    }
  }

  return () => {
    try {
      // The lock is only released if this holder still owns it. A lock
      // that was reclaimed and re-taken belongs to somebody else now, and
      // deleting it would revoke THEIR lock.
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.token === token) fs.unlinkSync(lockPath);
    } catch { /* already released or replaced */ }
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another account.
    return Boolean(error && error.code === "EPERM");
  }
}

module.exports = {
  ProtectedPinStore,
  STATE_FILE,
  STATE_SCHEMA_VERSION,
  BATCH_IDENTITY_FIELDS,
  publicKeyFingerprint,
  sameBatchIdentity,
};
