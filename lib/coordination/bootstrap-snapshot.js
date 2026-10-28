// The bootstrap snapshot (design document section 2.2.3).
//
// The snapshot exists so that a registration that was interrupted can be
// told apart from a registration that never happened. It carries the
// batch identity, the state of the registration, and the digest of the
// receipt the target side returned.
//
// Three properties matter and all three are enforced here:
//
//   1. The snapshot is created with atomic create-if-absent (O_EXCL). Of
//      two concurrent creators only the first succeeds; the second gets
//      EEXIST and does NOT overwrite (design counterexample 22).
//   2. The state only moves forward: created -> registered -> consumed ->
//      absent. A move backwards is state corruption and stops the route
//      (design section 2.2.3 R3-B3 ruling 2).
//   3. The state may only be advanced by the same single identity that
//      created the snapshot, and the advance happens inside the same
//      protected critical section as the pin verification it belongs to.
//      Splitting them would leave a "created + pin present" state that
//      cannot be decided.
//
// The snapshot is NOT a receipt of what happened and it does not decide
// whether a route may proceed. The cross-machine initiator only REQUESTS;
// every judgement and every write happens on the target side inside its
// protected critical section. A snapshot that reports a conclusion the
// target side did not reach is not evidence.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { CoordinationError } = require("./errors");

function fail(code) { throw new CoordinationError(code); }

const SNAPSHOT_FILE = "bootstrap-snapshot.json";
const SNAPSHOT_SCHEMA_VERSION = 1;

// The state machine. The order in this list IS the order the state may
// move in; a move to an earlier state is corruption.
const SNAPSHOT_STATES = Object.freeze(["created", "registered", "consumed", "absent"]);

function stateRank(state) {
  const index = SNAPSHOT_STATES.indexOf(state);
  if (index < 0) fail("ERR_BOOTSTRAP_STATE_INVALID");
  return index;
}

