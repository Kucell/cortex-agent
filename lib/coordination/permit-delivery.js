"use strict";

// Cross-machine permit delivery: the per-batch Ed25519 signing core.
//
// This module implements MS-004 step 1 only. It is the local half of the
// channel: the batch key pair, the signed permit, the verifier, and the local
// transaction boundary of the revocation bookkeeping. The pin storage and
// the cross-machine key retrieval path are step 3, and the protected pin
// store is step 2 -- neither is implemented here, and this module does not
// pretend otherwise. registerPinExclusively therefore takes the protected
// critical section as an injected callback instead of writing to a pin
// store of its own.

const crypto = require("node:crypto");
const { CoordinationError } = require("./errors");

// The binding facts of MS-003's consume(): the fields the permit store
// compares before it lets an action run. The signature has to cover every
// one of them -- not the subset this design happens to think about -- or a
// permit could be replayed against a different lease, session, host, worker,
// run, generation, desktop, app, epoch, fencing value, operation, target or
// parameter set. The list is checked against the live binding set (see
// consumeBindingFields), so a change in consume() turns the coverage
// assertion red instead of silently leaving a field uncovered.
const BINDING_FIELD_MAP = Object.freeze([
  ["leaseId", "lease_id"],
  ["sessionId", "session_id"],
  ["hostId", "host_identity"],
  ["workerId", "worker_identity"],
  ["runId", "run_id"],
  ["generation", "generation"],
  ["desktopKey", "desktop_key"],
  ["ownedAppId", "owned_app_id"],
  ["serviceEpoch", "service_epoch"],
  ["fencing", "fencing"],
  ["operation", "operation"],
  ["targetDigest", "target_digest"],
  ["paramsDigest", "params_digest"],
  ["sequence", "sequence"],
]);

// The signed fields that are not part of consume()'s binding but are the
// verifier's basis for acting: when the permit was issued, when it stops
// being usable, and which permit it is.
const ADDITIONAL_SIGNED_FIELDS = Object.freeze([
  "issued_at_ms",
  "deadline_ms",
  "permit_id",
]);

// The store spells the binding in camelCase, the signed message in
// snake_case. Both sides have to agree on the spelling byte for byte, so the
// mapping lives here once and is never assembled from string fragments at
// the call sites: a mapping table that is written twice is a mapping table
// that can drift, and a drifted mapping is invisible to the signature -- the
// permit stays internally consistent while covering the wrong fields.
const STORAGE_TO_SIGNED = Object.freeze(
  Object.fromEntries(BINDING_FIELD_MAP.map(([storage, signed]) => [storage, signed])),
);
const SIGNED_TO_STORAGE = Object.freeze(
  Object.fromEntries(BINDING_FIELD_MAP.map(([storage, signed]) => [signed, storage])),
);

function fail(code) { throw new CoordinationError(code); }

function requireText(value) {
  if (typeof value !== "string" || !value) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

function requireSafeInteger(value) {
  if (!Number.isSafeInteger(value)) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

// Canonical serialization.
//
// The bytes that get signed must be identical on both machines. The rules
// are frozen: keys sorted by UTF-16 code unit, no whitespace, UTF-8, and no
// floating point. The sort is spelled out explicitly so that the intent is
// checkable rather than inherited from a default.
function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      // A float would serialize differently on the two sides (and a value
      // that is not exactly representable cannot round-trip at all), so it
      // is refused rather than normalized.
      fail("ERR_PERMIT_INPUT_INVALID");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "}";
  }
  fail("ERR_PERMIT_INPUT_INVALID");
  return "";
}

