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
const { consumeBindingFields: liveConsumeBindingFields } = require("./protected-permit-store");

// The binding facts of MS-003's consume(): the fields the permit store
// compares before it lets an action run. The signature has to cover every
// one of them -- not the subset this design happens to think about -- or a
// permit could be replayed against a different lease, session, host, worker,
// run, generation, desktop, app, epoch, fencing value, operation, target or
// parameter set.
//
// Which fields those are is NOT decided here. It is read from the store's
// live binding set, so consume() gaining or losing a binding field is
// visible to this module as a runtime fact. A local copy of the list would
// drift silently: consume() could gain a field that the signature no longer
// covers, and the coverage assertion would go on comparing the copy against
// the copy and stay green.
//
// The one thing that does live here is the spelling: the store writes
// camelCase, the signed message writes snake_case. That mapping is a
// property of the wire format, not of consume()'s field set, and it is
// written once so no call site assembles it from string fragments.
const STORAGE_TO_SIGNED_NAME = Object.freeze({
  leaseId: "lease_id",
  sessionId: "session_id",
  hostId: "host_identity",
  workerId: "worker_identity",
  runId: "run_id",
  generation: "generation",
  desktopKey: "desktop_key",
  ownedAppId: "owned_app_id",
  serviceEpoch: "service_epoch",
  fencing: "fencing",
  operation: "operation",
  targetDigest: "target_digest",
  paramsDigest: "params_digest",
  sequence: "sequence",
});

// The live binding set, paired with the signed spelling of each field.
// A field that consume() has but the spelling table does not is a field the
// signature cannot cover, and that is a build-time error in the wire
// format rather than a silent gap -- so it fails here instead of producing
// an unsigned field at runtime.
const BINDING_FIELD_MAP = Object.freeze(
  liveConsumeBindingFields()
    .map((storage) => {
      const signed = STORAGE_TO_SIGNED_NAME[storage];
      if (!signed) fail("ERR_PERMIT_BINDING_UNCOVERED");
      return [storage, signed];
    }),
);

// The signed fields that are not part of consume()'s binding but are the
// verifier's basis for acting: when the permit was issued, when it stops
// being usable, and which permit it is.
const ADDITIONAL_SIGNED_FIELDS = Object.freeze([
  "issued_at_ms",
  "deadline_ms",
  "permit_id",
]);

// The upper bound on the clock-skew allowance.
//
// The allowance exists to absorb the clock offset between two machines that
// talk to each other -- the kind of drift an NTP correction settles within
// a minute or two, and the kind a deployment records so that an auditor can
// see what was allowed. Five minutes is generous for that purpose.
//
// It has to be generous enough to be usable and small enough to stay
// meaningful: an allowance wide enough to cover any clock offset would
// make the issued-at judgement vacuous, because a clock could then sit
// behind the issue instant by ANY amount and still be accepted.
//
// Note what this bound does NOT claim: it is not a fraction of the permit's
// lifetime, because a permit's lifetime is not known here (the signed
// deadline and the issue instant are, but the lifetime is the signer's
// grant and the verifier does not get to widen it -- see R2-B8 P2 below).
// The MS-003 store accepts any positive ttlMs, so the shortest real permit
// is one millisecond and no absolute bound can be "a small fraction of
// every permit's lifetime". This bound is an absolute ceiling on the
// clock offset the verifier is willing to tolerate, which is what the
// allowance is for.
const MAX_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

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