function requireText(value) {
  if (typeof value !== "string" || !value) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

function requireSafeInteger(value) {
  if (!Number.isSafeInteger(value)) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

function digestOf(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshotPath(snapshotDir) {
  return path.join(snapshotDir, SNAPSHOT_FILE);
}

function writeSnapshot(snapshotDir, snapshot) {
  const body = JSON.stringify(snapshot);
  const target = snapshotPath(snapshotDir);
  const temporary = path.join(snapshotDir, "." + SNAPSHOT_FILE + ".tmp-" + process.pid);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
}

function readSnapshot(snapshotDir) {
  let raw;
  try { raw = fs.readFileSync(snapshotPath(snapshotDir), "utf8"); }
  catch (error) {
    // A snapshot file that does not exist is the normal terminal state:
    // there is no snapshot, so there is nothing to reconnect to. That is
    // DIFFERENT from a snapshot file that exists but could not be read.
    //
    // The second case is the dangerous one. A same-account ordinary
    // process -- the attacker the design names -- can make a 0600 file
    // unreadable with a chmod, or delete it outright. If that were read as
    // "no snapshot", the route would be allowed to proceed, and a
    // DIFFERENT batch's public key would land in the pin set -- where it
    // can authorise permits.
    //
    // So the distinction is made explicitly here, exactly as it is for
    // the pin state file: "there is no snapshot" versus "the snapshot
    // could not be read". The second is an undecidable fact, and an
    // undecidable fact is not satisfied (design section 2.2.2).
    if (error && error.code === "ENOENT") return null;
    // The snapshot exists but could not be read. That is an undecidable
    // fact, and an undecidable fact is not "no snapshot". The caller
    // decides how to treat it -- classifySnapshot() turns it into an
    // "undecidable" verdict that stops the route, while advanceSnapshot()
    // refuses to move a state it cannot read.
    fail("ERR_BOOTSTRAP_STATE_INVALID");
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail("ERR_BOOTSTRAP_STATE_INVALID"); }
  if (!parsed || typeof parsed !== "object") fail("ERR_BOOTSTRAP_STATE_INVALID");
  if (parsed.schema_version !== SNAPSHOT_SCHEMA_VERSION) fail("ERR_BOOTSTRAP_STATE_INVALID");
  stateRank(parsed.snapshot_state);
  for (const field of ["decision_id", "instance_id", "fingerprint", "batch_public_key_fingerprint"]) {
    requireText(parsed[field]);
  }
  // run_id and generation are optional in the snapshot: they identify the
  // run the snapshot belongs to, but they are NOT part of the batch
  // identity, so their absence does not make the snapshot undecidable.
  if (parsed.run_id !== null && parsed.run_id !== undefined) requireText(String(parsed.run_id));
  if (parsed.generation !== null && parsed.generation !== undefined) {
    requireSafeInteger(parsed.generation);
  }
  return parsed;
}

// Create the snapshot.
//
// The create is atomic: the file is opened with O_EXCL, so of two
// concurrent creators only the first one gets to write. The second one
// sees EEXIST and is refused -- it does not overwrite the snapshot that is
// already there (design counterexample 22).
function createSnapshot(options) {
  const { snapshotDir, batchIdentity, runId, generation, nowMs } = options;
  requireText(snapshotDir);
  for (const field of ["decision_id", "instance_id", "fingerprint"]) {
    requireText(batchIdentity[field]);
  }
  requireSafeInteger(nowMs);
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    decision_id: batchIdentity.decision_id,
    instance_id: batchIdentity.instance_id,
    fingerprint: batchIdentity.fingerprint,
    batch_public_key_fingerprint: batchIdentity.fingerprint,
    snapshot_state: "created",
    registration_receipt_digest: null,
    run_id: runId === undefined ? null : requireText(String(runId)),
    generation: generation === undefined ? null : requireSafeInteger(generation),
    created_at_ms: nowMs,
  };
  try {
    const handle = fs.openSync(snapshotPath(snapshotDir), "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(snapshot));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if (error && error.code === "EEXIST") fail("ERR_BOOTSTRAP_EXISTS");
    throw error;
  }
  return snapshot;
}

// Advance the snapshot's state.
//
// The advance is idempotent: moving to the state the snapshot is already
// in is a success, not an error. It never moves backwards -- that is
// corruption, and corruption stops the route rather than being repaired
// (design section 2.2.3 R3-B3 ruling 2).
function advanceSnapshot(options) {
  const { snapshotDir, nextState, receiptDigest, nowMs } = options;
  requireText(snapshotDir);
  requireSafeInteger(nowMs);
  const next = requireText(nextState);
  const nextRank = stateRank(next);
  const snapshot = readSnapshot(snapshotDir);
  if (!snapshot) fail("ERR_BOOTSTRAP_STATE_INVALID");
  const currentRank = stateRank(snapshot.snapshot_state);
  if (nextRank < currentRank) fail("ERR_BOOTSTRAP_STATE_INVALID");
  if (nextRank === currentRank) {
    // Idempotent. A repeated advance to the same state is a success.
    if (next === "registered" && receiptDigest && snapshot.registration_receipt_digest !== receiptDigest) {
      // Two different receipts for the same state is not idempotent, it is
      // a disagreement about what was registered.
      fail("ERR_BOOTSTRAP_STATE_INVALID");
    }
    return snapshot;
  }
  if (next === "registered") {
    // The receipt digest is written in the SAME step as the state advance.
    // A state of "registered" without a receipt digest is corruption.
    const digest = requireText(receiptDigest);
    snapshot.registration_receipt_digest = digest;
  }
  snapshot.snapshot_state = next;
  snapshot.updated_at_ms = nowMs;
  writeSnapshot(snapshotDir, snapshot);
  return snapshot;
}

// Clean the snapshot up.
//
// The cleanup is an atomic rename-then-unlink, so of two concurrent
// cleaners only the first succeeds and the rest get ENOENT, which is an
// idempotent success (design section 2.2.3 R3-B3 ruling 2, item 3).
function cleanupSnapshot(options) {
  const { snapshotDir } = options;
  requireText(snapshotDir);
  const target = snapshotPath(snapshotDir);
  const trash = target + ".trash-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.renameSync(target, trash);
  } catch (error) {
    if (error && error.code === "ENOENT") return { cleaned: false, alreadyAbsent: true };
    throw error;
  }
  try {
    fs.unlinkSync(trash);
  } catch {
    // The entry is out of the snapshot namespace already, so a reader no
    // longer sees it as a snapshot. The leftover is reported so that the
    // caller can treat it as the residue the design describes.
    return { cleaned: false, residue: trash };
  }
  return { cleaned: true, alreadyAbsent: false };
}

// Decide what a leftover snapshot means.
//
// The judgement is NOT "is the snapshot still there". It is "what state is
// it in, and can the target side independently verify that the pin belongs
// to this batch". Those two together tell a normal reconnect apart from a
// crash residue (design section 2.2.3 R3-B3 ruling 2).
//
// The verification capability is supplied by the caller. When it is not
// available, EVERY "registered and the snapshot is still there" case is
// treated as the crash residue, which stops the route. That is the
// conservative default: an implementation that cannot decide must not
// widen the permission to proceed.
function classifySnapshot(options) {
  const { snapshotDir, batchIdentity, canVerifyPinOwnership } = options;
  for (const field of ["decision_id", "instance_id", "fingerprint"]) {
    requireText(batchIdentity[field]);
  }
  let snapshot;
  try {
    snapshot = readSnapshot(snapshotDir);
  } catch (error) {
    // A snapshot that exists but could not be read is NOT the same as a
    // snapshot that does not exist.
    //
    // "No snapshot" is the normal terminal state: there is nothing to
    // reconnect to, so the route may proceed. "The snapshot could not be
    // read" is an UNDECIDABLE fact -- a same-account ordinary process can
    // make a 0600 file unreadable with a chmod, or delete it outright --
    // and an undecidable fact is not satisfied (design section 2.2.2:
    // "undecidable does not mean pass").
    //
    // So the verdict here is "undecidable" and the route stops. Returning
    // "absent" instead would let a DIFFERENT batch's public key land in
    // the pin set, where it could authorise permits -- the authorisation
    // bypass the design's pin-clause exists to prevent.
    if (error && (error.key === "ERR_BOOTSTRAP_STATE_INVALID"
      || error.code === "ERR_BOOTSTRAP_STATE_INVALID")) {
      return { classification: "undecidable", snapshot: null, reconnectAllowed: false };
    }
    throw error;
  }
  if (!snapshot) {
    // No snapshot: the normal terminal state. A reconnect is allowed.
    return { classification: "absent", snapshot: null, reconnectAllowed: true };
  }
  const identityMatches =
    snapshot.decision_id === batchIdentity.decision_id &&
    snapshot.instance_id === batchIdentity.instance_id &&
    snapshot.fingerprint === batchIdentity.fingerprint;
  if (!identityMatches) {
    // The snapshot belongs to a different batch. That is the "replaced"
    // case: the route stops and nothing is cleaned up.
    return { classification: "foreign-batch", snapshot, reconnectAllowed: false };
  }
  const state = snapshot.snapshot_state;
  if (state === "absent") {
    return { classification: "absent", snapshot, reconnectAllowed: true };
  }
  if (state === "created") {
    // The pin may or may not have been written. Whether the route may
    // proceed depends on whether the target side can say which it is.
    if (typeof canVerifyPinOwnership !== "function") {
      return { classification: "undecidable", snapshot, reconnectAllowed: false };
    }
    const verdict = canVerifyPinOwnership(snapshot);
    if (verdict === "ours") {
      // The pin was written but the receipt was not written back. The
      // state is advanced to "registered" inside the same critical section
      // as the verification, and the route continues.
      return { classification: "ours-not-receipted", snapshot, reconnectAllowed: true };
    }
    if (verdict === "none") {
      // The registration never reached the target. It may be repeated.
      return { classification: "not-registered", snapshot, reconnectAllowed: true };
    }
    return { classification: "undecidable", snapshot, reconnectAllowed: false };
  }
  if (state === "registered" || state === "consumed") {
    if (typeof canVerifyPinOwnership !== "function") {
      // The conservative default: without the verification capability, a
      // leftover registered snapshot stops the route.
      return { classification: "unverifiable", snapshot, reconnectAllowed: false };
    }
    const verdict = canVerifyPinOwnership(snapshot);
    if (verdict === "ours") {
      // A normal reconnect inside the cleanup window. The pin is reused,
      // the state is advanced and the cleanup finishes. The route does NOT
      // stop just because the snapshot is still there.
      return { classification: "normal-reconnect", snapshot, reconnectAllowed: true };
    }
    // The pin is missing, or it belongs to another batch. That is the
    // crash residue or the replacement case: the route stops and the
    // snapshot is NOT cleaned up.
    return { classification: "residue-or-replaced", snapshot, reconnectAllowed: false };
  }
  return { classification: "undecidable", snapshot, reconnectAllowed: false };
}

// Whether the snapshot may be advanced to the next state RIGHT NOW.
//
// The pin write and the snapshot advance are two halves of ONE protected
// critical section (design section 2.2.3, R3-B3 revision 2). The advance
// is the half that can fail for reasons the pin write knows nothing about,
// so if the advance failed AFTER the pin was written, the domain would be
// left in the "created + pin present" state the design names as
// undecidable -- with the pin already on disk.
//
// So the advanceability is checked BEFORE the pin write. What can be
// checked is everything the advance depends on: that the snapshot can be
// read at all, that its state may still move forward to the requested
// one, and that the receipt digest agrees with the state it would
// advance into.
//
// A check that fails here stops the route before anything is written.
function assertSnapshotAdvanceable(options) {
  const { snapshotDir, nextState, receiptDigest } = options;
  requireText(snapshotDir);
  const next = requireText(nextState);
  const nextRank = stateRank(next);
  let snapshot;
  try {
    snapshot = readSnapshot(snapshotDir);
  } catch (error) {
    // The snapshot could not be read, so its state cannot be decided.
    // That is an undecidable fact, and an undecidable fact is not
    // satisfied.
    if (error && (error.key === "ERR_BOOTSTRAP_STATE_INVALID"
      || error.code === "ERR_BOOTSTRAP_STATE_INVALID")) {
      fail("ERR_BOOTSTRAP_UNVERIFIABLE");
    }
    throw error;
  }
  if (!snapshot) fail("ERR_BOOTSTRAP_STATE_INVALID");
  const currentRank = stateRank(snapshot.snapshot_state);
  if (nextRank < currentRank) fail("ERR_BOOTSTRAP_STATE_INVALID");
  if (nextRank === currentRank) {
    // Idempotent. A repeated advance to the same state is a success, but
    // two different receipts for the same state are a disagreement about
    // what was registered -- and that is refused here too, so that the
    // refusal happens BEFORE the pin write rather than after it.
    if (next === "registered" && receiptDigest
      && snapshot.registration_receipt_digest !== receiptDigest) {
      fail("ERR_BOOTSTRAP_STATE_INVALID");
    }
    return snapshot;
  }
  if (next === "registered") {
    // A state of "registered" without a receipt digest is corruption, so
    // the digest has to be present before the advance is attempted.
    requireText(receiptDigest);
  }
  return snapshot;
}

module.exports = {
  SNAPSHOT_FILE,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_STATES,
  createSnapshot,
  advanceSnapshot,
  assertSnapshotAdvanceable,
  cleanupSnapshot,
  classifySnapshot,
  readSnapshot,
  snapshotPath,
};