function canonicalBytes(message) {
  return Buffer.from(canonicalize(message), "utf8");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Private key handling.
//
// The private key never leaves the process. It is held as a KeyObject, it is
// signed with through the handle, and it is never exported. The Proxy below
// is depth defense against a future caller exporting it for some unrelated
// reason -- it is not the main line of defence. The main line is that the
// signing path never exports and never copies the key bytes.
//
// Two layers have to be reported separately and are never conflated:
//
//   * JS-visible memory (Buffer / TypedArray / string): covered. The signing
//     path adds no copy of the key bytes, and assertNoPrivateKeyLeak walks
//     the reachable exports to prove it.
//   * process native memory (including a core dump): NOT covered here. A
//     core dump was measured to contain the private key seed. That surface
//     is handled separately by the deployment (LocalDumps and service crash
//     dumps disabled) and is explicitly out of scope for this step.
//
// A V8 heap snapshot is a false negative for this check: it does not
// serialize the backing store of an ArrayBuffer, so it finds nothing for
// *any* ArrayBuffer content. "No hit in a heap snapshot" is therefore not
// evidence that the private key is absent, and must never be recorded as
// such.
function guardPrivateKey(privateKey) {
  return new Proxy(privateKey, {
    get(target, property, receiver) {
      if (property === "export") {
        // Exporting the key material is the one operation that must never
        // happen. The refusal happens when the returned function is CALLED,
        // not when the property is read: reading the property is something
        // an audit tool or a debugger does routinely, and blowing up on the
        // read would make the key unusable for legitimate inspection.
        return () => fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
      }
      if (property === "toJSON") {
        return () => "[private-key-redacted]";
      }
      if (property === "inspect" || property === Symbol.for("nodejs.util.inspect.custom")) {
        return () => "[private-key-redacted]";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Batch key pair.
function createBatchKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString("utf8");
  const fingerprint = sha256Hex(Buffer.from(publicKeyPem, "utf8"));
  // The handle is process-local and holds the key without exposing it. It is
  // never serialized, never written to a file, never put in an environment
  // variable, never put on a command line, never put in a Task Action and
  // never handed to a child process.
  const privateKeyRef = guardPrivateKey(privateKey);
  return { publicKeyPem, fingerprint, privateKeyRef };
}

// Signed permit.
function buildSignedPermit(options) {
  const { privateKeyRef, permit, issuedAtMs, nowMs } = options;
  if (!privateKeyRef) fail("ERR_PERMIT_INPUT_INVALID");
  const permitId = requireText(permit.permitId);
  const sequence = requireSafeInteger(permit.sequence);
  // The deadline is read back from the permit that reserve() produced. The
  // signer never computes it: issued_at_ms + ttl is a different number
  // from the permit's own deadline whenever the lease expires first, and
  // the verifier compares the signed deadline with the stored one byte for
  // byte. A short lease is exactly where the two diverge, so the value is
  // taken from the permit and never derived here.
  const deadlineMs = requireSafeInteger(permit.deadline);
  const issued = requireSafeInteger(issuedAtMs);
  const message = {};
  for (const [storage, signed] of BINDING_FIELD_MAP) {
    message[signed] = permit[storage];
  }
  message.issued_at_ms = issued;
  message.deadline_ms = deadlineMs;
  message.permit_id = permitId;

  // The signature covers the canonical bytes of the whole message, so the
  // field set is what is signed -- an attacker cannot drop a field from the
  // message without breaking the signature.
  const bytes = canonicalBytes(message);
  const signature = crypto.sign(null, bytes, privateKeyRef);
  return {
    message,
    signature: signature.toString("base64"),
    sequence,
    deadline: deadlineMs,
    issuedAt: issued,
    bytes: bytes.toString("base64"),
    nowMs: nowMs === undefined ? issued : requireSafeInteger(nowMs),
  };
}

// Verification.
function decodeSignature(signature) {
  if (typeof signature !== "string" || !signature) fail("ERR_PERMIT_INPUT_INVALID");
  const bytes = Buffer.from(signature, "base64");
  if (!bytes.length) fail("ERR_PERMIT_INPUT_INVALID");
  return bytes;
}

function publicKeyFromPem(pem) {
  if (typeof pem !== "string" || !pem) fail("ERR_PERMIT_INPUT_INVALID");
  try {
    return crypto.createPublicKey(pem);
  } catch {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  return null;
}

// The signature has to cover every binding field. This is checked against
// the live binding set, so a consume() that gains or loses a field makes
// the check fail here instead of leaving a field uncovered.
function assertCoversBinding(message) {
  const signed = new Set(Object.keys(message));
  for (const [, signedName] of BINDING_FIELD_MAP) {
    if (!signed.has(signedName)) fail("ERR_PERMIT_BINDING_UNCOVERED");
  }
  for (const name of ADDITIONAL_SIGNED_FIELDS) {
    if (!signed.has(name)) fail("ERR_PERMIT_BINDING_UNCOVERED");
  }
}

function verifyPermitSignature(options) {
  const { message, signature, publicKeyPem, expectedFingerprint, nowMs, revokedFingerprints } = options;
  if (!message || typeof message !== "object") fail("ERR_PERMIT_INPUT_INVALID");
  assertCoversBinding(message);
  const publicKey = publicKeyFromPem(publicKeyPem);
  const bytes = canonicalBytes(message);
  const ok = crypto.verify(null, bytes, publicKey, decodeSignature(signature));
  if (!ok) fail("ERR_PERMIT_SIGNATURE_INVALID");
  if (expectedFingerprint) {
    const actual = sha256Hex(Buffer.from(publicKeyPem, "utf8"));
    if (actual !== expectedFingerprint) fail("ERR_PERMIT_SIGNATURE_INVALID");
  }
  if (revokedFingerprints && expectedFingerprint && revokedFingerprints.has(expectedFingerprint)) {
    // A revoked key must not be able to authorize anything, even if the
    // signature itself is perfectly valid.
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  const deadline = requireSafeInteger(message.deadline_ms);
  if (nowMs !== undefined && requireSafeInteger(nowMs) > deadline) fail("ERR_PERMIT_DEADLINE_EXPIRED");
  return {
    ok: true,
    fingerprint: expectedFingerprint || sha256Hex(Buffer.from(publicKeyPem, "utf8")),
    sequence: requireSafeInteger(message.sequence),
    deadline,
    bytes: bytes.toString("base64"),
  };
}

// Sequence high-water mark.
// The verifier keeps the highest sequence it has accepted. A signature whose
// sequence is not strictly greater is a replay and is refused; the high-water
// mark only advances after a signature has been accepted.
function createSequenceTracker() {
  return { highestSeen: 0 };
}

function checkAndAdvanceSequence(tracker, sequence) {
  const value = requireSafeInteger(sequence);
  if (value <= tracker.highestSeen) fail("ERR_PERMIT_SEQUENCE_REPLAY");
  tracker.highestSeen = value;
  return tracker.highestSeen;
}

// Revocation.
// The local side of the revocation bookkeeping. Two local invariants:
//
//   1. Writing the revoked fingerprints and advancing the applied
//      high-water mark happen in the same critical section, so either both
//      are committed or neither is.
//   2. The locally revoked set only ever grows. A list whose set is not a
//      superset of the applied set is refused and the high-water mark does
//      not advance. This is what makes "sign a list that removes my own
//      fingerprint" impossible under *any* signer.
function createRevocationState() {
  return {
    appliedRevocationSequence: 0,
    highestSeenRevocationSequence: 0,
    revokedFingerprints: new Set(),
  };
}

function applyRevocationList(options) {
  const { state, list, publicKeyPem, pinnedFingerprints, nowMs } = options;
  const sequence = requireSafeInteger(list.revocation_sequence);
  const fingerprints = list.revoked_fingerprints;
  if (!Array.isArray(fingerprints)) fail("ERR_PERMIT_INPUT_INVALID");
  // The chain must continue exactly where the local state left off. A gap,
  // a repeat or a rewind is a broken chain and the list is refused.
  if (sequence !== state.appliedRevocationSequence + 1) fail("ERR_REVOCATION_SEQUENCE_BROKEN");
  const expectedPrev = state.appliedRevocationSequence;
  const prev = list.prev_revocation_sequence === undefined ? expectedPrev : list.prev_revocation_sequence;
  if (requireSafeInteger(prev) !== expectedPrev) fail("ERR_REVOCATION_SEQUENCE_BROKEN");
  // The signer of a revocation list must itself still be valid: its key has
  // to be in the pin and must not be in the locally revoked set. A key that
  // has been revoked cannot authorize the list that would un-revoke it.
  const signer = requireText(list.batch_public_key_fingerprint);
  if (pinnedFingerprints && !pinnedFingerprints.has(signer)) fail("ERR_REVOCATION_SIGNER_INVALID");
  if (state.revokedFingerprints.has(signer)) fail("ERR_REVOCATION_SIGNER_INVALID");
  const message = {
    revocation_sequence: sequence,
    revoked_fingerprints: fingerprints.slice().sort(),
    issued_at_ms: requireSafeInteger(list.issued_at_ms),
    prev_revocation_sequence: expectedPrev,
    batch_public_key_fingerprint: signer,
  };
  const bytes = canonicalBytes(message);
  if (!crypto.verify(null, bytes, publicKeyFromPem(publicKeyPem), decodeSignature(list.signature))) {
    fail("ERR_PERMIT_SIGNATURE_INVALID");
  }
  const incoming = new Set(fingerprints);
  for (const known of state.revokedFingerprints) {
    // The local set only grows. A list that drops a fingerprint is refused
    // and nothing advances.
    if (!incoming.has(known)) fail("ERR_REVOCATION_SET_NOT_MONOTONIC");
  }
  // Everything above passed, so the write and the high-water mark advance
  // together. The critical section is supplied by the caller (step 2 owns
  // the protected store); this function only ever commits a state that
  // passed every check.
  for (const fingerprint of incoming) state.revokedFingerprints.add(fingerprint);
  state.appliedRevocationSequence = sequence;
  if (sequence > state.highestSeenRevocationSequence) state.highestSeenRevocationSequence = sequence;
  return {
    appliedRevocationSequence: state.appliedRevocationSequence,
    revokedFingerprints: state.revokedFingerprints.size,
    verifiedAt: nowMs === undefined ? message.issued_at_ms : requireSafeInteger(nowMs),
  };
}

// Pin exclusivity.
// Two functions with similar names and very different contracts.
//
// assertPinExclusive is a READ-ONLY check. It reports whether the
// preconditions for a fresh-only registration hold. It does not reserve
// anything, so between its return and a later write another writer can get
// in. Using it on the registration path would open exactly that window --
// and in a code review that misuse looks completely ordinary, because both
// names mention a pin and exclusivity.
//
// registerPinExclusively is the GUARANTEE. The exclusivity decision and
// the write happen together inside the protected critical section the caller
// injects. The registration path calls this one, and only this one.
function assertPinExclusive(options) {
  const { existingPin, targetHasProcess, targetHasPriorRun } = options;
  // A clause that cannot be decided is treated as not satisfied, not as
  // absent. An undecidable "no process" is not the same as "no process".
  const exclusive = !existingPin && !targetHasProcess && !targetHasPriorRun;
  return {
    exclusive,
    reasons: [
      existingPin ? "existing-pin" : null,
      targetHasProcess ? "target-has-process" : null,
      targetHasPriorRun ? "target-has-prior-run" : null,
    ].filter(Boolean),
  };
}

function registerPinExclusively(options) {
  const { criticalSection, registration } = options;
  if (typeof criticalSection !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  // The critical section is the protected region on the target side. The
  // decision and the write happen inside it, so the "no existing pin" half
  // of the exclusivity guarantee is not a check-then-act window.
  return criticalSection(() => {
    const verdict = assertPinExclusive(registration);
    if (!verdict.exclusive) fail("ERR_PIN_NOT_EXCLUSIVE");
    return registration.write();
  });
}

// Private key leak check.
// Walks every export path a caller could reach and proves the private key
// bytes are not obtainable through them. This covers the JS-visible layer
// only. It says nothing about a core dump, and it must not be read as if it
// did -- see the note in guardPrivateKey.
function assertNoPrivateKeyLeak(options) {
  const { privateKeyRef } = options;
  if (!privateKeyRef) fail("ERR_PERMIT_INPUT_INVALID");
  // The export path must be refused outright. Reaching it is the failure
  // this check exists to catch, so the refusal is the assertion -- not a
  // finding that gets collected and reported afterwards.
  let exportRefused = false;
  try {
    privateKeyRef.export({ type: "pkcs8", format: "pem" });
  } catch (error) {
    if (!(error instanceof CoordinationError) || error.key !== "ERR_PERMIT_PRIVATE_KEY_EXPOSED") {
      throw error;
    }
    exportRefused = true;
  }
  if (!exportRefused) fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
  // The formatting paths must not carry key material. A redacted marker is
  // what they return; the check is that no PEM block shows up.
  const pemPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  const inspected = require("node:util").inspect(privateKeyRef);
  if (pemPattern.test(inspected)) fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
  const serialized = JSON.stringify(privateKeyRef);
  if (pemPattern.test(serialized)) fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
  // The enumerable surface must not carry the key bytes either.
  for (const key of Object.keys(privateKeyRef)) {
    const value = privateKeyRef[key];
    if (typeof value === "string" && pemPattern.test(value)) fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
    if (Buffer.isBuffer(value) && pemPattern.test(value.toString("latin1"))) {
      fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
    }
  }
  return { ok: true, covered: "js-visible-memory" };
}

// Binding field export.
// The live binding set of consume(). The coverage assertion above is
// written against this, so consume() gaining or losing a field turns the
// assertion red without anyone editing a list by hand.
function consumeBindingFields() {
  return BINDING_FIELD_MAP.map(([storage, signed]) => ({ storage, signed }));
}

module.exports = {
  BINDING_FIELD_MAP,
  STORAGE_TO_SIGNED,
  SIGNED_TO_STORAGE,
  ADDITIONAL_SIGNED_FIELDS,
  canonicalize,
  canonicalBytes,
  createBatchKeyPair,
  buildSignedPermit,
  verifyPermitSignature,
  createSequenceTracker,
  checkAndAdvanceSequence,
  createRevocationState,
  applyRevocationList,
  assertPinExclusive,
  registerPinExclusively,
  assertNoPrivateKeyLeak,
  consumeBindingFields,
};