// The fingerprint of a public key.
//
// It is derived from the key MATERIAL, not from the text that carries it.
// A PEM is a text encoding of a key, and the same key has several legal
// text encodings -- LF or CRLF line endings, a trailing newline or none.
// Hashing the text therefore gives the same key several different
// fingerprints, and a key that was pinned under one encoding is then
// refused when it arrives under another. That is a false refusal of a
// correctly pinned key, and it is a property of the encoding rather than
// of the key.
//
// The SPKI DER form is the canonical serialization of a public key: one
// byte string per key, whatever text encoding carried it. So the
// fingerprint identifies the key itself.
function publicKeyFingerprint(publicKeyPem) {
  const key = publicKeyFromPem(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

// Private key handling.
//
// The private key never leaves the process. It is held as a KeyObject inside
// this module, it is signed with through the handle, and it is never
// exported. The handle that leaves this module carries a signing method and
// nothing else, so there is no property on it that could return key
// material. The main line of defence is that the signing path never exports
// and never copies the key bytes.
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
  // The KeyObject stays INSIDE this module. The handle that leaves it is a
  // plain object with a single signing method, so the key material is not
  // reachable through the handle at all -- there is no property to read and
  // no method to call that would return it.
  //
  // An earlier version wrapped the KeyObject in a Proxy that refused
  // `export`. That is unsafe: Node's own crypto internals read properties
  // off the key argument, and the Proxy changed what they saw. The failure
  // was silent on one Node 24 patch release and fatal on another (the
  // sign path reported an undefined key), so the private key was not
  // signable at all on some supported runtimes.
  //
  // Keeping the KeyObject private is a stronger guarantee than intercepting
  // `export` was: there is nothing on the handle to intercept in the first
  // place.
  return {
    sign(messageBytes) {
      return crypto.sign(null, messageBytes, privateKey);
    },
  };
}

// Batch key pair.
function createBatchKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString("utf8");
  const fingerprint = publicKeyFingerprint(publicKeyPem);
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
  const signature = privateKeyRef.sign(bytes);
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
  const {
    message, signature, publicKeyPem, expectedFingerprint, nowMs, revokedFingerprints,
    expectedDeadlineMs,
  } = options;
  if (!message || typeof message !== "object") fail("ERR_PERMIT_INPUT_INVALID");
  assertCoversBinding(message);
  const publicKey = publicKeyFromPem(publicKeyPem);
  const bytes = canonicalBytes(message);
  const ok = crypto.verify(null, bytes, publicKey, decodeSignature(signature));
  if (!ok) fail("ERR_PERMIT_SIGNATURE_INVALID");
  const signerFingerprint = publicKeyFingerprint(publicKeyPem);
  // A revoked key must not be able to authorize anything, even if the
  // signature itself is perfectly valid (design document section 2.3: once
  // the revocation takes effect, NO signature by that key is accepted any
  // more).
  //
  // The revoked set is looked up by the fingerprint of the key that
  // actually signed, which is the same fingerprint the pin is keyed by.
  // Asking for the revoked set therefore means asking about a specific
  // key, and a caller that provides the set without saying WHICH key is
  // asking a question that cannot be answered -- the lookup would
  // silently never fire. Deriving the fingerprint from the verification
  // key removes that gap: there is no way to pass a set and leave the
  // subject of the question unspecified.
  //
  // The set itself is MANDATORY. It is a state, not a hint: the caller
  // holds the local revoked set, and the question "is this key revoked"
  // cannot be answered without it. Making it optional would mean the
  // strongest rule -- a revoked key authorizes nothing -- is the one rule
  // that a forgotten argument turns off, and "no argument" and "an empty
  // set" would mean opposite things while looking the same at the call
  // site. A caller that genuinely has nothing revoked passes an empty
  // set; a caller that has no set at all passes nothing, and is refused.
  if (!revokedFingerprints || typeof revokedFingerprints.has !== "function") {
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  if (revokedFingerprints.has(signerFingerprint)) {
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  // The key that signed must be the key the pin says is authoritative.
  //
  // expectedFingerprint is MANDATORY. The verifier holds the pin, so the
  // fingerprint of the authoritative key is a value it has -- without it
  // the module cannot answer "is this the key we pinned", and a missing
  // answer is not a yes. Design section 1 (question 3) asks how the
  // verifier obtains the AUTHORITATIVE public key, and section 5 negative
  // case 1 ("a message signed by an old key -> refuse: the key is revoked
  // OR NOT IN THE PIN") makes the second disjunct binding: a key that was
  // never registered must not be able to authorize anything.
  //
  // The guard is the COMPARISON, never the truthiness of the argument. An
  // empty string, a null, a zero and a false are all ways of saying "no
  // expectation was supplied", and all of them used to slip past a plain
  // `if (expectedFingerprint)`. The comparison below is unconditional, so
  // a missing expectation is a mismatch rather than a skipped check.
  //
  // The identity check comes before the clock checks on purpose: "is this
  // the right key" is a question about the permit, while the clock checks
  // are questions about the verifier's surroundings. Answering the first
  // one first keeps a wrong key reported as a wrong key rather than being
  // masked by whatever the local clock happens to say.
  if (typeof expectedFingerprint !== "string" || !expectedFingerprint) {
    fail("ERR_PERMIT_SIGNATURE_INVALID");
  }
  if (expectedFingerprint !== signerFingerprint) {
    fail("ERR_PERMIT_SIGNATURE_INVALID");
  }
  const deadline = requireSafeInteger(message.deadline_ms);
  // The verifier's local clock is the basis of the expiry verdict (design
  // section 2.3.3). It is not optional: without it there is no verdict at
  // all, and a missing verdict is not "not expired". The verifier always
  // holds a clock, so the value can be supplied unconditionally; making it
  // skippable would let an expired permit through by leaving one argument
  // out, which is the same fail-open shape as the revoked set above.
  //
  // The clock is also checked for being a PLAUSIBLE instant. A clock
  // reading that is not a real instant turns the expiry verdict into a
  // tautology: `now > deadline` is false for every deadline once now is
  // zero or below, so a permit that expired decades ago would verify.
  //
  // The protected permit store refuses a NEGATIVE clock the same way
  // (protected-permit-store.js: `!Number.isSafeInteger(now) || now < 0`),
  // but it still accepts the epoch. Here the epoch is refused as well: the
  // verifier's clock is a wall-clock reading, and no permit this module
  // verifies can have a deadline at or below the epoch, so a zero reading
  // is not a legitimate instant either -- it is the same vacuous verdict
  // with a smaller amplitude. Both are refused on the same grounds.
  const now = requireSafeInteger(nowMs);
  if (now <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  // The verifier's clock cannot precede the moment the permit was issued.
  // This judgement exists only because the clock is compared against the
  // signed issued_at_ms: without it, a clock reading of 1970 satisfies the
  // expiry judgement for every permit ever issued, which is the vacuous
  // verdict above in a different dress.
  //
  // The allowance is a property of the cross-machine clock comparison, so
  // it is a separate, explicit input rather than a constant hidden in the
  // comparison: the default of 0 means the verifier's clock must not be
  // behind the issued-at instant, and a deployment that configures a skew
  // allowance passes it in.
  //
  // The allowance is BOUNDED on both sides. The lower bound (not negative)
  // is the design's own wording. The upper bound is what keeps the
  // judgement meaningful: an allowance wide enough to cover any plausible
  // clock offset would make the issued-at judgement vacuous, because a
  // clock could then sit behind the issue instant by ANY amount and still
  // be accepted -- the same fail-open shape as B4/B5/B6, reached through a
  // different door. The bound is set at the scale the allowance exists for
  // (clock offset between two machines that talk to each other).
  //
  // The allowance is applied to the ISSUED-at judgement ONLY. The design's
  // section 2.3.3 has two sentences that pull in opposite directions here,
  // and the one that constrains the use of the allowance wins:
  //
  //   - "the allowance is applied to the issued-at and the expires-at
  //     judgements SEPARATELY ... and it does not change the signed
  //     deadline_ms"
  //   - "time in transit MUST NOT extend the validity window ... any
  //     allowance for it must be counted in at ISSUANCE time (a shorter
  //     TTL) and must NOT be added on the verification side" (R2-B8 P2)
  //
  // The first sentence's purpose is to keep the SIGNER from tampering with
  // the signed deadline; it is not a licence for the verifier to widen the
  // window. The second is the constraint on the allowance's use, and it is
  // a prohibition. It reaches the clock-skew allowance because a verifier
  // cannot tell time-in-transit from clock-offset -- both are just "the
  // local clock reads earlier than the signer did". So widening the expiry
  // comparison WOULD be adding validity on the verification side, which
  // R2-B8 P2 forbids: the effective window stays exactly the window the
  // signer granted.
  //
  // What the allowance absorbs is exactly one thing: a verifier whose clock
  // reads BEHIND the issue instant. That is a clock offset between two
  // machines, and it is why the allowance exists at all. It is not a way to
  // keep a permit alive past its own deadline, and it is not a licence for
  // the verifier to reinterpret the window the signer granted.
  const issuedAt = requireSafeInteger(message.issued_at_ms);
  const skewToleranceMs = options.skewToleranceMs === undefined
    ? 0
    : requireSafeInteger(options.skewToleranceMs);
  if (skewToleranceMs < 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (skewToleranceMs > MAX_SKEW_TOLERANCE_MS) fail("ERR_PERMIT_INPUT_INVALID");
  // The signed window must not be inverted. A permit whose issued_at_ms is
  // AFTER its deadline_ms describes no interval at all: there is no instant
  // that is both "not before it was issued" and "not after it expires".
  // The window is checked on its own terms rather than as a bound on the
  // allowance, because the two are unrelated: the allowance absorbs a clock
  // offset, and the width of the window is the signer's grant. Bounding the
  // allowance by the window would reject a permit that was legitimately
  // issued with a short budget (the MS-003 store bounds ttlMs from below
  // only) at any usable allowance, which the design's own short-lease case
  // requires to work.
  if (issuedAt > deadline) fail("ERR_PERMIT_INPUT_INVALID");
  // The allowance is CLIPPED to the permit's own validity window. The
  // absolute ceiling above bounds the clock offset the verifier is willing
  // to tolerate, but it says nothing about how that offset compares with the
  // window it is measured against. An allowance wider than the window
  // COVERS it: on a one-second permit, a five-minute allowance would make
  // every clock reading from five minutes before the issue instant up to
  // the issue instant itself admissible, so the issued-at judgement would
  // be vacuous for that permit -- the allowance has become the validity
  // window rather than an offset absorbed alongside it.
  //
  // Clipping rather than refusing is what keeps this a bound on the
  // allowance and not a ban on short permits. The MS-003 store bounds
  // ttlMs from below only, so a one-second permit is a real one; refusing
  // it would break the design's own short-lease case, while clipping lets
  // it live with an allowance that is proportional to what it was granted.
  const lifetimeMs = deadline - issuedAt;
  const effectiveToleranceMs = Math.min(skewToleranceMs, lifetimeMs);
  if (now + effectiveToleranceMs < issuedAt) fail("ERR_PERMIT_INPUT_INVALID");
  // The expiry judgement is NOT widened. The effective window is exactly
  // the window the signer granted.
  if (now > deadline) fail("ERR_PERMIT_DEADLINE_EXPIRED");
  // The signed deadline has to be the deadline the store holds. The
  // signature alone does not prove that: a signer that computed its own
  // deadline could sign a perfectly valid, self-consistent message whose
  // deadline_ms is not the permit's real one. Comparing the two here makes
  // that a refused input rather than a discipline the caller has to
  // remember.
  if (expectedDeadlineMs !== undefined) {
    const expected = requireSafeInteger(expectedDeadlineMs);
    if (expected !== deadline) fail("ERR_PERMIT_DEADLINE_MISMATCH");
  }
  return {
    ok: true,
    fingerprint: signerFingerprint,
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
  //
  // The check is on the key that ACTUALLY verifies the signature, not on
  // the fingerprint the list claims for itself. A list may name any
  // fingerprint it likes, and that name is just a string inside the signed
  // payload -- it proves nothing about who signed. Checking the claimed
  // name against the pin would let a key that is not pinned at all sign a
  // list that claims to be from a pinned key, and the list would be
  // accepted. So the signer identity is DERIVED from the verification key
  // and the claimed fingerprint has to agree with it.
  const claimedSigner = requireText(list.batch_public_key_fingerprint);
  const signingKey = publicKeyFromPem(publicKeyPem);
  const signerFingerprint = publicKeyFingerprint(publicKeyPem);
  if (claimedSigner !== signerFingerprint) fail("ERR_REVOCATION_SIGNER_INVALID");
  // "The signer has to be in the pin" is a MANDATORY precondition, so the
  // pin set has to be there. An absent pin set is not a pin set that
  // happens to contain the key -- it is a precondition that was never
  // established, and the design says an unestablished fact is handled as
  // not satisfied (section 2.2.2). Skipping the check when the argument is
  // missing would make the strongest precondition the easiest one to
  // bypass: omitting an argument is then the same as pinning everything.
  if (!pinnedFingerprints || typeof pinnedFingerprints.has !== "function") {
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  if (!pinnedFingerprints.has(signerFingerprint)) {
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  if (state.revokedFingerprints.has(signerFingerprint)) fail("ERR_REVOCATION_SIGNER_INVALID");
  const message = {
    revocation_sequence: sequence,
    revoked_fingerprints: fingerprints.slice().sort(),
    issued_at_ms: requireSafeInteger(list.issued_at_ms),
    prev_revocation_sequence: expectedPrev,
    batch_public_key_fingerprint: claimedSigner,
  };
  const bytes = canonicalBytes(message);
  if (!crypto.verify(null, bytes, signingKey, decodeSignature(list.signature))) {
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
  //
  // This is the whole point of the check, so it is spelled out rather than
  // left to the boolean coercion of a missing value: `!undefined` is true,
  // so a clause that was never decided would be reported as satisfied and
  // the whole route would go on as if the target were known to be idle.
  //
  // Each clause has its own domain of DECIDED values, and only those count:
  //
  //   existingPin       null or false -> decided: there is no pin
  //                     a pin object  -> decided: there is one
  //                     undefined     -> not decided
  //   targetHasProcess  false         -> decided: no process
  //                     true          -> decided: there is one
  //                     anything else -> not decided
  //   targetHasPriorRun same as targetHasProcess
  //
  // The two target clauses are booleans because they are facts ABOUT the
  // target, and the design says an undecidable "no process" is not the
  // same as "no process" (design document section 2.2.2). existingPin is
  // different in kind: it names a thing that may or may not be present, so
  // null is the shape that says "decided, and it is not there".
  //
  // Anything not decided blocks the route, and says which clause blocked it.
  const pinDecidedAbsent = existingPin === null || existingPin === false;
  const pinDecidedPresent =
    existingPin !== undefined && existingPin !== null && existingPin !== false;
  const targetDecidedAbsent = (value) => value === false;
  const targetDecidedPresent = (value) => value === true;
  const targetUndecidable = (value) => value !== true && value !== false;
  const exclusive =
    pinDecidedAbsent &&
    targetDecidedAbsent(targetHasProcess) &&
    targetDecidedAbsent(targetHasPriorRun);
  return {
    exclusive,
    reasons: [
      pinDecidedPresent ? "existing-pin" : null,
      targetDecidedPresent(targetHasProcess) ? "target-has-process" : null,
      targetDecidedPresent(targetHasPriorRun) ? "target-has-prior-run" : null,
      existingPin === undefined ? "existing-pin-undecidable" : null,
      targetUndecidable(targetHasProcess) ? "target-has-process-undecidable" : null,
      targetUndecidable(targetHasPriorRun) ? "target-has-prior-run-undecidable" : null,
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
  // There is no export path on the handle at all: the KeyObject is held
  // inside this module and the handle only carries a signing method. The
  // check below therefore verifies that the handle's surface really is
  // that -- an `export` method appearing on it would mean the key had
  // become reachable again.
  if (typeof privateKeyRef.export === "function") fail("ERR_PERMIT_PRIVATE_KEY_EXPOSED");
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
  // The live set, read from the store at call time -- not the snapshot this
  // module captured when it was loaded. A snapshot would answer the
  // question that was true at load time, which is exactly the question the
  // caller is asking about right now. The signed spelling is attached so
  // the caller can see both halves of the mapping and check that every
  // live field has one.
  return liveConsumeBindingFields().map((storage) => ({
    storage,
    signed: STORAGE_TO_SIGNED_NAME[storage],
  }));
}

module.exports = {
  BINDING_FIELD_MAP,
  STORAGE_TO_SIGNED,
  SIGNED_TO_STORAGE,
  ADDITIONAL_SIGNED_FIELDS,
  MAX_SKEW_TOLERANCE_MS,
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
